import { describe, expect, it } from 'vitest';
import {
  MemoryTranslationCache,
  PersistentTranslationCache,
  type MementoLike,
} from '../src/translation/cache';

const STORE_KEY = 'markdownAiTranslator.translationCache';

interface PersistedStore {
  version: number;
  entries: Record<string, { v: string; t: number }>;
}

/** In-memory fake of vscode.Memento. */
class FakeMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  raw(key: string): unknown {
    return this.values.get(key);
  }

  writeRaw(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('MemoryTranslationCache', () => {
  it('round-trips values and overwrites existing keys', () => {
    const cache = new MemoryTranslationCache();
    expect(cache.get('missing')).toBeUndefined();
    cache.set('k', 'v1');
    expect(cache.get('k')).toBe('v1');
    cache.set('k', 'v2');
    expect(cache.get('k')).toBe('v2');
  });

  it('clears all entries', () => {
    const cache = new MemoryTranslationCache();
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('PersistentTranslationCache', () => {
  it('round-trips values and persists the expected shape', () => {
    const memento = new FakeMemento();
    const cache = new PersistentTranslationCache(memento, 30);
    expect(cache.get('missing')).toBeUndefined();
    cache.set('k', 'hello');
    expect(cache.get('k')).toBe('hello');

    const raw = memento.raw(STORE_KEY) as PersistedStore;
    expect(raw.version).toBe(1);
    expect(raw.entries.k.v).toBe('hello');
    expect(typeof raw.entries.k.t).toBe('number');
    expect(raw.entries.k.t).toBeLessThanOrEqual(Date.now());
  });

  it('reloads entries from the memento across instances', () => {
    const memento = new FakeMemento();
    const first = new PersistentTranslationCache(memento, 30);
    first.set('a', 'A');
    const second = new PersistentTranslationCache(memento, 30);
    expect(second.get('a')).toBe('A');
  });

  it('expires entries after the TTL', async () => {
    const memento = new FakeMemento();
    const ttlDays = 1 / 86400; // ~1 second
    const cache = new PersistentTranslationCache(memento, ttlDays);
    cache.set('k', 'value');
    expect(cache.get('k')).toBe('value');
    await wait(1200);
    expect(cache.get('k')).toBeUndefined();
    // A fresh instance reading the same memento also sees it as expired.
    const second = new PersistentTranslationCache(memento, ttlDays);
    expect(second.get('k')).toBeUndefined();
  });

  it('evicts the oldest entries above the cap', () => {
    const memento = new FakeMemento();
    const cache = new PersistentTranslationCache(memento, 30);
    for (let i = 0; i < 1550; i++) {
      cache.set(`k${i}`, `v${i}`);
    }
    const raw = memento.raw(STORE_KEY) as PersistedStore;
    const keys = Object.keys(raw.entries);
    expect(keys.length).toBeLessThanOrEqual(1500);
    expect(raw.entries.k1549).toBeDefined(); // newest is present
    expect(raw.entries.k0).toBeUndefined(); // oldest was evicted
    expect(cache.get('k1549')).toBe('v1549');
    expect(cache.get('k0')).toBeUndefined();
  });

  it('clear empties the cache and persists', () => {
    const memento = new FakeMemento();
    const cache = new PersistentTranslationCache(memento, 30);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    const raw = memento.raw(STORE_KEY) as PersistedStore;
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.entries)).toHaveLength(0);
  });

  it('loads lazily and tolerates a corrupt or missing store', () => {
    const corrupt = new FakeMemento();
    corrupt.writeRaw(STORE_KEY, { version: 99, entries: 'not an object' });
    const cache = new PersistentTranslationCache(corrupt, 30);
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', 'fresh');
    expect(cache.get('k')).toBe('fresh');

    const missing = new FakeMemento();
    const empty = new PersistentTranslationCache(missing, 30);
    expect(empty.get('k')).toBeUndefined();
  });
});
