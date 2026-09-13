// Text -> CLAP vector through compute (docs/CONTRACTS.md section 10):
//   POST {COMPUTE_DISPATCH_URL}/embed_text, bearer COMPUTE_DISPATCH_SECRET,
//   { texts } -> { ok, model, dim, vectors }.
// Server-side only: the secret is passed in by lib/search/server.ts. Every
// failure becomes EmbedUnavailableError so the search can fall back to
// filters and name matches and say why.

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface EmbedResult {
  model: string;
  dim: number;
  vectors: number[][];
}

export class EmbedUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`text search needs the embed job / compute: ${reason}`);
    this.name = "EmbedUnavailableError";
  }
}

export interface EmbedDeps {
  baseUrl: string | undefined;
  secret: string | undefined;
  fetcher: Fetcher;
  timeoutMs?: number;
}

export const EMBED_TIMEOUT_MS = 20_000;
export const MAX_EMBED_TEXTS = 32;
export const MAX_EMBED_TEXT_CHARS = 500;

export async function embedText(texts: string[], deps: EmbedDeps): Promise<EmbedResult> {
  if (!deps.baseUrl) throw new EmbedUnavailableError("compute not configured");
  const clipped = texts.slice(0, MAX_EMBED_TEXTS).map((t) => t.slice(0, MAX_EMBED_TEXT_CHARS));
  let res: Response;
  try {
    res = await deps.fetcher(`${deps.baseUrl.replace(/\/+$/, "")}/embed_text`, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.secret ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify({ texts: clipped }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? EMBED_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new EmbedUnavailableError(`compute unreachable (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.status === 503) throw new EmbedUnavailableError("no text embedder on that runner");
  if (!res.ok) throw new EmbedUnavailableError(`compute returned ${res.status}`);
  const body = (await res.json().catch(() => null)) as { ok?: boolean; model?: unknown; dim?: unknown; vectors?: unknown } | null;
  if (!body || body.ok !== true || typeof body.model !== "string" || !Array.isArray(body.vectors)) {
    throw new EmbedUnavailableError("compute returned an unexpected response");
  }
  const vectors = body.vectors as number[][];
  if (vectors.length !== clipped.length) throw new EmbedUnavailableError("compute returned the wrong number of vectors");
  return { model: body.model, dim: typeof body.dim === "number" ? body.dim : (vectors[0]?.length ?? 0), vectors };
}
