// The 24-hour query cache (BUILD_PACKET section 19, OPEN_QUESTIONS F.25).
// Keyed by sha256(provider + kind + normalized query) so the same question
// from two users costs one API call. This file is pure; the Supabase-backed
// implementation is in supabaseCache.ts.

import { createHash } from "node:crypto";

export type CacheKind = "search" | "fetch";

export interface CacheEntry {
  key: string;
  provider: string;
  kind: CacheKind;
  query: string;
  response: unknown;
  created_at: string;
}

export interface WebCache {
  get(key: string): Promise<CacheEntry | null>;
  set(entry: Omit<CacheEntry, "created_at">): Promise<void>;
}

export const WEB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function cacheKey(provider: string, kind: CacheKind, query: string): string {
  return createHash("sha256").update(`${provider}|${kind}|${normalizeQuery(query)}`).digest("hex");
}

export function isFresh(createdAt: string, now: Date, ttlMs = WEB_CACHE_TTL_MS): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now.getTime() - t < ttlMs;
}

/** In-memory cache for tests and for servers without a service-role key. */
export class MemoryWebCache implements WebCache {
  private readonly map = new Map<string, CacheEntry>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(key: string): Promise<CacheEntry | null> {
    const hit = this.map.get(key);
    if (!hit) return null;
    return isFresh(hit.created_at, this.now()) ? hit : null;
  }

  async set(entry: Omit<CacheEntry, "created_at">): Promise<void> {
    this.map.set(entry.key, { ...entry, created_at: this.now().toISOString() });
  }

  get size(): number {
    return this.map.size;
  }
}
