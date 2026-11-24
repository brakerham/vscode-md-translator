/**
 * Shared types for the Markdown AI Translator extension.
 * This module is intentionally free of any `vscode` import so that it can be
 * used from unit tests and from the webview-side protocol definitions.
 */

/** Display mode of the translation preview. */
export type TranslationMode = 'source' | 'translated' | 'bilingual';

/** Lifecycle state of a document translation run. */
export type TranslationState =
  | 'idle'
  | 'extracting'
  | 'translating'
  | 'rendering'
  | 'done'
  | 'error'
  | 'cancelled';

/** Kind of a translatable segment, used as a hint for the translation model. */
export type SegmentKind =
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'blockquote'
  | 'table_cell'
  | 'link_text'
  | 'image_alt';

/** Minimal logger contract; the extension host implementation wraps an OutputChannel. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/* ------------------------------------------------------------------ */
/* Preview webview protocol (extension host -> webview)                */
/* ------------------------------------------------------------------ */

export interface PreviewInitMessage {
  type: 'init';
  documentTitle: string;
  sourceHtml: string;
  /** null until the first successful translation. */
  translatedHtml: string | null;
  /** Block indexes that have translatable content (used for bilingual pairing). */
  translatedBlocks: number[];
  mode: TranslationMode;
  /** VS Code UI language, e.g. "en" or "zh-cn". */
  vscodeLanguage: string;
  hasApiKey: boolean;
  targetLanguage: string;
  /** Webview URI of the mermaid bundle, or "" when unavailable. */
  mermaidScriptUri: string;
}

export interface PreviewUpdateMessage {
  type: 'updateHtml';
  sourceHtml: string;
  translatedHtml: string;
  translatedBlocks: number[];
}

export interface PreviewStatusMessage {
  type: 'status';
  state: TranslationState;
  done: number;
  total: number;
  /** Human-readable detail (mainly for errors). */
  message?: string;
}

export interface PreviewConfigMessage {
  type: 'config';
  hasApiKey: boolean;
  /** New default mode from settings; the preview should apply it. */
  mode: TranslationMode;
}

export interface PreviewSelectionResultMessage {
  type: 'selectionTranslationResult';
  requestId: number;
  ok: boolean;
  text?: string;
  error?: string;
}

export type PreviewHostMessage =
  | PreviewInitMessage
  | PreviewUpdateMessage
  | PreviewStatusMessage
  | PreviewConfigMessage
  | PreviewSelectionResultMessage;

/* ------------------------------------------------------------------ */
/* Preview webview protocol (webview -> extension host)                */
/* ------------------------------------------------------------------ */

export type PreviewWebviewMessage =
  | { type: 'ready' }
  | { type: 'translateAll' }
  | { type: 'retranslate' }
  | { type: 'cancel' }
  | { type: 'setMode'; mode: TranslationMode }
  | { type: 'translateSelection'; requestId: number; text: string }
  | { type: 'openLink'; href: string }
  | { type: 'reportError'; message: string };

/* ------------------------------------------------------------------ */
/* Sidebar webview protocol                                            */
/* ------------------------------------------------------------------ */

export interface SidebarInitMessage {
  type: 'init';
  hasApiKey: boolean;
  apiBaseUrl: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  vscodeLanguage: string;
  documentStatus: SidebarDocumentStatus | null;
  lastSelection: SidebarSelectionResult | null;
}

export interface SidebarDocumentStatus {
  docTitle: string;
  state: TranslationState;
  done: number;
  total: number;
  message?: string;
}

export interface SidebarSelectionResult {
  source: string;
  translation: string;
}

export type SidebarUpdateMessage =
  | { type: 'config'; hasApiKey: boolean; apiBaseUrl: string; model: string; sourceLanguage: string; targetLanguage: string }
  | { type: 'documentStatus'; status: SidebarDocumentStatus | null }
  | { type: 'selectionResult'; result: SidebarSelectionResult };

export type SidebarHostMessage = SidebarInitMessage | SidebarUpdateMessage;

export type SidebarWebviewMessage =
  | { type: 'ready' }
  | { type: 'command'; command: string }
  | { type: 'reportError'; message: string };
