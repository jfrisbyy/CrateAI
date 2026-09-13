// The memory strategy. A session with a dozen tracks of a four-minute record
// is half a gigabyte of Float32, so the cache has a budget and an eviction
// order from the start rather than after the first tab crash.

import { describe as group, expect, it, vi } from "vitest";
import { DecodeCache, decodedBytes, type DecodedSource } from "./decodeCache";
import { fakeDecoded } from "./fakes";

type Fake = ReturnType<typeof fakeDecoded>;

function cacheOf(maxBytes: number, sizes: Record<string, number>, hooks: { onReady?: (id: string) => void; onEvict?: (id: string) => void } = {}) {
  const loads: string[] = [];
  const cache = new DecodeCache<Fake["buffer"]>({
    maxBytes,
    load: async (id) => {
      loads.push(id);
      const durationS = sizes[id];
      if (durationS === undefined) throw new Error(`no such source: ${id}`);
      return fakeDecoded(durationS) as DecodedSource<Fake["buffer"]>;
    },
    ...hooks,
  });
  return { cache, loads };
}

const SECOND = decodedBytes(2, 44100); // one second of stereo

group("decoding", () => {
  it("decodes once and serves the rest from memory", async () => {
    const { cache, loads } = cacheOf(SECOND * 100, { a: 1 });
    const [first, second] = await Promise.all([cache.request("a"), cache.request("a")]);
    expect(first).toBe(second);
    await cache.request("a");
    expect(loads).toEqual(["a"]); // two concurrent callers and one later one, one decode
    expect(cache.has("a")).toBe(true);
  });

  it("remembers a failure instead of re-fetching a dead URL on every tick", async () => {
    const { cache, loads } = cacheOf(SECOND * 100, {});
    await expect(cache.request("gone")).rejects.toThrow("no such source");
    await expect(cache.request("gone")).rejects.toThrow("no such source");
    expect(loads).toEqual(["gone"]);
    expect(cache.failure("gone")).toContain("no such source");
    cache.forget("gone");
    await expect(cache.request("gone")).rejects.toThrow();
    expect(loads).toEqual(["gone", "gone"]); // forgetting is what a retry button does
  });

  it("tells the engine the moment samples land, so a late lane can join", async () => {
    const onReady = vi.fn();
    const { cache } = cacheOf(SECOND * 100, { a: 1 }, { onReady });
    expect(cache.isPending("a")).toBe(false);
    const pending = cache.request("a");
    expect(cache.isPending("a")).toBe(true);
    expect(cache.pending()).toEqual(["a"]);
    await pending;
    expect(onReady).toHaveBeenCalledWith("a");
    expect(cache.isPending("a")).toBe(false);
  });
});

group("the budget", () => {
  it("evicts the least recently used until it is back under budget", async () => {
    const onEvict = vi.fn();
    const { cache } = cacheOf(SECOND * 3, { a: 1, b: 1, c: 1, d: 1 }, { onEvict });
    await cache.request("a");
    await cache.request("b");
    await cache.request("c");
    expect(cache.order()).toEqual(["a", "b", "c"]);
    cache.get("a"); // touching a makes b the oldest
    await cache.request("d");
    expect(cache.has("b")).toBe(false);
    expect(cache.order()).toEqual(["c", "a", "d"]);
    expect(onEvict).toHaveBeenCalledWith("b");
    expect(cache.bytes).toBeLessThanOrEqual(cache.maxBytes);
  });

  it("never evicts a pinned source, however old it is", async () => {
    const { cache } = cacheOf(SECOND * 2, { song: 1, one: 1, two: 1 });
    await cache.request("song");
    cache.pin("song");
    await cache.request("one");
    await cache.request("two");
    expect(cache.has("song")).toBe(true); // in the session: held
    expect(cache.has("one")).toBe(false); // auditioned once: gone
    expect(cache.has("two")).toBe(true);
  });

  it("goes over budget rather than dropping the session, and says so", async () => {
    const { cache } = cacheOf(SECOND, { a: 1, b: 1 });
    cache.setPins(["a", "b"]); // both are in the session; neither may be dropped
    await cache.request("a");
    await cache.request("b");
    expect(cache.size).toBe(2);
    expect(cache.overBudget).toBe(true);
    cache.setPins([]);
    expect(cache.overBudget).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("counts bytes the way the decoded audio actually costs", () => {
    // four minutes of 44.1 kHz stereo really is 81 MB of Float32
    expect(decodedBytes(2, 44100 * 240) / (1024 * 1024)).toBeCloseTo(80.7, 1);
    expect(decodedBytes(0, 0)).toBe(0);
  });

  it("replacing a source does not double-count its bytes", async () => {
    const { cache } = cacheOf(SECOND * 100, { a: 1 });
    await cache.request("a");
    const before = cache.bytes;
    cache.put("a", fakeDecoded(1) as DecodedSource<Fake["buffer"]>);
    expect(cache.bytes).toBe(before);
    cache.forget("a");
    expect(cache.bytes).toBe(0);
  });

  it("peeking does not change the eviction order", async () => {
    const { cache } = cacheOf(SECOND * 100, { a: 1, b: 1 });
    await cache.request("a");
    await cache.request("b");
    cache.peek("a");
    expect(cache.order()).toEqual(["a", "b"]);
    cache.get("a");
    expect(cache.order()).toEqual(["b", "a"]);
  });
});
