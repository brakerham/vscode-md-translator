/**
 * Extension entry point: wires configuration, translation service, preview
 * panels and the sidebar, and registers all commands.
 *
 * Smoke mode: when launched with the environment variable MDT_SMOKE=1 the
 * extension runs a self-check (no network calls), writes smoke-report.json
 * into the extension root and closes the window. Used by the automated
 * Extension Development Host validation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { COMMANDS, EXTENSION_ID, SIDEBAR_VIEW_TYPE } from './common/constants';
import { UserError, errorMessage } from './common/errors';
import { ConfigProvider } from './config/configuration';
import { MarkdownPipeline } from './markdown/pipeline';
import { buildPreviewHtml } from './preview/htmlTemplate';
import { PreviewManager } from './preview/manager';
import { StatusCenter } from './preview/statusCenter';
import { SidebarViewProvider } from './sidebar/sidebarView';
import { FakeProvider } from './testing/fakeProvider';
import { PersistentTranslationCache } from './translation/cache';
import { completionEndpoint, OpenAICompatibleProvider } from './translation/openaiProvider';
import { TranslationService } from './translation/service';
import { TranslationError } from './translation/types';
import { isInsideFencedCodeBlock } from './utils/fenceDetection';
import { VsCodeLogger } from './utils/logger';

interface Services {
  logger: VsCodeLogger;
  configProvider: ConfigProvider;
  statusCenter: StatusCenter;
  cache: PersistentTranslationCache;
  pipeline: MarkdownPipeline;
  service: TranslationService;
  previewManager: PreviewManager;
}

let services: Services | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logger = new VsCodeLogger();
  const configProvider = new ConfigProvider(context.secrets);
  const statusCenter = new StatusCenter();
  const cache = new PersistentTranslationCache(context.globalState, () => configProvider.read().cacheTtlDays, logger);
  const pipeline = new MarkdownPipeline({ logger });
  const provider = new OpenAICompatibleProvider({
    getApiKey: (endpoint) => configProvider.getApiKey(endpoint),
    logger,
  });
  const service = new TranslationService(provider, logger);
  const previewManager = new PreviewManager({
    context,
    pipeline,
    service,
    configProvider,
    cache,
    statusCenter,
    logger,
  });
  const sidebarProvider = new SidebarViewProvider({ context, configProvider, statusCenter, logger });

  services = {
    logger,
    configProvider,
    statusCenter,
    cache,
    pipeline,
    service,
    previewManager,
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_TYPE, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand(COMMANDS.translateDocument, (uri?: vscode.Uri) => reportCommandFailure(translateDocumentCommand(uri, false))),
    vscode.commands.registerCommand(COMMANDS.retranslateDocument, (uri?: vscode.Uri) => reportCommandFailure(translateDocumentCommand(uri, true))),
    vscode.commands.registerCommand(COMMANDS.translateSelection, () => reportCommandFailure(translateSelectionCommand())),
    vscode.commands.registerCommand(COMMANDS.setApiKey, () => reportCommandFailure(setApiKeyCommand())),
    vscode.commands.registerCommand(COMMANDS.clearApiKey, () => reportCommandFailure(clearApiKeyCommand())),
    vscode.commands.registerCommand(COMMANDS.openSettings, () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
    }),
    configProvider.onDidChangeSecrets(() => {
      void configProvider.hasApiKey().then((has) => statusCenter.publishConfig({ hasApiKey: has }));
    }),
    logger,
    configProvider,
    statusCenter,
    sidebarProvider,
    previewManager,
  );

  logger.info(`Markdown AI Translator activated (VS Code ${vscode.version})`);

  if (context.extensionMode !== vscode.ExtensionMode.Production && process.env.MDT_SMOKE === '1') {
    const watchdog = setTimeout(() => {
      try {
        fs.writeFileSync(
          path.join(context.extensionPath, 'smoke-report.json'),
          JSON.stringify({ timedOut: true, results: {} }, null, 2),
          'utf8',
        );
      } catch {
        /* best effort */
      }
      void vscode.commands.executeCommand('workbench.action.closeWindow');
    }, 45000);
    void runSmokeTest(context)
      .catch((err) => {
        logger.error(`Smoke test crashed: ${errorMessage(err)}`);
      })
      .finally(() => clearTimeout(watchdog));
  }
}

export function deactivate(): void {
  services = undefined;
}

