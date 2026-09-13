// Server Supabase client for server components and route handlers. Reads the
// session from the request cookies; RLS scopes every query to the caller.

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { publicEnv } from "@/lib/env";
import type { Database } from "@/lib/types/db";

export type ServerSupabase = SupabaseClient<Database>;

export async function createClient(): Promise<ServerSupabase> {
  const { url, anonKey } = publicEnv();
  const cookieStore = await cookies();
  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: cookies are read-only there. The
          // middleware refreshes sessions, so this is safe to ignore.
        }
      },
    },
  });
}
