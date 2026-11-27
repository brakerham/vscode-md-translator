/**
 * TranslationService — orchestrates deduplication, caching, chunking,
 * concurrency, retries, cancellation and progress reporting on top of a
 * TranslationProvider.
 */
import type { Logger } from '../common/types';
import { cacheKeyFor, estimateTokens } from './prompts';
import {
  ProviderError,
  TranslationError,
  type ProviderBatchEntry,
  type ProviderContext,
  type SegmentEntry,
  type TranslateOptions,
  type TranslationProvider,
} from './types';
import { sleep } from './utils';

const MAX_SEGMENTS_PER_CHUNK = 100;
const MIN_CHUNK_BUDGET = 256;

/** A unique translatable unit plus every input id that shares it. */
interface UniqueEntry {
  /** Dedupe key: `${kind}\u0000${text}`. */
  readonly key: string;
  readonly kind: string;
  readonly text: string;
  /** Input ids sharing this entry, in input order. */
  readonly ids: string[];
  /** First occurrence index in the input array (for ordering). */
  readonly firstIndex: number;
}

/** Whether a provider failure is worth retrying. */
function isRetryableProviderError(err: ProviderError): boolean {
  switch (err.kind) {
    case 'network':
    case 'timeout':
    case 'rate-limited':
    case 'invalid-response':
      return true;
    case 'http':
      return err.statusCode !== undefined && err.statusCode >= 500;
    default:
      return false;
  }
}

/**
 * Maps a final provider failure to the user-facing TranslationError kind.
 *
 *   auth             -> auth
 *   rate-limited     -> rate-limited
 *   http (4xx)       -> config
 *   http (5xx)       -> network
 *   network, timeout -> network
 *   invalid-response -> invalid-response
 *   aborted          -> aborted
 *   anything else    -> unknown
 */
function toTranslationError(err: unknown): TranslationError {
  if (err instanceof TranslationError) {
    return err;
  }
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'config':
        return new TranslationError('config', err.message);
      case 'auth':
        return new TranslationError('auth', err.message, err.statusCode);
      case 'rate-limited':
        return new TranslationError('rate-limited', err.message, err.statusCode);
      case 'http':
        if (err.statusCode !== undefined && err.statusCode >= 500) {
          return new TranslationError('network', err.message, err.statusCode);
        }
        return new TranslationError('config', err.message, err.statusCode);
      case 'network':
      case 'timeout':
        return new TranslationError('network', err.message, err.statusCode);
      case 'invalid-response':
        return new TranslationError('invalid-response', err.message);
      case 'aborted':
        return new TranslationError('aborted', err.message);
      default:
        return new TranslationError('unknown', err.message);
    }
  }
  // Unknown errors may carry unsafe details; keep the message generic.
  return new TranslationError('unknown', 'Unexpected error during translation.');
}

/**
 * Greedy chunking within a per-chunk token budget. Closes a chunk when the
 * next entry would exceed the budget or the 100-entry hard cap; a single
 * oversized entry always gets its own (non-empty) chunk.
 */