function requireServices(): Services {
  if (!services) throw new UserError('Markdown AI Translator is not activated.');
  return services;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function reportCommandFailure(command: Promise<void>): Promise<void> {
  try {
    await command;
  } catch (error) {
    const message = error instanceof UserError ? error.message : 'The command could not be completed. Check the extension settings.';
    void vscode.window.showErrorMessage(message);
  }
}

async function translateDocumentCommand(uri: vscode.Uri | undefined, force: boolean): Promise<void> {
  const s = requireServices();
  const document = await resolveMarkdownDocument(uri);
  if (!document) return;
  if (!(await s.configProvider.hasApiKey())) {
    await showMissingKeyError();
    return;
  }
  if (force) {
    await s.previewManager.retranslate(document);
  } else {
    await s.previewManager.show(document);
  }
}

async function translateSelectionCommand(): Promise<void> {
  const s = requireServices();
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'markdown') {
    void vscode.window.showInformationMessage('Open a Markdown file and select some text first.');
    return;
  }
  if (editor.selection.isEmpty) {
    void vscode.window.showInformationMessage('Select some text to translate.');
    return;
  }
  const text = editor.document.getText(editor.selection);
  if (!(await s.configProvider.hasApiKey())) {
    await showMissingKeyError();
    return;
  }
  if (isInsideFencedCodeBlock(editor.document.getText(), editor.selection.start.line)) {
    const choice = await vscode.window.showWarningMessage(
      'The selection appears to be inside a code block. Translating code is usually not useful.',
      'Translate Anyway',
    );
    if (choice !== 'Translate Anyway') return;
  }

  const config = s.configProvider.read();
  const opts = s.configProvider.toTranslateOptions(config, { cache: s.cache });
  let translated: string;
  try {
    translated = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Translating selection…' },
      () => s.service.translateText(text, opts),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Translation failed: ${userMessageFor(err)}`);
    return;
  }

  s.statusCenter.publishSelection({ source: text, translation: translated });
  void vscode.commands.executeCommand('markdownAiTranslator.sidebarView.focus');
  const action = await vscode.window.showInformationMessage(
    'Selection translated (see the Translation sidebar).',
    'Copy Translation',
  );
  if (action === 'Copy Translation') {
    await vscode.env.clipboard.writeText(translated);
  }
}

async function setApiKeyCommand(): Promise<void> {
  const s = requireServices();
  let endpoint: string;
  try {
    endpoint = completionEndpoint(s.configProvider.read().apiBaseUrl);
  } catch {
    throw new UserError('Set a valid API base URL in User Settings before saving an API key.');
  }
  const key = await vscode.window.showInputBox({
    title: 'Markdown AI Translator: Set API Key',
    prompt: `Save the API key for ${endpoint} in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-…',
  });
  if (key === undefined) return;
  if (!key.trim()) {
    void vscode.window.showErrorMessage('API key cannot be empty.');
    return;
  }
  await s.configProvider.setApiKey(key, endpoint);
  s.statusCenter.publishConfig({ hasApiKey: await s.configProvider.hasApiKey() });
  void vscode.window.showInformationMessage('API key saved securely in SecretStorage.');
}

async function clearApiKeyCommand(): Promise<void> {
  const s = requireServices();
  const choice = await vscode.window.showWarningMessage(
    'Clear the saved API key from SecretStorage?',
    { modal: true },
    'Clear Key',
  );
  if (choice !== 'Clear Key') return;
  await s.configProvider.clearApiKey();
  s.statusCenter.publishConfig({ hasApiKey: false });
  void vscode.window.showInformationMessage('API key removed.');
}

async function resolveMarkdownDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.languageId !== 'markdown') {
      void vscode.window.showWarningMessage('Markdown AI Translator works on Markdown files.');
      return undefined;
    }
    return doc;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage('Open a Markdown file first.');
    return undefined;
  }
  if (editor.document.languageId !== 'markdown') {
    void vscode.window.showWarningMessage('Markdown AI Translator works on Markdown files.');
    return undefined;
  }
  return editor.document;
}

async function showMissingKeyError(): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    'Markdown AI Translator: no API key configured. Set an OpenAI-compatible API key to start translating.',
    'Set API Key',
    'Open Settings',
  );
  if (choice === 'Set API Key') await vscode.commands.executeCommand(COMMANDS.setApiKey);
  else if (choice === 'Open Settings') await vscode.commands.executeCommand(COMMANDS.openSettings);
}

