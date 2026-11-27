import { describe, expect, it, vi } from 'vitest';
import { MemoryTranslationCache } from '../src/translation/cache';
import { estimateTokens } from '../src/translation/prompts';
import { TranslationService } from '../src/translation/service';
import {
  ProviderError,
  type ProviderBatchEntry,
  type ProviderBatchResult,
  type ProviderContext,
  type ProviderErrorKind,
  type ProviderRequestOptions,
  type SegmentEntry,
  type TranslateOptions,
  type TranslationProvider,
} from '../src/translation/types';

/** Abort-aware delay used by the fake provider. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Configurable fake provider: per-batch delay, fail-first-N attempts with a
 * given ProviderError kind/status, optional id dropping, in-flight tracking
 * and recording of every batch and signal it receives.
 */
class FakeProvider implements TranslationProvider {
  readonly id = 'fake';
  calls = 0;
  readonly batches: ProviderBatchEntry[][] = [];
  readonly signalsSeen: (AbortSignal | undefined)[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    public delayMs = 0,
    public failFirstN = 0,
    public failKind: ProviderErrorKind = 'rate-limited',
    public failStatus?: number,
    public omitLastIdFirstN = 0,
  ) {}

  async translateBatch(
    entries: ProviderBatchEntry[],
    _ctx: ProviderContext,
    opts: ProviderRequestOptions,
  ): Promise<ProviderBatchResult[]> {
    this.calls++;
    this.batches.push(entries.map((e) => ({ ...e })));
    this.signalsSeen.push(opts.signal);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleepAbortable(this.delayMs, opts.signal);
      if (this.calls <= this.failFirstN) {
        throw new ProviderError(this.failKind, `fake failure ${this.calls}`, this.failStatus);
      }
      if (opts.signal?.aborted) {
        throw new ProviderError('aborted', 'Request aborted');
      }
      if (this.omitLastIdFirstN > 0 && this.calls <= this.omitLastIdFirstN) {
        return entries.slice(0, entries.length - 1).map((e) => ({ id: e.id, text: `tr:${e.text}` }));
      }
      return entries.map((e) => ({ id: e.id, text: `tr:${e.text}` }));
    } finally {
      this.inFlight--;
    }
  }
}

function makeOptions(overrides: Partial<TranslateOptions> = {}): TranslateOptions {
  return {
    systemPrompt: 'Translate from {sourceLanguage} to {targetLanguage}.',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    timeoutMs: 5000,
    maxConcurrency: 3,
    maxTokensPerRequest: 4000,
    retries: 2,
    ...overrides,
  };
}

function makeSegments(n: number, text: (i: number) => string, kind = 'paragraph'): SegmentEntry[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind, text: text(i) }));
}

