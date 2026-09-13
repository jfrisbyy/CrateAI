// Browser Supabase client (anon key, user session from cookies via @supabase/ssr).

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import type { Database } from "@/lib/types/db";

export type BrowserSupabase = SupabaseClient<Database>;

let cached: BrowserSupabase | null = null;

export function createClient(): BrowserSupabase {
  if (cached) return cached;
  const { url, anonKey } = publicEnv();
  cached = createBrowserClient<Database>(url, anonKey);
  return cached;
}
