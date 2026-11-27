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
  force?: boolean;
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

  private mode: TranslationMode;
  private document: vscode.TextDocument;
  private hasApiKey = false;
  private initSent = false;
  private ready = false;
  private disposed = false;
  private pendingForce: boolean;
  private selectionAbort: AbortController | undefined;
  private runId = 0;
  private abortController: AbortController | null = null;
  private dirtyWhileHidden = false;
  private translatedBlocks: number[] = [];
  private readonly refreshDebounced: Debounced<[boolean]>;

  constructor(private readonly deps: PreviewPanelDeps) {
    this.document = deps.document;
    this.mode = deps.configProvider.read().translationMode;
    this.pendingForce = deps.force ?? false;

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
      translateAll: () => this.refresh(false),
      retranslate: () => this.refresh(true),
      cancel: () => this.cancel(),
      setMode: (mode) => {
        this.mode = mode;
      },
      translateSelection: (text) => this.translateSelection(text),
      openLink: (href) => this.openLink(href),
    });

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'ready') {
          void this.onWebviewReady();
          return;
        }
        void this.router.handle(msg, (reply) => {
          void this.post(reply);
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
        if (e.document.uri.toString() === this.document.uri.toString()) {
          this.document = e.document;
          this.abortController?.abort();
          this.runId++;
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
    this.pendingForce = deps.force ?? false;
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

  reveal(document: vscode.TextDocument): void {
    const replaced = this.document !== document;
    this.document = document;
    this.panel.reveal(this.panel.viewColumn, false);
    if (replaced) this.refreshDebounced(false);
  }

  /** Re-runs extraction + translation. `force` skips the cache. */
  async refresh(force: boolean): Promise<void> {
    if (this.disposed) return;
    if (!this.ready) {
      this.pendingForce ||= force;
      return;
    }
    this.refreshDebounced.cancel();
    this.dirtyWhileHidden = false;
    const runId = ++this.runId;
    this.abortController?.abort();
    const abort = new AbortController();
    this.abortController = abort;

    const text = this.document.getText();
    this.publishStatus({ state: 'extracting', done: 0, total: 0 });

    try {
      await this.runTranslation(text, force, runId, abort);
    } catch {
      if (runId === this.runId) {
        this.publishStatus({ state: 'error', done: 0, total: 0, message: 'Failed to render the Markdown document.' });
      }
    } finally {
      if (runId === this.runId) this.abortController = null;
    }
  }

  private async runTranslation(text: string, force: boolean, runId: number, abort: AbortController): Promise<void> {
    let mdDoc: MarkdownDocument;
    try {
      mdDoc = this.deps.pipeline.parse(text);
    } catch (err) {
      this.deps.logger.error(`Markdown parse failed: ${errorMessage(err)}`);
      this.publishStatus({ state: 'error', done: 0, total: 0, message: 'Failed to parse the Markdown document.' });
      return;
    }

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
      if (runId !== this.runId) return;
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
      if (runId !== this.runId) return;
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
      if (runId === this.runId) this.publishStatus({ state: 'error', done: 0, total: segments.length, message });
    }
  }

  cancel(): void {
    this.runId++;
    this.refreshDebounced.cancel();
    this.pendingForce = false;
    this.dirtyWhileHidden = false;
    this.abortController?.abort();
    this.abortController = null;
    this.publishStatus({ state: 'cancelled', done: 0, total: 0 });
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
      const doc = this.deps.pipeline.parse(this.document.getText());
      sourceHtml = this.renderHtml(doc, 'src');
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

    if (this.disposed) return;
    this.ready = true;
    void this.refresh(this.pendingForce);
  }

  private async pushConfig(): Promise<void> {
    this.hasApiKey = await this.deps.configProvider.hasApiKey();
    await this.post({ type: 'config', hasApiKey: this.hasApiKey, mode: this.mode });
  }

  private async translateSelection(text: string): Promise<string> {
    const config = this.deps.configProvider.read();
    if (!(await this.deps.configProvider.hasApiKey())) {
      throw new UserError('No API key configured. Run the "Markdown AI Translator: Set API Key" command first.');
    }
    if (this.disposed) throw new UserError('Preview closed.');
    this.selectionAbort?.abort();
    const abort = new AbortController();
    this.selectionAbort = abort;
    const opts = this.deps.configProvider.toTranslateOptions(config, { cache: this.deps.cache, signal: abort.signal });
    try {
      const translated = await this.deps.service.translateText(text, opts);
      if (!abort.signal.aborted) this.deps.statusCenter.publishSelection({ source: text, translation: translated });
      return translated;
    } finally {
      if (this.selectionAbort === abort) this.selectionAbort = undefined;
    }
  }

  private async openLink(href: string): Promise<void> {
    if (href.trimStart() !== href || [...href].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return;
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^(?:[#/\\]|[a-z][a-z\d+.-]*:)/i.test(href)) return;
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
    if (/^(?:[/\\]|[a-z][a-z\d+.-]*:)/i.test(p) || p.includes('\\')) return undefined;
    try {
      const target = vscode.Uri.joinPath(this.deps.document.uri, '..', p);
      const normalize = (path: string): string => target.scheme === 'file' && process.platform === 'win32' ? path.toLowerCase() : path;
      const path = normalize(target.path);
      return this.computeResourceRoots().some((root) =>
        root.scheme === target.scheme && root.authority === target.authority &&
        path.startsWith(normalize(root.path).replace(/\/$/, '') + '/'),
      ) ? target : undefined;
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
    if (this.disposed) return;
    this.disposed = true;
    this.runId++;
    this.selectionAbort?.abort();
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
