/**
 * Translation service layer contracts. Independent of VS Code so the whole
 * pipeline can be unit tested with mock providers and fetch implementations.
 */

export interface ProviderContext {
  systemPrompt: string;
  sourceLanguage: string;
  targetLanguage: string;
  model: string;
  temperature: number;
}

export interface ProviderRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProviderBatchEntry {
  id: string;
  kind: string;
  text: string;
}

export interface ProviderBatchResult {
  id: string;
  text: string;
}

/**
 * A model vendor adapter. The extension never talks to a vendor directly;
 * future providers (Anthropic, Gemini, ...) implement this interface.
 */
export interface TranslationProvider {
  readonly id: string;
  translateBatch(
    entries: ProviderBatchEntry[],
    ctx: ProviderContext,
    opts: ProviderRequestOptions,
  ): Promise<ProviderBatchResult[]>;
}

export type ProviderErrorKind =
  | 'auth'
  | 'rate-limited'
  | 'http'
  | 'invalid-response'
  | 'network'
  | 'timeout'
  | 'aborted';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type TranslationErrorKind =
  | 'aborted'
  | 'auth'
  | 'rate-limited'
  | 'config'
  | 'network'
  | 'invalid-response'
  | 'unknown';

export class TranslationError extends Error {
  constructor(
    public readonly kind: TranslationErrorKind,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}

/** Simple key/value store for translations; value is the translated text. */
export interface TranslationCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  clear(): void;
}

/** A translatable unit produced by the Markdown extractor. */
export interface SegmentEntry {
  id: string;
  kind: string;
  text: string;
}

export interface TranslateOptions {
  systemPrompt: string;
  sourceLanguage: string;
  targetLanguage: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxConcurrency: number;
  maxTokensPerRequest: number;
  retries: number;
  cache?: TranslationCache;
  /** Skip cache reads (still writes results back to the cache). */
  forceRefresh?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}
