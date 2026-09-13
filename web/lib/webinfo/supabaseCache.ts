// web_cache reads and writes with the service role. This is the only file
// under lib/webinfo that touches Supabase, and the only table it touches is
// web_cache (asserted by isolation.test.ts). No policies exist on the table,
// so the session client cannot read it; without a service-role key the cache
// degrades to memory.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tryAdminClient } from "@/lib/supabase/admin";
import { isFresh, MemoryWebCache, type CacheEntry, type WebCache } from "./cache";

type Row = { key: string; provider: string; kind: "search" | "fetch"; query: string; response: unknown; created_at: string };

class SupabaseWebCache implements WebCache {
  // web_cache is not in the hand-written Database generic (lib/types/db.ts is
  // not this seam's file), so this one table goes through the untyped client.
  constructor(private readonly client: SupabaseClient) {}

  async get(key: string): Promise<CacheEntry | null> {
    const { data, error } = await this.client
      .from("web_cache")
      .select("key, provider, kind, query, response, created_at")
      .eq("key", key)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Row;
    if (!isFresh(row.created_at, new Date())) return null;
    return row;
  }

  async set(entry: Omit<CacheEntry, "created_at">): Promise<void> {
    await this.client.from("web_cache").upsert({ ...entry, created_at: new Date().toISOString() }, { onConflict: "key" });
  }
}

let memory: MemoryWebCache | null = null;

export function createWebCache(): WebCache {
  const admin = tryAdminClient();
  if (admin) return new SupabaseWebCache(admin as unknown as SupabaseClient);
  memory ??= new MemoryWebCache();
  return memory;
}
