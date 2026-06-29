/**
 * Tiny L1 in-memory cache with TTL + LRU. No Redis dependency in v1.
 * Phase 3 may add a Redis-backed implementation behind the same interface.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): void;
  has(key: string): boolean;
  del(key: string): void;
  clear(): void;
  size(): number;
}

export class MemoryCache implements Cache {
  private map = new Map<string, CacheEntry<unknown>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(opts: { maxEntries?: number; defaultTtlMs?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.defaultTtlMs = opts.defaultTtlMs ?? 1000 * 60 * 30; // 30 min
  }

  get<T>(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs?: number): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  del(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}
