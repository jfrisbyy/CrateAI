// Environment access. Everything is read lazily so `next build` succeeds with
// no .env.local; a missing variable fails at the request that needs it, with
// the variable's name in the message.

export class EnvError extends Error {
  constructor(name: string) {
    super(`Missing environment variable ${name}. Copy web/.env.example to web/.env.local and fill it in.`);
    this.name = "EnvError";
  }
}

/** The two public Supabase values. Referenced literally so Next can inline them in client bundles. */
export function publicEnv(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url) throw new EnvError("NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) throw new EnvError("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return { url, anonKey };
}

export function hasPublicEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** Server-only optional variables. Never call from client code. */
export function serverEnv(name: "SUPABASE_SERVICE_ROLE_KEY" | "COMPUTE_DISPATCH_URL" | "COMPUTE_DISPATCH_SECRET" | "ANTHROPIC_API_KEY"): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