describe('TranslationService.translateSegments', () => {
  it('chunks within the token budget and returns a complete ordered map', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const segments = makeSegments(30, (i) => `seg-${i}-` + 'x'.repeat(100));
    const map = await service.translateSegments(segments, makeOptions({ maxTokensPerRequest: 600, retries: 0 }));

    expect(provider.batches.length).toBeGreaterThan(1);
    const budget = Math.max(256, 600 - 512);
    const flat = provider.batches.flat();
    expect(flat).toHaveLength(30);
    for (const batch of provider.batches) {
      const cost = batch.reduce((sum, e) => sum + estimateTokens(e.text) + 8, 0);
      expect(cost).toBeLessThanOrEqual(budget);
      expect(batch.length).toBeLessThanOrEqual(100);
      expect(batch.length).toBeGreaterThan(0);
    }
    // Every id translated exactly once and the map order matches the input.
    expect(new Set(flat.map((e) => e.id)).size).toBe(30);
    expect([...map.keys()]).toEqual(segments.map((s) => s.id));
    for (const segment of segments) {
      expect(map.get(segment.id)).toBe(`tr:${segment.text}`);
    }
  });

  it('deduplicates identical segments into a single provider entry', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    const segments = ids.map((id) => ({ id, kind: 'paragraph', text: 'same text' }));
    const map = await service.translateSegments(segments, makeOptions({ retries: 0 }));
    expect(provider.batches.flat()).toHaveLength(1);
    expect(map.size).toBe(5);
    for (const id of ids) {
      expect(map.get(id)).toBe('tr:same text');
    }
    expect([...map.keys()]).toEqual(ids);
  });

  it('serves cache hits without the provider and refreshes on forceRefresh', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const cache = new MemoryTranslationCache();
    const segments = makeSegments(3, (i) => `text ${i}`);
    const opts = makeOptions({ retries: 0, cache });

    const first = await service.translateSegments(segments, opts);
    expect(provider.calls).toBe(1);

    const second = await service.translateSegments(segments, opts);
    expect(provider.calls).toBe(1); // fully served from cache
    expect(second).toEqual(first);

    const refreshed = await service.translateSegments(segments, { ...opts, forceRefresh: true });
    expect(provider.calls).toBe(2);
    expect(refreshed).toEqual(first);

    const third = await service.translateSegments(segments, opts);
    expect(provider.calls).toBe(2); // cache was updated by the refresh
    expect(third).toEqual(first);
  });

  it('reports monotonic progress ending at (total, total)', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const onProgress = vi.fn();
    const segments = makeSegments(10, (i) => `segment ${i}`.padEnd(100, 'x'));
    await service.translateSegments(segments, makeOptions({ retries: 0, maxTokensPerRequest: 600, onProgress }));

    expect(onProgress).toHaveBeenCalled();
    const calls = onProgress.mock.calls.map((c) => c as [number, number]);
    for (const [done, total] of calls) {
      expect(total).toBe(10);
      expect(done).toBeGreaterThanOrEqual(0);
      expect(done).toBeLessThanOrEqual(10);
    }
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i][0]).toBeGreaterThan(calls[i - 1][0]);
    }
    expect(calls[calls.length - 1]).toEqual([10, 10]);
  });

  it('reports (total, total) immediately when everything is cached', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const cache = new MemoryTranslationCache();
    const segments = makeSegments(3, (i) => `cached ${i}`);
    const opts = makeOptions({ cache });
    await service.translateSegments(segments, opts); // prime the cache
    const onProgress = vi.fn();
    await service.translateSegments(segments, { ...opts, onProgress });
    expect(provider.calls).toBe(1);
    expect(onProgress).toHaveBeenCalledWith(3, 3);
  });

  it('retries rate-limited failures then succeeds', async () => {
    const provider = new FakeProvider(0, 1, 'rate-limited');
    const service = new TranslationService(provider);
    const map = await service.translateSegments(makeSegments(1, () => 'text'), makeOptions({ retries: 1 }));
    expect(provider.calls).toBe(2);
    expect(map.get('s0')).toBe('tr:text');
  });

  it('gives up after retries and maps the final kind', async () => {
    const provider = new FakeProvider(0, 10, 'rate-limited');
    const service = new TranslationService(provider);
    await expect(
      service.translateSegments(makeSegments(1, () => 'text'), makeOptions({ retries: 2 })),
    ).rejects.toMatchObject({ kind: 'rate-limited' });
    expect(provider.calls).toBe(3);
  });

  it('does not retry auth failures', async () => {
    const provider = new FakeProvider(0, 5, 'auth');
    const service = new TranslationService(provider);
    await expect(
      service.translateSegments(makeSegments(1, () => 'text'), makeOptions({ retries: 2 })),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(provider.calls).toBe(1);
  });

  it('maps http 4xx to config without retrying', async () => {
    const provider = new FakeProvider(0, 5, 'http', 400);
    const service = new TranslationService(provider);
    await expect(
      service.translateSegments(makeSegments(1, () => 'text'), makeOptions({ retries: 2 })),
    ).rejects.toMatchObject({ kind: 'config', statusCode: 400 });
    expect(provider.calls).toBe(1);
  });

  it('retries http 5xx and maps the final failure to network', async () => {
    const provider = new FakeProvider(0, 10, 'http', 502);
    const service = new TranslationService(provider);
    await expect(
      service.translateSegments(makeSegments(1, () => 'text'), makeOptions({ retries: 2 })),
    ).rejects.toMatchObject({ kind: 'network', statusCode: 502 });
    expect(provider.calls).toBe(3);
  });

  it('treats a provider result with missing ids as a retryable invalid-response', async () => {
    const provider = new FakeProvider(0, 0, 'rate-limited', undefined, 1);
    const service = new TranslationService(provider);
    const segments = makeSegments(2, (i) => `text ${i}`);
    const map = await service.translateSegments(segments, makeOptions({ retries: 1 }));
    expect(provider.calls).toBe(2);
    expect(map.get('s0')).toBe('tr:text 0');
    expect(map.get('s1')).toBe('tr:text 1');
  });

  it('aborts quickly and forwards the signal to in-flight requests', async () => {
    const provider = new FakeProvider(50);
    const service = new TranslationService(provider);
    const segments = makeSegments(4, (i) => `y${i}-`.repeat(200));
    const controller = new AbortController();
    const start = Date.now();
    const promise = service.translateSegments(
      segments,
      makeOptions({ retries: 0, maxTokensPerRequest: 600, maxConcurrency: 2, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 60);
    await expect(promise).rejects.toMatchObject({ kind: 'aborted' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(controller.signal.aborted).toBe(true);
    expect(provider.signalsSeen.length).toBeGreaterThan(0);
    for (const signal of provider.signalsSeen) {
      expect(signal?.aborted).toBe(true);
    }
  });

  it('limits in-flight requests to maxConcurrency', async () => {
    const provider = new FakeProvider(40);
    const service = new TranslationService(provider);
    const segments = makeSegments(6, (i) => `z${i}-`.repeat(200));
    const start = Date.now();
    const map = await service.translateSegments(
      segments,
      makeOptions({ retries: 0, maxTokensPerRequest: 600, maxConcurrency: 3 }),
    );
    const elapsed = Date.now() - start;
    expect(map.size).toBe(6);
    expect(provider.calls).toBe(6);
    expect(provider.maxInFlight).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(3 * 40 + 200);
  });

  it('returns an empty map for empty input without calling the provider', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const onProgress = vi.fn();
    const map = await service.translateSegments([], makeOptions({ onProgress }));
    expect(map.size).toBe(0);
    expect(provider.calls).toBe(0);
    expect(onProgress).toHaveBeenCalledWith(0, 0);
  });

  it('passes whitespace-only segments through without API calls', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const segments: SegmentEntry[] = [
      { id: 'a', kind: 'paragraph', text: '   ' },
      { id: 'b', kind: 'paragraph', text: '\n\t' },
    ];
    const map = await service.translateSegments(segments, makeOptions());
    expect(map.get('a')).toBe('   ');
    expect(map.get('b')).toBe('\n\t');
    expect(provider.calls).toBe(0);
  });
});

describe('TranslationService.translateText', () => {
  it('translates a single text and respects the cache', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    const cache = new MemoryTranslationCache();
    const opts = makeOptions({ retries: 0, cache });
    expect(await service.translateText('hello', opts)).toBe('tr:hello');
    expect(provider.calls).toBe(1);
    expect(await service.translateText('hello', opts)).toBe('tr:hello');
    expect(provider.calls).toBe(1);
  });

  it('returns the original text for whitespace-only input without the provider', async () => {
    const provider = new FakeProvider();
    const service = new TranslationService(provider);
    expect(await service.translateText('   ', makeOptions())).toBe('   ');
    expect(provider.calls).toBe(0);
  });
});
