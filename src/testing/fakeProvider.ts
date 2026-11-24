/**
 * In-tree fake provider used by smoke tests. Never makes network calls.
 */
import {
  ProviderBatchEntry,
  ProviderBatchResult,
  ProviderContext,
  ProviderError,
  ProviderErrorKind,
  ProviderRequestOptions,
  TranslationProvider,
} from '../translation/types';

export interface FakeProviderOptions {
  /** Per-batch simulated latency. */
  delayMs?: number;
  /** Fail the first N batches with `failWith` before succeeding. */
  failFirst?: number;
  failWith?: ProviderErrorKind;
  /** Applied to each text to produce the "translation". */
  transform?: (text: string) => string;
  /** Omit these ids from results (simulates an invalid response). */
  omitIds?: string[];
  /** Observe aborts. */
  observeAbort?: boolean;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError('aborted', 'aborted by signal'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new ProviderError('aborted', 'aborted by signal'));
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort);
  });
}

export class FakeProvider implements TranslationProvider {
  readonly id = 'fake';
  /** Deep-copied batches, in call order. */
  readonly calls: ProviderBatchEntry[][] = [];
  readonly ctxs: ProviderContext[] = [];
  maxActive = 0;

  private active = 0;

  constructor(private readonly options: FakeProviderOptions = {}) {}

  async translateBatch(
    entries: ProviderBatchEntry[],
    ctx: ProviderContext,
    opts: ProviderRequestOptions,
  ): Promise<ProviderBatchResult[]> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      this.calls.push(entries.map((e) => ({ ...e })));
      this.ctxs.push({ ...ctx });
      const callIndex = this.calls.length;
      if (this.options.failFirst && callIndex <= this.options.failFirst) {
        throw new ProviderError(
          this.options.failWith ?? 'rate-limited',
          `fake failure for batch ${callIndex}`,
        );
      }
      if (this.options.delayMs) {
        await abortableSleep(this.options.delayMs, opts.signal);
      }
      if (opts.signal?.aborted) {
        throw new ProviderError('aborted', 'aborted by signal');
      }
      const transform = this.options.transform ?? ((t: string): string => `[zh] ${t}`);
      const omit = new Set(this.options.omitIds ?? []);
      return entries
        .filter((e) => !omit.has(e.id))
        .map((e) => ({ id: e.id, text: transform(e.text) }));
    } finally {
      this.active--;
    }
  }
}
