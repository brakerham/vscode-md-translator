/**
 * One translation preview panel per Markdown document. Reuses a single
 * webview, listens to document/configuration changes, and orchestrates the
 * extract → translate → backfill → render pipeline.
 */
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { CONFIG_KEYS, CONFIG_SECTION, PREVIEW_VIEW_TYPE } from '../common/constants';
import { UserError, errorMessage } from '../common/errors';
import type {
  Logger,
  PreviewHostMessage,
  TranslationMode,
  TranslationState,
} from '../common/types';
import type { ConfigProvider } from '../config/configuration';
import { MarkdownDocument, MarkdownPipeline } from '../markdown/pipeline';
import { buildPreviewHtml } from './htmlTemplate';
import { WebviewMessageRouter } from './router';
import { DocumentStatusEvent, StatusCenter } from './statusCenter';
import { TranslationError, TranslationCache } from '../translation/types';
import { TranslationService } from '../translation/service';
import { debounce, Debounced } from '../utils/debounce';

export interface PreviewPanelDeps {
  context: vscode.ExtensionContext;
  document: vscode.TextDocument;
  pipeline: MarkdownPipeline;
  service: TranslationService;
  configProvider: ConfigProvider;
  cache: TranslationCache;
  statusCenter: StatusCenter;
  logger: Logger;
  column?: vscode.ViewColumn;
}

interface StatusPayload {
  state: TranslationState;
  done: number;
  total: number;
  message?: string;
}

