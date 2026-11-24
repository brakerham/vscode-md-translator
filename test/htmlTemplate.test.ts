import { describe, expect, it } from 'vitest';
import { buildPreviewHtml } from '../src/preview/htmlTemplate';

const REQUIRED_IDS = [
  'mdt-toolbar',
  'mdt-status',
  'mdt-seg',
  'mdt-btn-translate',
  'mdt-btn-retranslate',
  'mdt-btn-cancel',
  'mdt-src-root',
  'mdt-trans-root',
  'mdt-sel-btn',
  'mdt-card',
  'mdt-card-body',
  'mdt-card-copy',
  'mdt-card-close',
];

function build() {
  return buildPreviewHtml({
    nonce: 'abc123',
    cspSource: 'vscode-webview://test',
    mainScriptUri: 'vscode-webview://test/main.js',
    previewCssUri: 'vscode-webview://test/preview.css',
    codiconCssUri: 'vscode-webview://test/codicon.css',
    katexCssUri: 'vscode-webview://test/katex.min.css',
  });
}

describe('buildPreviewHtml', () => {
  it('emits a strict CSP with a nonce', () => {
    const html = build();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toMatch(/<script nonce="abc123" src="/);
    expect(html).toContain('<meta id="mdt-nonce" content="abc123">');
  });

  it('contains every DOM id the webview script depends on', () => {
    const html = build();
    for (const id of REQUIRED_IDS) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('never leaks secret material into the template', () => {
    const html = build();
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(html).not.toMatch(/Bearer\s+\S+/i);
  });
});
