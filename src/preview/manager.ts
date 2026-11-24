/**
 * Owns one TranslationPreviewPanel per document and reuses it instead of
 * creating a new tab every time the user clicks translate.
 */
import * as vscode from 'vscode';
import type { Logger } from '../common/types';
import type { ConfigProvider } from '../config/configuration';
import type { MarkdownPipeline } from '../markdown/pipeline';
import { TranslationPreviewPanel } from './panel';
import type { StatusCenter } from './statusCenter';
import type { TranslationCache } from '../translation/types';
import type { TranslationService } from '../translation/service';

export interface PreviewManagerDeps {
  context: vscode.ExtensionContext;
  pipeline: MarkdownPipeline;
  service: TranslationService;
  configProvider: ConfigProvider;
  cache: TranslationCache;
  statusCenter: StatusCenter;
  logger: Logger;
}

export class PreviewManager {
  private readonly panels = new Map<string, TranslationPreviewPanel>();

  constructor(private readonly deps: PreviewManagerDeps) {}

  /** Opens (or reuses) the preview panel for the document and starts translation. */
  async show(document: vscode.TextDocument, options: { force?: boolean } = {}): Promise<TranslationPreviewPanel> {
    const key = document.uri.toString();
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      if (options.force) await existing.refresh(true);
      return existing;
    }
    const panel = new TranslationPreviewPanel({ ...this.deps, document });
    this.panels.set(key, panel);
    panel.onDidDispose(() => this.panels.delete(key));
    return panel;
  }

  /** Reuses or opens the panel and forces a cache-bypassing re-translation. */
  async retranslate(document: vscode.TextDocument): Promise<TranslationPreviewPanel> {
    return this.show(document, { force: true });
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) {
      panel.dispose();
    }
    this.panels.clear();
  }
}
