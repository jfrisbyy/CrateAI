// Service-role client. Server only; bypasses RLS. Used exactly where
// docs/CONTRACTS.md says: the dispatch step (storing the compute call id).

import "server-only";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/lib/types/db";

export type AdminSupabase = SupabaseClient<Database>;

let cached: AdminSupabase | null = null;

/** The admin client, or null when SUPABASE_SERVICE_ROLE_KEY is not set. */
export function tryAdminClient(): AdminSupabase | null {
  if (cached) return cached;
  const key = serverEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) return null;
  const { url } = publicEnv();
  cached = createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return cached;
}

export function createAdminClient(): AdminSupabase {
  const client = tryAdminClient();
  if (!client) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set; the admin client is unavailable.");
  }
  return client;
}
