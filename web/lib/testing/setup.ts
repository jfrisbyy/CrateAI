// Shared vitest setup (vitest.config.ts `setupFiles`).
//
// Route handlers reach Supabase through exactly two modules; both are pointed
// at the world the test created, so a handler imported normally gets the
// double from its own `requireUser()` and its own `tryAdminClient()`. Tests
// that never call `createWorld()` are untouched: nothing here runs until one
// of those functions is called.

import { afterEach, vi } from "vitest";
import { resetWorld } from "./world";

vi.mock("@/lib/supabase/server", async () => {
  const { activeWorld } = await import("./world");
  return {
    createClient: async () => activeWorld().client().asServerClient(),
  };
});

vi.mock("@/lib/supabase/admin", async () => {
  const { activeWorld } = await import("./world");
  return {
    tryAdminClient: () => activeWorld().admin()?.asServerClient() ?? null,
    createAdminClient: () => {
      const admin = activeWorld().admin();
      if (!admin) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set; the admin client is unavailable.");
      return admin.asServerClient();
    },
  };
});

afterEach(() => {
  resetWorld();
});