const EXTERNAL_IMAGE_RE = /^(https?:|data:|file:|#|\/\/|mailto:)/i;

export class TranslationPreviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly router: WebviewMessageRouter;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidDisposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.onDidDisposeEmitter.event;

  private mdDoc: MarkdownDocument | null = null;
  private mode: TranslationMode;
  private hasApiKey = false;
  private initSent = false;
  private runId = 0;
  private abortController: AbortController | null = null;
  private dirtyWhileHidden = false;
  private translatedBlocks: number[] = [];
  private readonly refreshDebounced: Debounced<[boolean]>;

  constructor(private readonly deps: PreviewPanelDeps) {
    this.mode = deps.configProvider.read().translationMode;

    this.panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      `AI Translation — ${basename(deps.document.uri)}`,
      { viewColumn: deps.column ?? vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.computeResourceRoots(),
      },
    );

    this.panel.webview.html = buildPreviewHtml(this.buildHtmlParts());

    this.router = new WebviewMessageRouter({
      logger: deps.logger,
      translateAll: () => {
        void this.refresh(false);
      },
      retranslate: () => {
        void this.refresh(true);
      },
      cancel: () => this.cancel(),
      setMode: (mode) => {
        this.mode = mode;
      },
      translateSelection: (text) => this.translateSelection(text),
      openLink: (href) => {
        void this.openLink(href);
      },
    });

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'ready') {
          void this.onWebviewReady();
          return;
        }
        void this.router.handle(msg, (reply) => {
          void this.panel.webview.postMessage(reply);
        });
      },
      undefined,
      this.disposables,
    );

    this.refreshDebounced = debounce((force: boolean) => {
      void this.refresh(force);
    }, 800);

    this.disposables.push(
      this.panel,
      this.panel.onDidDispose(() => this.cleanup()),
      this.panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible && this.dirtyWhileHidden) {
          this.dirtyWhileHidden = false;
          this.refreshDebounced.cancel();
          void this.refresh(false);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === deps.document.uri.toString()) {
          if (this.panel.visible) {
            this.refreshDebounced(false);
          } else {
            this.dirtyWhileHidden = true;
          }
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEYS.translationMode}`)) {
          this.mode = deps.configProvider.read().translationMode;
          void this.pushConfig();
        }
      }),
      deps.configProvider.onDidChangeSecrets(() => {
        void this.pushConfig();
      }),
    );
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, false);
  }

  /** Re-runs extraction + translation. `force` skips the cache. */
  async refresh(force: boolean): Promise<void> {
    this.runId++;
    const runId = this.runId;
    this.abortController?.abort();
    const abort = new AbortController();
    this.abortController = abort;

    const text = this.deps.document.getText();
    this.publishStatus({ state: 'extracting', done: 0, total: 0 });

    let mdDoc: MarkdownDocument;
    try {
      mdDoc = this.deps.pipeline.parse(text);
    } catch (err) {
      this.deps.logger.error(`Markdown parse failed: ${errorMessage(err)}`);
      this.publishStatus({ state: 'error', done: 0, total: 0, message: 'Failed to parse the Markdown document.' });
      return;
    }
    this.mdDoc = mdDoc;

    let segments;
    try {
      segments = mdDoc.extractSegments().segments;
    } catch (err) {
      this.deps.logger.error(`Segment extraction failed: ${errorMessage(err)}`);
      this.publishStatus({ state: 'error', done: 0, total: 0, message: 'Failed to extract translatable text.' });
      return;
    }

    const sourceHtml = this.renderHtml(mdDoc, 'src');

    if (segments.length === 0) {
      this.translatedBlocks = [];
      await this.post({ type: 'updateHtml', sourceHtml, translatedHtml: sourceHtml, translatedBlocks: [] });
      this.publishStatus({ state: 'done', done: 0, total: 0 });
      return;
    }

    const config = this.deps.configProvider.read();
    const opts = this.deps.configProvider.toTranslateOptions(config, {
      cache: this.deps.cache,
      forceRefresh: force,
      signal: abort.signal,
      onProgress: (done, total) => {
        if (runId !== this.runId) return;
        this.publishStatus({ state: 'translating', done, total });
      },
    });

    try {
      const map = await this.deps.service.translateSegments(segments, opts);
      if (runId !== this.runId || abort.signal.aborted) return;
      mdDoc.applyTranslations(map);
      this.publishStatus({ state: 'rendering', done: map.size, total: segments.length });
      const translatedHtml = this.renderHtml(mdDoc, 'trans');
      this.translatedBlocks = mdDoc.translatedBlocks;
      await this.post({
        type: 'updateHtml',
        sourceHtml,
        translatedHtml,
        translatedBlocks: this.translatedBlocks,
      });
      this.publishStatus({ state: 'done', done: segments.length, total: segments.length });
    } catch (err) {
      if (runId !== this.runId) return;
      if (err instanceof TranslationError && err.kind === 'aborted') {
        this.publishStatus({ state: 'cancelled', done: 0, total: segments.length });
        return;
      }
      const message = this.userMessageFor(err);
      this.deps.logger.error(`Document translation failed: ${message}`);
      // Show the fresh source; drop stale pairings so bilingual mode stays consistent.
      this.translatedBlocks = [];
      await this.post({ type: 'updateHtml', sourceHtml, translatedHtml: sourceHtml, translatedBlocks: [] });
      this.publishStatus({ state: 'error', done: 0, total: segments.length, message });
    }
  }

  cancel(): void {
    this.runId++;
    this.abortController?.abort();
    this.abortController = null;
  }

  dispose(): void {
    this.cleanup();
  }

  /* ------------------------------------------------------------------ */

  private async onWebviewReady(): Promise<void> {
    if (this.initSent) return;
    this.initSent = true;
    this.hasApiKey = await this.deps.configProvider.hasApiKey();

    let sourceHtml = '';
    try {
      this.mdDoc = this.deps.pipeline.parse(this.deps.document.getText());
      sourceHtml = this.renderHtml(this.mdDoc, 'src');
    } catch (err) {
      this.deps.logger.error(`Initial parse failed: ${errorMessage(err)}`);
    }

    const config = this.deps.configProvider.read();
    await this.post({
      type: 'init',
      documentTitle: basename(this.deps.document.uri),
      sourceHtml,
      translatedHtml: null,
      translatedBlocks: [],
      mode: this.mode,
      vscodeLanguage: vscode.env.language,
      hasApiKey: this.hasApiKey,
      targetLanguage: config.targetLanguage,
      mermaidScriptUri: this.mermaidScriptUri(),
    });

    // First open: translate right away (cache makes this cheap for unchanged text).
    void this.refresh(false);
  }

  private async pushConfig(): Promise<void> {
    this.hasApiKey = await this.deps.configProvider.hasApiKey();
    await this.post({ type: 'config', hasApiKey: this.hasApiKey, mode: this.mode });
  }

  private async translateSelection(text: string): Promise<string> {
    const config = this.deps.configProvider.read();
    if (!(await this.deps.configProvider.getApiKey())) {
      throw new UserError('No API key configured. Run the "Markdown AI Translator: Set API Key" command first.');
    }
    const opts = this.deps.configProvider.toTranslateOptions(config, { cache: this.deps.cache });
    const translated = await this.deps.service.translateText(text, opts);
    this.deps.statusCenter.publishSelection({ source: text, translation: translated });
    return translated;
  }

  private async openLink(href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (href.startsWith('#')) return;
    const target = this.resolveLocalUri(href);
    if (!target) {
      void vscode.window.showWarningMessage(`Markdown AI Translator: cannot open link "${href}".`);
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(target);
      if (stat.type === vscode.FileType.File) {
        await vscode.commands.executeCommand('vscode.open', target);
        return;
      }
    } catch {
      /* fall through */
    }
    void vscode.window.showWarningMessage(`Markdown AI Translator: cannot open link "${href}".`);
  }

  private resolveLocalUri(href: string): vscode.Uri | undefined {
    let p = href.split(/[?#]/)[0];
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep raw */
    }
    try {
      return vscode.Uri.joinPath(this.deps.document.uri, '..', p);
    } catch {
      return undefined;
    }
  }

  private renderHtml(mdDoc: MarkdownDocument, version: 'src' | 'trans'): string {
    return mdDoc.render({
      version,
      resolveImageSrc: (src) => {
        if (EXTERNAL_IMAGE_RE.test(src)) return src;
        const uri = this.resolveLocalUri(src);
        if (!uri) return src;
        try {
          return this.panel.webview.asWebviewUri(uri).toString();
        } catch {
          return src;
        }
      },
    });
  }

  private publishStatus(status: StatusPayload): void {
    const event: DocumentStatusEvent = {
      uri: this.deps.document.uri.toString(),
      docTitle: basename(this.deps.document.uri),
      ...status,
    };
    this.deps.statusCenter.publishDocumentStatus(event);
    void this.post({ type: 'status', ...status });
  }

  private async post(msg: PreviewHostMessage): Promise<void> {
    try {
      await this.panel.webview.postMessage(msg);
    } catch {
      /* panel disposed concurrently */
    }
  }

  private userMessageFor(err: unknown): string {
    if (err instanceof UserError) return err.message;
    if (err instanceof TranslationError) {
      switch (err.kind) {
        case 'auth':
          return 'API key invalid or unauthorized. Run "Set API Key" and check your key.';
        case 'rate-limited':
          return 'Rate limited by the API provider. Try again in a moment.';
        case 'config':
          return `API configuration problem: ${err.message}`;
        case 'network':
          return `Network error: ${err.message}`;
        case 'invalid-response':
          return `The model returned an invalid response: ${err.message}`;
        default:
          return err.message;
      }
    }
    return errorMessage(err);
  }

  private computeResourceRoots(): vscode.Uri[] {
    const roots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'media'),
      vscode.Uri.joinPath(this.deps.document.uri, '..'),
    ];
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      if (!roots.some((r) => r.toString() === f.uri.toString())) roots.push(f.uri);
    }
    return roots;
  }

  private buildHtmlParts(): {
    nonce: string;
    cspSource: string;
    mainScriptUri: string;
    previewCssUri: string;
    codiconCssUri: string;
    katexCssUri: string;
  } {
    const wv = this.panel.webview;
    const media = vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'media');
    return {
      nonce: crypto.randomBytes(16).toString('base64'),
      cspSource: wv.cspSource,
      mainScriptUri: wv.asWebviewUri(vscode.Uri.joinPath(media, 'main.js')).toString(),
      previewCssUri: wv.asWebviewUri(vscode.Uri.joinPath(media, 'preview.css')).toString(),
      codiconCssUri: wv.asWebviewUri(vscode.Uri.joinPath(media, 'codicons', 'codicon.css')).toString(),
      katexCssUri: wv.asWebviewUri(vscode.Uri.joinPath(media, 'katex', 'katex.min.css')).toString(),
    };
  }

  private mermaidScriptUri(): string {
    try {
      const media = vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'media');
      return this.panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'mermaid.js')).toString();
    } catch {
      return '';
    }
  }

  private cleanup(): void {
    this.runId++;
    this.abortController?.abort();
    this.abortController = null;
    this.refreshDebounced.cancel();
    this.deps.statusCenter.publishDocumentStatus({
      uri: this.deps.document.uri.toString(),
      docTitle: basename(this.deps.document.uri),
      state: 'idle',
      done: 0,
      total: 0,
    });
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.onDidDisposeEmitter.fire();
    this.onDidDisposeEmitter.dispose();
  }
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split(/[\\/]/);
  return parts[parts.length - 1] || 'document';
}
