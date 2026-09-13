import { describe, expect, it } from "vitest";
import { chatTurnsLeft, FREE_TIER, readUsage, startOfUtcDay, webSearchesIn, webSearchesLeft } from "./limits";

describe("free-tier limits", () => {
  it("keeps the packet's numbers as constants", () => {
    expect(FREE_TIER.chat_turns_per_day).toBe(50);
    expect(FREE_TIER.web_searches_per_day).toBe(20);
    expect(FREE_TIER.stem_jobs_per_month).toBe(5);
    expect(FREE_TIER.storage_bytes).toBe(2 * 1024 ** 3);
  });

  it("counts web searches from recorded tool calls", () => {
    expect(webSearchesIn(null)).toBe(0);
    expect(webSearchesIn([{ name: "get_report" }, { name: "web_search" }, { name: "identify_context", searches: 4 }, { name: "identify_context" }])).toBe(6);
    expect(webSearchesIn([{ name: "batch", nested: [{ name: "web_search" }, { name: "web_search" }] }])).toBe(2);
  });

  it("reads today's usage from the sources and computes what is left", async () => {
    const now = new Date("2026-09-13T15:30:00Z");
    expect(startOfUtcDay(now).toISOString()).toBe("2026-09-13T00:00:00.000Z");
    const asked: string[] = [];
    const usage = await readUsage(
      {
        countUserMessagesSince: async (iso) => {
          asked.push(iso);
          return 48;
        },
        listToolCallsSince: async () => [[{ name: "web_search" }], null, [{ name: "identify_context", searches: 5 }]],
      },
      now,
    );
    expect(asked).toEqual(["2026-09-13T00:00:00.000Z"]);
    expect(usage).toEqual({ chat_turns_today: 48, web_searches_today: 6, day_start: "2026-09-13T00:00:00.000Z" });
    expect(chatTurnsLeft(usage)).toBe(2);
    expect(webSearchesLeft(usage)).toBe(14);
    expect(chatTurnsLeft({ ...usage, chat_turns_today: 500 })).toBe(0);
  });
});