function userMessageFor(err: unknown): string {
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

/* ------------------------------------------------------------------ */
/* Smoke test (MDT_SMOKE=1)                                            */
/* ------------------------------------------------------------------ */

const SMOKE_SAMPLE = `# Hello World

Intro paragraph with **bold** and \`inline code\`.

\`\`\`python
print("do not translate me")
\`\`\`

[link text](https://example.com) and ![alt text](images/x.png).

| A | B |
|---|---|
| 1 | 2 |
`;

async function runSmokeTest(context: vscode.ExtensionContext): Promise<void> {
  const s = requireServices();
  const results: Record<string, { ok: boolean; detail?: string }> = {};
  const run = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn();
      results[name] = { ok: true };
    } catch (err) {
      results[name] = { ok: false, detail: errorMessage(err) };
    }
  };

  await run('config.read', () => {
    const c = s.configProvider.read();
    if (!c.model || !c.apiBaseUrl) throw new Error('empty config');
  });

  await run('secrets.roundtrip', async () => {
    const probe = `smoke-${Date.now()}`;
    const probeKey = 'markdownAiTranslator.smokeProbe';
    let read: string | undefined;
    try {
      await context.secrets.store(probeKey, probe);
      read = await context.secrets.get(probeKey);
    } finally {
      await context.secrets.delete(probeKey);
    }
    if (read !== probe) throw new Error('secret mismatch');
  });

  await run('markdown.extract', () => {
    const doc = s.pipeline.parse(SMOKE_SAMPLE);
    const { segments } = doc.extractSegments();
    if (!segments.some((seg) => seg.text.includes('Hello World'))) {
      throw new Error('heading text not extracted');
    }
    if (segments.some((seg) => seg.text.includes('do not translate'))) {
      throw new Error('code leaked into segments');
    }
  });

  await run('markdown.render', () => {
    const doc = s.pipeline.parse(SMOKE_SAMPLE);
    const { segments } = doc.extractSegments();
    const map = new Map<string, string>();
    for (const seg of segments) map.set(seg.id, `[zh] ${seg.text}`);
    doc.applyTranslations(map);
    const src = doc.render({ version: 'src' });
    const trans = doc.render({ version: 'trans' });
    if (!src.includes('do not translate me')) throw new Error('code lost in src render');
    if (!trans.includes('do not translate me')) throw new Error('code lost in trans render');
    if (!trans.includes('[zh] Hello World')) throw new Error('translation not applied');
  });

  await run('translation.service', async () => {
    const svc = new TranslationService(new FakeProvider(), s.logger);
    const map = await svc.translateSegments(
      [
        { id: 'a', kind: 'paragraph', text: 'one' },
        { id: 'b', kind: 'heading', text: 'two' },
      ],
      {
        systemPrompt: 'p',
        sourceLanguage: 'auto',
        targetLanguage: 'zh',
        model: 'm',
        temperature: 0,
        timeoutMs: 5000,
        maxConcurrency: 1,
        maxTokensPerRequest: 1000,
        retries: 0,
      },
    );
    if (map.get('a') !== '[zh] one') throw new Error(`unexpected translation: ${map.get('a')}`);
  });

  await run('webview.html', async () => {
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'dist', 'media');
    const panel = vscode.window.createWebviewPanel('mdtSmoke', 'Smoke', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [mediaDir],
    });
    try {
      const wv = panel.webview;
      const html = buildPreviewHtml({
        nonce: 'smokenonce',
        cspSource: wv.cspSource,
        mainScriptUri: wv.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'main.js')).toString(),
        previewCssUri: wv.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'preview.css')).toString(),
        codiconCssUri: wv
          .asWebviewUri(vscode.Uri.joinPath(mediaDir, 'codicons', 'codicon.css'))
          .toString(),
        katexCssUri: wv
          .asWebviewUri(vscode.Uri.joinPath(mediaDir, 'katex', 'katex.min.css'))
          .toString(),
      });
      if (!html.includes('Content-Security-Policy')) throw new Error('missing CSP');
      if (!html.includes("script-src 'nonce-smokenonce'")) throw new Error('missing nonce script-src');
      if (html.includes('smoke-') || /api\s*key/i.test(html)) throw new Error('secret leaked into html');
      wv.html = html;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      panel.dispose();
    }
  });

  await run('sidebar.provider', () => {
    new SidebarViewProvider({
      context,
      configProvider: s.configProvider,
      statusCenter: s.statusCenter,
      logger: s.logger,
    });
  });

  const report = {
    vscodeVersion: vscode.version,
    ranAt: new Date().toISOString(),
    results,
  };
  const reportPath = path.join(context.extensionPath, 'smoke-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  s.logger.info(`Smoke report written to ${reportPath}`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
