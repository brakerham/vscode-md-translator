/**
 * Central event hub so the sidebar view can reflect preview state without
 * coupling to the preview panels.
 */
import * as vscode from 'vscode';
import type { TranslationState } from '../common/types';

export interface DocumentStatusEvent {
  uri: string;
  docTitle: string;
  state: TranslationState;
  done: number;
  total: number;
  message?: string;
}

export interface SelectionEvent {
  source: string;
  translation: string;
}

export interface ConfigEvent {
  hasApiKey: boolean;
}

export class StatusCenter {
  private readonly docEmitter = new vscode.EventEmitter<DocumentStatusEvent>();
  private readonly selectionEmitter = new vscode.EventEmitter<SelectionEvent>();
  private readonly configEmitter = new vscode.EventEmitter<ConfigEvent>();

  readonly onDocumentStatus = this.docEmitter.event;
  readonly onSelectionTranslated = this.selectionEmitter.event;
  readonly onConfigChanged = this.configEmitter.event;

  publishDocumentStatus(event: DocumentStatusEvent): void {
    this.docEmitter.fire(event);
  }

  publishSelection(event: SelectionEvent): void {
    this.selectionEmitter.fire(event);
  }

  publishConfig(event: ConfigEvent): void {
    this.configEmitter.fire(event);
  }

  dispose(): void {
    this.docEmitter.dispose();
    this.selectionEmitter.dispose();
    this.configEmitter.dispose();
  }
}