function buildChunks(entries: UniqueEntry[], maxTokensPerRequest: number): UniqueEntry[][] {
  const budget = Math.max(MIN_CHUNK_BUDGET, maxTokensPerRequest - 512);
  const chunks: UniqueEntry[][] = [];
  let current: UniqueEntry[] = [];
  let currentTokens = 0;
  for (const entry of entries) {
    const cost = estimateTokens(entry.text) + 8;
    if (
      current.length > 0 &&
      (currentTokens + cost > budget || current.length >= MAX_SEGMENTS_PER_CHUNK)
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(entry);
    currentTokens += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** Rebuilds the result map in input order (every input id is present). */
function buildResultMap(segments: SegmentEntry[], resolvedById: Map<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const segment of segments) {
    map.set(segment.id, resolvedById.get(segment.id) ?? segment.text);
  }
  return map;
}

export class TranslationService {
  constructor(
    private readonly provider: TranslationProvider,
    private readonly logger?: Logger,
  ) {}

  /**
   * Translates all segments. Resolves to a map of id -> translated text for
   * every requested id (cached results included). Throws TranslationError.
   */
  async translateSegments(segments: SegmentEntry[], opts: TranslateOptions): Promise<Map<string, string>> {
    const batch = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, batch.signal]) : batch.signal;
    const checkAborted = (): void => {
      if (signal.aborted) throw new TranslationError('aborted', 'Translation aborted.');
    };
    checkAborted();
    const total = segments.length;
    if (total === 0) {
      opts.onProgress?.(0, 0);
      return new Map();
    }

    // 1) Deduplicate by kind+text while remembering input ids and order.
    const uniqueList: UniqueEntry[] = [];
    const byKey = new Map<string, UniqueEntry>();
    const resolvedById = new Map<string, string>();
    let done = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.text.trim().length === 0) {
        // Empty segments pass through as-is without any API work.
        resolvedById.set(segment.id, segment.text);
        done++;
        continue;
      }
      const key = `${segment.kind}\u0000${segment.text}`;
      let unique = byKey.get(key);
      if (!unique) {
        unique = { key, kind: segment.kind, text: segment.text, ids: [], firstIndex: i };
        byKey.set(key, unique);
        uniqueList.push(unique);
      }
      unique.ids.push(segment.id);
    }

    const ctx: ProviderContext = {
      apiBaseUrl: opts.apiBaseUrl,
      systemPrompt: opts.systemPrompt,
      sourceLanguage: opts.sourceLanguage,
      targetLanguage: opts.targetLanguage,
      model: opts.model,
      temperature: opts.temperature,
    };

    // 2) Cache phase.
    const pending: UniqueEntry[] = [];
    if (opts.cache && !opts.forceRefresh) {
      for (const unique of uniqueList) {
        const cached = opts.cache.get(cacheKeyFor(unique.text, ctx, unique.kind));
        if (cached !== undefined) {
          for (const id of unique.ids) {
            resolvedById.set(id, cached);
          }
          done += unique.ids.length;
        } else {
          pending.push(unique);
        }
      }
    } else {
      pending.push(...uniqueList);
    }

    let lastReported = 0;
    const report = (): void => {
      if (done === lastReported) {
        return;
      }
      lastReported = done;
      opts.onProgress?.(done, total);
    };
    report(); // After the cache phase (skipped when nothing changed).
    checkAborted();

    // 3) Everything came from the cache (or was empty): we are done.
    if (pending.length === 0) {
      report(); // Ensures a final (total, total) call.
      return buildResultMap(segments, resolvedById);
    }

    const chunks = buildChunks(pending, opts.maxTokensPerRequest);
    this.logger?.info(
      `translation: ${chunks.length} chunk(s) for ${pending.length} unique segment(s) via ${this.provider.id}`,
    );

    const processChunk = async (chunk: UniqueEntry[], chunkIndex: number): Promise<void> => {
      const entries: ProviderBatchEntry[] = chunk.map((u) => ({
        id: u.ids[0],
        kind: u.kind,
        text: u.text,
      }));
      for (let attempt = 0; ; attempt++) {
        checkAborted();
        try {
          const results = await this.provider.translateBatch(entries, ctx, {
            timeoutMs: opts.timeoutMs,
            signal,
          });
          checkAborted();
          const byId = new Map<string, string>();
          for (const result of results) {
            if (typeof result.id === 'string' && typeof result.text === 'string') {
              byId.set(result.id, result.text);
            }
          }
          // Double-check: every chunk entry id must be present.
          const missing = entries.filter((entry) => {
            const value = byId.get(entry.id);
            return value === undefined || value.trim().length === 0;
          });
          if (missing.length > 0) {
            throw new ProviderError(
              'invalid-response',
              `Provider response is missing translations for ids: ${missing.map((m) => m.id).join(', ')}`,
            );
          }
          for (const unique of chunk) {
            const value = byId.get(unique.ids[0])!;
            for (const id of unique.ids) {
              resolvedById.set(id, value);
            }
            done += unique.ids.length;
          }
          this.logger?.info(`chunk ${chunkIndex + 1}/${chunks.length}: ${chunk.length} segments`);
          return;
        } catch (err) {
          checkAborted();
          if (err instanceof ProviderError) {
            if (isRetryableProviderError(err) && attempt < opts.retries) {
              const status = err.statusCode !== undefined ? ` (HTTP ${err.statusCode})` : '';
              this.logger?.warn(`attempt ${attempt + 2} after ${err.kind}${status}`);
              try {
                await sleep(500 * 2 ** attempt + Math.random() * 250, signal);
              } catch {
                checkAborted();
              }
              continue;
            }
            throw toTranslationError(err);
          }
          throw new TranslationError('unknown', 'Unexpected error during translation.');
        }
      }
    };

    // 4) Workers share a queue. A failure cancels sibling requests for this run.
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted && nextIndex < chunks.length) {
        const index = nextIndex++;
        await processChunk(chunks[index], index);
        if (!signal.aborted) report();
      }
    };
    const concurrency = Math.min(chunks.length, Math.max(1, Math.floor(opts.maxConcurrency)));
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
      checkAborted();
    } catch (err) {
      batch.abort();
      const failure = toTranslationError(err);
      this.logger?.error(`translation failed: ${failure.kind}`);
      throw failure;
    }

    // Commit only a complete run, including a successful forced refresh.
    for (const unique of pending) {
      const value = resolvedById.get(unique.ids[0]);
      if (value !== undefined) opts.cache?.set(cacheKeyFor(unique.text, ctx, unique.kind), value);
    }
    report();
    return buildResultMap(segments, resolvedById);
  }

  /** Convenience wrapper for translating a single text (e.g. a selection). */
  async translateText(text: string, opts: TranslateOptions): Promise<string> {
    const map = await this.translateSegments([{ id: 'sel', kind: 'paragraph', text }], opts);
    return map.get('sel') ?? text;
  }
}
