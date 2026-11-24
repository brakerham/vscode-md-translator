/**
 * Translation caches: a persistent Memento-backed cache with TTL and an
 * entry cap, and a plain in-memory cache for tests and fallback use.
 */
import type { Logger } from '../common/types';
import type { TranslationCache } from './types';

/** Structural subset of vscode.Memento so the cache stays testable. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** A single cached translation plus its write time. */
interface CacheEntryRecord {
  /** Translated text. */
  v: string;
  /** Epoch milliseconds of the last write. */
  t: number;
}

/** Persisted shape stored under {@link STORE_KEY} in the memento. */
interface CacheStore {
  version: 1;
  entries: Record<string, CacheEntryRecord>;
}

const STORE_KEY = 'markdownAiTranslator.translationCache';
const MAX_ENTRIES = 1500;
const MS_PER_DAY = 86400000;

/** Narrows an unknown memento value to a well-formed cache store. */
function isCacheStore(value: unknown): value is CacheStore {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const store = value as Partial<CacheStore>;
  return store.version === 1 && typeof store.entries === 'object' && store.entries !== null;
}

/** Memento-backed cache with TTL and an entry cap (oldest evicted first). */
export class PersistentTranslationCache implements TranslationCache {
  private store: CacheStore | undefined;
  private loaded = false;

  constructor(
    private readonly memento: MementoLike,
    private readonly ttlDays: number,
    private readonly logger?: Logger,
  ) {}

  get(key: string): string | undefined {
    this.ensureLoaded();
    const entries = this.store!.entries;
    const entry = entries[key];
    if (!entry || typeof entry.v !== 'string' || typeof entry.t !== 'number') {
      return undefined;
    }
    if (Date.now() - entry.t >= this.ttlDays * MS_PER_DAY) {
      // Expired: drop from the in-memory map; persisted on the next set/clear.
      delete entries[key];
      return undefined;
    }
    return entry.v;
  }

  set(key: string, value: string): void {
    this.ensureLoaded();
    const store = this.store!;
    store.entries[key] = { v: value, t: Date.now() };
    this.evictOldest();
    this.persist();
  }

  clear(): void {
    this.store = { version: 1, entries: {} };
    this.loaded = true;
    this.persist();
  }

  /** Loads the store from the memento on first access. */
  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const raw: unknown = this.memento.get<unknown>(STORE_KEY);
    this.store = isCacheStore(raw)
      ? { version: 1, entries: { ...raw.entries } }
      : { version: 1, entries: {} };
  }

  /** Keeps at most {@link MAX_ENTRIES} entries, dropping the oldest by t. */
  private evictOldest(): void {
    const entries = this.store!.entries;
    const keys = Object.keys(entries);
    if (keys.length <= MAX_ENTRIES) {
      return;
    }
    keys.sort((a, b) => entries[a].t - entries[b].t);
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
      delete entries[keys[i]];
    }
  }

  /** Fire-and-forget persistence (vscode Memento.update returns a Thenable). */
  private persist(): void {
    const snapshot: CacheStore = { version: 1, entries: { ...this.store!.entries } };
    try {
      Promise.resolve(this.memento.update(STORE_KEY, snapshot)).catch((err: unknown) => {
        this.logger?.warn(
          `Failed to persist the translation cache: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      // update may throw synchronously in some fake or broken implementations.
      this.logger?.warn(
        `Failed to persist the translation cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** In-memory cache used in tests and as a fallback. */
export class MemoryTranslationCache implements TranslationCache {
  private readonly map = new Map<string, string>();

  get(key: string): string | undefined {
    return this.map.get(key);
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }
}
