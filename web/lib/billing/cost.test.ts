// The arithmetic behind the tiers. If a price moves or a cap moves, one of
// these fails and docs/HANDOFF_launch_readiness.md has to be re-done with it.

import { describe, expect, it } from "vitest";
import { CHAT_MODEL, QUERY_PARSER_MODEL } from "@/lib/anthropic/models";
import { NARRATION_MODEL } from "@/lib/anthropic/narrate";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  CHAT_TURN_SHAPE,
  chatTurnUsd,
  estimateSpendUsd,
  formatUsd,
  GIB,
  MODEL_PRICES_USD_PER_MTOK,
  modelCallUsd,
  modelPrices,
  uncachedModelCallUsd,
} from "./cost";
import { PLAN_LIMITS, planCeilingUsd } from "./limits";

describe("model prices", () => {
  it("carries the published rates and the cache multipliers", () => {
    expect(MODEL_PRICES_USD_PER_MTOK["claude-opus-5"]).toEqual({ input: 5, output: 25 });
    expect(MODEL_PRICES_USD_PER_MTOK["claude-sonnet-5"]).toEqual({ input: 2, output: 10 });
    expect(CACHE_WRITE_MULTIPLIER).toBe(1.25);
    expect(CACHE_READ_MULTIPLIER).toBe(0.1);
    const sonnet = modelPrices("claude-sonnet-5");
    expect(sonnet.cache_write).toBeCloseTo(2.5, 6);
    expect(sonnet.cache_read).toBeCloseTo(0.2, 6);
  });
});

describe("what a chat turn costs", () => {
  it("prices one uncached Opus 5 call the way the packet costed it", () => {
    // 10,000 input at $5/MTok + 1,000 output at $25/MTok
    expect(uncachedModelCallUsd("claude-opus-5", CHAT_TURN_SHAPE)).toBeCloseTo(0.075, 6);
  });

  it("reads the cached prefix back for a tenth of the input price", () => {
    const warm = modelCallUsd("claude-sonnet-5", CHAT_TURN_SHAPE, { cached: true });
    const cold = modelCallUsd("claude-sonnet-5", CHAT_TURN_SHAPE, { cached: false });
    expect(warm).toBeCloseTo(0.0174, 5);
    expect(cold).toBeCloseTo(0.0335, 4);
    // a write costs more than a read; two requests pay it back
    expect(cold).toBeGreaterThan(warm);
    expect(cold + warm).toBeLessThan(2 * uncachedModelCallUsd("claude-sonnet-5", CHAT_TURN_SHAPE));
  });

  it("puts a metered turn on the launch routing at about three cents", () => {
    const after = chatTurnUsd(CHAT_MODEL);
    const before = chatTurnUsd("claude-opus-5", { caching: false });
    expect(after).toBeCloseTo(0.033, 3);
    expect(before).toBeCloseTo(0.1125, 4);
    // the whole point of the exercise: at least two thirds off
    expect(after).toBeLessThan(before / 3);
  });

  it("routes the cheap paths to the cheap model and the prose to Opus", () => {
    expect(CHAT_MODEL).toBe("claude-sonnet-5");
    expect(QUERY_PARSER_MODEL).toBe("claude-sonnet-5");
    expect(NARRATION_MODEL).toBe("claude-opus-5");
  });
});

describe("what an account costs", () => {
  it("adds the metered lines and leaves stem jobs out of the money", () => {
    const spend = estimateSpendUsd(
      { chat_turns_month: 10, web_searches_month: 10, gpu_seconds_month: 600, cpu_seconds_month: 1200, storage_bytes: 2 * GIB },
      CHAT_MODEL,
    );
    expect(spend.chat_usd).toBeCloseTo(10 * chatTurnUsd(CHAT_MODEL), 6);
    expect(spend.web_search_usd).toBeCloseTo(0.05, 6);
    expect(spend.compute_usd).toBeCloseTo(600 * 0.000306 + 1200 * 0.000035, 6);
    expect(spend.storage_usd).toBeCloseTo(0.042, 6);
    expect(spend.total_usd).toBeCloseTo(spend.chat_usd + spend.web_search_usd + spend.compute_usd + spend.storage_usd, 9);
  });

  it("costs nothing for an account that has done nothing", () => {
    const spend = estimateSpendUsd(
      { chat_turns_month: 0, web_searches_month: 0, gpu_seconds_month: 0, cpu_seconds_month: 0, storage_bytes: 0 },
      CHAT_MODEL,
    );
    expect(spend.total_usd).toBe(0);
    expect(formatUsd(spend.total_usd)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

describe("the tiers are affordable", () => {
  const turn = chatTurnUsd(CHAT_MODEL);

  it("caps a free account that uses every last allowance at about two dollars a month", () => {
    const ceiling = planCeilingUsd("free", turn);
    expect(ceiling).toBeLessThan(2.5);
    // twenty of them is a number a bootstrapped owner can absorb
    expect(ceiling * 20).toBeLessThan(50);
  });

  it("keeps a fully used pro account under what pro has to be priced at", () => {
    expect(planCeilingUsd("pro", turn)).toBeLessThan(25);
  });

  it("would not have been affordable on the old free tier", () => {
    // 50 turns a day, every day, on Opus 5 with nothing cached
    const old = 50 * 30 * chatTurnUsd("claude-opus-5", { caching: false });
    expect(old).toBeGreaterThan(100);
    expect(planCeilingUsd("free", turn)).toBeLessThan(old / 50);
  });

  it("keeps every free cap at or under the matching pro cap", () => {
    for (const key of Object.keys(PLAN_LIMITS.free) as Array<keyof typeof PLAN_LIMITS.free>) {
      expect(PLAN_LIMITS.free[key]).toBeLessThanOrEqual(PLAN_LIMITS.pro[key]);
    }
  });
});
