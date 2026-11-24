/**
 * Sidebar view: lightweight companion panel with API status, document
 * translation status and the latest selection translation.
 */
import * as vscode from 'vscode';
import { COMMANDS, SIDEBAR_VIEW_TYPE } from '../common/constants';
import type {
  Logger,
  SidebarDocumentStatus,
  SidebarHostMessage,
  SidebarSelectionResult,
  SidebarWebviewMessage,
} from '../common/types';
import type { ConfigProvider } from '../config/configuration';
import type { StatusCenter } from '../preview/statusCenter';

export interface SidebarHtmlParts {
  nonce: string;
  cspSource: string;
  scriptUri: string;
  cssUri: string;
  codiconCssUri: string;
}

export function buildSidebarHtml(parts: SidebarHtmlParts): string {
  const csp = [
    "default-src 'none'",
    `style-src ${parts.cspSource} 'unsafe-inline'`,
    `font-src ${parts.cspSource}`,
    `script-src 'nonce-${parts.nonce}'`,
    "img-src data:",
    "connect-src 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${parts.codiconCssUri}">
<link rel="stylesheet" href="${parts.cssUri}">
<title>Markdown AI Translator</title>
</head>
<body>
<div class="mdt-side">
  <section class="mdt-card">
    <h3 class="mdt-h"><i class="codicon codicon-key"></i><span id="mdt-api-title">API</span></h3>
    <div id="mdt-api-status" class="mdt-row"></div>
    <div id="mdt-api-detail" class="mdt-detail"></div>
    <div class="mdt-actions">
      <button id="mdt-cmd-setkey" class="mdt-btn"></button>
      <button id="mdt-cmd-clearkey" class="mdt-btn"></button>
      <button id="mdt-cmd-settings" class="mdt-btn"></button>
    </div>
  </section>
  <section class="mdt-card">
    <h3 class="mdt-h"><i class="codicon codicon-file"></i><span id="mdt-doc-title">Document</span></h3>
    <div id="mdt-doc-name" class="mdt-detail"></div>
    <div id="mdt-doc-status" class="mdt-detail"></div>
    <div class="mdt-actions">
      <button id="mdt-cmd-translate" class="mdt-btn"></button>
      <button id="mdt-cmd-retranslate" class="mdt-btn"></button>
    </div>
  </section>
  <section class="mdt-card">
    <h3 class="mdt-h"><i class="codicon codicon-selection"></i><span id="mdt-sel-title">Selection</span></h3>
    <div id="mdt-sel-empty" class="mdt-detail"></div>
    <div id="mdt-sel-body" hidden>
      <div id="mdt-sel-source" class="mdt-sel-source"></div>
      <div id="mdt-sel-trans" class="mdt-sel-trans"></div>
    </div>
    <div class="mdt-actions">
      <button id="mdt-copy-sel" class="mdt-btn" hidden></button>
    </div>
  </section>
</div>
<script nonce="${parts.nonce}" src="${parts.scriptUri}"></script>
</body>
</html>`;
}

interface SidebarState {
  hasApiKey: boolean;
  apiBaseUrl: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  documentStatus: SidebarDocumentStatus | null;
  lastSelection: SidebarSelectionResult | null;
}

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  COMMANDS.setApiKey,
  COMMANDS.clearApiKey,
  COMMANDS.openSettings,
  COMMANDS.translateDocument,
  COMMANDS.retranslateDocument,
]);

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly state: SidebarState = {
    hasApiKey: false,
    apiBaseUrl: '',
    model: '',
    sourceLanguage: '',
    targetLanguage: '',
    documentStatus: null,
    lastSelection: null,
  };

  constructor(
    private readonly deps: {
      context: vscode.ExtensionContext;
      configProvider: ConfigProvider;
      statusCenter: StatusCenter;
      logger: Logger;
    },
  ) {
    this.disposables.push(
      deps.statusCenter.onDocumentStatus((e) => {
        this.state.documentStatus = {
          docTitle: e.docTitle,
          state: e.state,
          done: e.done,
          total: e.total,
          message: e.message,
        };
        void this.post({ type: 'documentStatus', status: this.state.documentStatus });
      }),
      deps.statusCenter.onSelectionTranslated((e) => {
        this.state.lastSelection = { source: e.source, translation: e.translation };
        void this.post({ type: 'selectionResult', result: this.state.lastSelection });
      }),
      deps.statusCenter.onConfigChanged((e) => {
        this.state.hasApiKey = e.hasApiKey;
        void this.pushConfig();
      }),
      deps.configProvider.onDidChange(() => {
        void this.pushConfig();
      }),
      deps.configProvider.onDidChangeSecrets(() => {
        void this.pushConfig();
      }),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    const mediaDir = vscode.Uri.joinPath(this.deps.context.extensionUri, 'dist', 'media');
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaDir],
    };
    const nonce = Buffer.from(
      Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)),
    ).toString('base64');
    const wv = webviewView.webview;
    webviewView.webview.html = buildSidebarHtml({
      nonce,
      cspSource: wv.cspSource,
      scriptUri: wv.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'sidebar.js')).toString(),
      cssUri: wv.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'sidebar.css')).toString(),
      codiconCssUri: wv.asWebviewUri(vscode.Uri.joinPath(mediaDir, 'codicons', 'codicon.css')).toString(),
    });
    webviewView.webview.onDidReceiveMessage(
      (msg: SidebarWebviewMessage) => {
        void this.handle(msg);
      },
      undefined,
      this.disposables,
    );
  }

  private async handle(msg: SidebarWebviewMessage): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        await this.pushSnapshot();
        return;
      case 'command':
        if (typeof msg.command === 'string' && ALLOWED_COMMANDS.has(msg.command)) {
          await vscode.commands.executeCommand(msg.command);
        } else {
          this.deps.logger.warn(`Sidebar webview requested unknown command: ${String(msg.command)}`);
        }
        return;
      case 'reportError':
        this.deps.logger.warn(`Sidebar webview reported error: ${String(msg.message).slice(0, 500)}`);
        return;
      default:
        return;
    }
  }

  private async refreshState(): Promise<void> {
    const config = this.deps.configProvider.read();
    this.state.hasApiKey = await this.deps.configProvider.hasApiKey();
    this.state.apiBaseUrl = config.apiBaseUrl;
    this.state.model = config.model;
    this.state.sourceLanguage = config.sourceLanguage;
    this.state.targetLanguage = config.targetLanguage;
  }

  private async pushSnapshot(): Promise<void> {
    await this.refreshState();
    await this.post({
      type: 'init',
      hasApiKey: this.state.hasApiKey,
      apiBaseUrl: this.state.apiBaseUrl,
      model: this.state.model,
      sourceLanguage: this.state.sourceLanguage,
      targetLanguage: this.state.targetLanguage,
      vscodeLanguage: vscode.env.language,
      documentStatus: this.state.documentStatus,
      lastSelection: this.state.lastSelection,
    });
  }

  private async pushConfig(): Promise<void> {
    await this.refreshState();
    await this.post({
      type: 'config',
      hasApiKey: this.state.hasApiKey,
      apiBaseUrl: this.state.apiBaseUrl,
      model: this.state.model,
      sourceLanguage: this.state.sourceLanguage,
      targetLanguage: this.state.targetLanguage,
    });
  }

  private async post(msg: SidebarHostMessage): Promise<void> {
    try {
      await this.view?.webview.postMessage(msg);
    } catch {
      /* view disposed concurrently */
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.view = null;
  }
}

/** Exists so the smoke test can construct the provider without registering it. */
export function sidebarViewType(): string {
  return SIDEBAR_VIEW_TYPE;
}
