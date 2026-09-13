// What this product costs to run, as arithmetic instead of a feeling.
//
// Every number below is a list price or a measured token count, each with the
// place it came from written next to it. `limits.ts` sets the plan caps from
// these; `/api/usage` and the account page show spend against them; and
// `docs/HANDOFF_launch_readiness.md` shows the same arithmetic in prose. If a
// price moves, it moves here and everything else follows.
//
// The numbers are estimates of *our* cost (COGS), never a price to a user.

// ---------------------------------------------------------------------------
// model prices
// ---------------------------------------------------------------------------

/** The models this product calls. Routing and the reasons for it: `lib/anthropic/models.ts`. */
export type ModelId = "claude-opus-5" | "claude-sonnet-5";

/** Anthropic list prices, US dollars per million tokens (checked 2026-09-13). */
export const MODEL_PRICES_USD_PER_MTOK: Record<ModelId, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
};

/** Prompt caching, 5-minute TTL: a write costs 1.25x base input, a read 0.1x. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface ModelPrices {
  /** per million tokens */
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

export function modelPrices(model: ModelId): ModelPrices {
  const base = MODEL_PRICES_USD_PER_MTOK[model];
  return {
    input: base.input,
    output: base.output,
    cache_write: base.input * CACHE_WRITE_MULTIPLIER,
    cache_read: base.input * CACHE_READ_MULTIPLIER,
  };
}

// ---------------------------------------------------------------------------
// the shape of one chat turn
// ---------------------------------------------------------------------------

/**
 * What a chat turn actually sends. The two prefix numbers are measured from
 * this repository (see `promptBudget.test.ts`, which fails if the prompt grows
 * past them); the rest are the working assumptions the tier arithmetic uses,
 * each stated so it can be argued with.
 */
export const CHAT_TURN_SHAPE = {
  /**
   * Tools then the frozen system prompt: the cacheable prefix, in render
   * order, everything before the last `cache_control` breakpoint.
   * `JSON.stringify(CHAT_TOOLS)` is ~16.9k characters and `SYSTEM_PROMPT`
   * ~5.0k; at the usual ratios that is ~5,300 + ~1,350 tokens. Rounded up to
   * leave room for a tool or a paragraph; `promptBudget.test.ts` fails if the
   * real thing outgrows it.
   */
  cached_prefix_tokens: 7_000,
  /**
   * Everything after the breakpoint: the per-request context block (the
   * attached files and the open file's compact report, ~400-1,000), the
   * recent history the route replays (~2,000) and the question (~100).
   */
  fresh_input_tokens: 3_000,
  /** A full answer with a card or two. */
  output_tokens: 1_000,
  /**
   * One user message is one metered turn, but a turn that uses tools makes one
   * model call per round (`MAX_TOOL_ITERATIONS` allows 12). Most turns are one
   * call; a "find the drums, separate them, chop them" sentence is four. 1.5
   * is the blend the projections use.
   */
  model_calls_per_turn: 1.5,
  /**
   * Share of model calls that read the cached prefix rather than write it. The
   * 5-minute entry survives inside a session and between turns a producer
   * sends back to back; the first call of a session pays the write.
   */
  cache_hit_rate: 0.7,
} as const;

export interface TurnShape {
  cached_prefix_tokens: number;
  fresh_input_tokens: number;
  output_tokens: number;
}

/** One model call: the cached prefix read or written, the fresh tail, the answer. */
export function modelCallUsd(model: ModelId, shape: TurnShape, opts: { cached: boolean }): number {
  const p = modelPrices(model);
  const prefix = (shape.cached_prefix_tokens / 1e6) * (opts.cached ? p.cache_read : p.cache_write);
  const fresh = (shape.fresh_input_tokens / 1e6) * p.input;
  const output = (shape.output_tokens / 1e6) * p.output;
  return prefix + fresh + output;
}

/** The same call with no caching at all: the whole prompt at full input price. */
export function uncachedModelCallUsd(model: ModelId, shape: TurnShape): number {
  const p = modelPrices(model);
  return ((shape.cached_prefix_tokens + shape.fresh_input_tokens) / 1e6) * p.input + (shape.output_tokens / 1e6) * p.output;
}

export interface TurnCostOptions {
  /** false models the path with no `cache_control` at all (what the packet costed) */
  caching?: boolean;
  shape?: TurnShape;
  modelCallsPerTurn?: number;
  cacheHitRate?: number;
}

/** One metered chat turn, blended over cache hits and tool rounds. */
export function chatTurnUsd(model: ModelId, opts: TurnCostOptions = {}): number {
  const shape = opts.shape ?? CHAT_TURN_SHAPE;
  const calls = opts.modelCallsPerTurn ?? CHAT_TURN_SHAPE.model_calls_per_turn;
  if (opts.caching === false) return uncachedModelCallUsd(model, shape) * calls;
  const hit = opts.cacheHitRate ?? CHAT_TURN_SHAPE.cache_hit_rate;
  const perCall = hit * modelCallUsd(model, shape, { cached: true }) + (1 - hit) * modelCallUsd(model, shape, { cached: false });
  return perCall * calls;
}

// ---------------------------------------------------------------------------
// everything else a metered account can spend
// ---------------------------------------------------------------------------

/**
 * Unit costs for the meters that are not model tokens. List prices, checked
 * 2026-09-13; re-check them before they are used to set a price.
 */
export const UNIT_COSTS_USD = {
  /** One `web_search` event: Brave Search API, ~$5 per 1,000 queries. */
  web_search: 0.005,
  /** One GPU second on the A10G the separation job asks for (~$1.10/hour). */
  gpu_second: 0.000306,
  /** One CPU second on the compute runner, memory included (~2 cores, 4 GiB). */
  cpu_second: 0.000035,
  /** One GiB-month of Supabase storage. */
  storage_gib_month: 0.021,
} as const;

export const GIB = 1024 * 1024 * 1024;

/** What one chat turn costs on the model chat is routed to. Re-exported for the docs and the UI. */
export function chatTurnCostUsd(model: ModelId): number {
  return chatTurnUsd(model);
}

export interface SpendInput {
  chat_turns_month: number;
  web_searches_month: number;
  gpu_seconds_month: number;
  cpu_seconds_month: number;
  storage_bytes: number;
}

export interface SpendEstimate {
  chat_usd: number;
  web_search_usd: number;
  compute_usd: number;
  storage_usd: number;
  total_usd: number;
}

/**
 * The account's estimated cost this month. Stem jobs are deliberately absent:
 * a separation's real cost is its GPU seconds, which are already metered, and
 * `stem_jobs_per_month` is a quota counter, not a second cost line.
 */
export function estimateSpendUsd(input: SpendInput, model: ModelId): SpendEstimate {
  const chat_usd = input.chat_turns_month * chatTurnUsd(model);
  const web_search_usd = input.web_searches_month * UNIT_COSTS_USD.web_search;
  const compute_usd = input.gpu_seconds_month * UNIT_COSTS_USD.gpu_second + input.cpu_seconds_month * UNIT_COSTS_USD.cpu_second;
  const storage_usd = (input.storage_bytes / GIB) * UNIT_COSTS_USD.storage_gib_month;
  return { chat_usd, web_search_usd, compute_usd, storage_usd, total_usd: chat_usd + web_search_usd + compute_usd + storage_usd };
}

/** Dollars, to the cent, with a sub-cent floor so "$0.00" never hides real spend. */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}
