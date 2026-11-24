/**
 * Preview webview HTML template. The DOM ids/classes are a hard contract with
 * src/webview/main.ts — keep them in sync.
 *
 * Deliberately vscode-free (all URIs are passed as strings) so the template
 * can be unit tested without mocking the VS Code API.
 */
export interface PreviewHtmlParts {
  nonce: string;
  /** `webview.cspSource` value. */
  cspSource: string;
  mainScriptUri: string;
  previewCssUri: string;
  codiconCssUri: string;
  katexCssUri: string;
}

export function buildPreviewHtml(parts: PreviewHtmlParts): string {
  const { nonce, cspSource } = parts;
  const csp = [
    "default-src 'none'",
    `img-src ${cspSource} https: http: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta id="mdt-nonce" content="${nonce}">
<link rel="stylesheet" href="${parts.codiconCssUri}">
<link rel="stylesheet" href="${parts.katexCssUri}">
<link rel="stylesheet" href="${parts.previewCssUri}">
<title>Markdown AI Translator</title>
</head>
<body>
<header id="mdt-toolbar">
  <span id="mdt-status" class="mdt-status"></span>
  <span class="mdt-spacer"></span>
  <div id="mdt-seg" class="mdt-seg" role="tablist">
    <button class="mdt-seg-btn" data-mode="source" title="Source"></button>
    <button class="mdt-seg-btn" data-mode="translated" title="Translated"></button>
    <button class="mdt-seg-btn" data-mode="bilingual" title="Bilingual"></button>
  </div>
  <button id="mdt-btn-translate" class="mdt-btn" title="Translate"><i class="codicon codicon-globe"></i><span class="mdt-btn-label"></span></button>
  <button id="mdt-btn-retranslate" class="mdt-btn" title="Re-translate" hidden><i class="codicon codicon-refresh"></i><span class="mdt-btn-label"></span></button>
  <button id="mdt-btn-cancel" class="mdt-btn" title="Cancel" hidden><i class="codicon codicon-close"></i><span class="mdt-btn-label"></span></button>
</header>
<main id="mdt-content">
  <div id="mdt-src-root" class="md-content"></div>
  <div id="mdt-trans-root" class="md-content" hidden></div>
</main>
<button id="mdt-sel-btn" class="mdt-sel-btn" hidden><i class="codicon codicon-globe"></i><span id="mdt-sel-btn-label"></span></button>
<div id="mdt-card" class="mdt-card" hidden>
  <div class="mdt-card-head">
    <span id="mdt-card-label"></span>
    <span class="mdt-card-actions">
      <button id="mdt-card-copy" class="mdt-btn" title="Copy"><i class="codicon codicon-copy"></i></button>
      <button id="mdt-card-close" class="mdt-btn" title="Close"><i class="codicon codicon-close"></i></button>
    </span>
  </div>
  <div id="mdt-card-body"></div>
</div>
<script nonce="${nonce}" src="${parts.mainScriptUri}"></script>
</body>
</html>`;
}
