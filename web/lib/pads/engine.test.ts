import { describe, expect, it } from "vitest";
import { PAD_FADE_S, PAD_RELEASE_S, PadEngine } from "./engine";
import { FakePadBackend } from "./fakes";

function engineWith(ready: Record<string, number> = { chop: 1.5 }): { engine: PadEngine; backend: FakePadBackend } {
  const backend = new FakePadBackend(ready);
  return { engine: new PadEngine(backend), backend };
}

describe("PadEngine, one-shot", () => {
  it("starts a voice at the audio clock and leaves it alone when the key comes up", () => {
    const { engine, backend } = engineWith();
    backend.clock = 12.5;
    const voice = engine.noteOn(1, "chop", { trigger: "one-shot" });
    expect(voice?.at).toBe(12.5);
    expect(backend.started).toHaveLength(1);
    expect(backend.started[0]).toMatchObject({ pad: 1, fileId: "chop", rate: 1, gate: false, attackS: PAD_FADE_S });
    expect(engine.noteOff(1, { trigger: "one-shot" })).toBe(0);
    expect(backend.released).toHaveLength(0);
    expect(engine.isLit(1)).toBe(true);
  });

  it("is silent, not late, when the slice has not decoded", () => {
    const { engine, backend } = engineWith({});
    expect(engine.noteOn(1, "chop")).toBeNull();
    expect(backend.started).toHaveLength(0);
    expect(engine.isLit(1)).toBe(false);
  });

  it("keeps Phase 3's trigger(): the clock time, or null", () => {
    const { engine, backend } = engineWith();
    backend.clock = 4;
    expect(engine.trigger(2, "chop", 0.5)).toBe(4);
    expect(backend.started[0]?.gain).toBe(0.5);
    expect(engine.trigger(2, "missing")).toBeNull();
  });

  it("is polyphonic in software: two pads at once, both lit", () => {
    const { engine } = engineWith({ a: 1, b: 1 });
    engine.noteOn(1, "a");
    engine.noteOn(2, "b");
    expect(engine.litPads().sort((x, y) => x - y)).toEqual([1, 2]);
    expect(engine.voiceCount()).toBe(2);
  });

  it("clears a pad when its voice ends by itself", () => {
    const { engine, backend } = engineWith();
    const voice = engine.noteOn(1, "chop");
    backend.finish(voice?.voiceId as number);
    expect(engine.isLit(1)).toBe(false);
    expect(engine.voiceCount()).toBe(0);
  });
});

describe("PadEngine, gate", () => {
  it("cuts on the key release with a 2 ms fade, never a hard stop", () => {
    const { engine, backend } = engineWith();
    engine.noteOn(1, "chop", { trigger: "gate" });
    expect(backend.started[0]?.gate).toBe(true);
    backend.clock = 0.4;
    expect(engine.noteOff(1, { trigger: "gate" })).toBe(1);
    expect(backend.released).toEqual([{ voiceId: 1, fadeS: PAD_RELEASE_S, at: 0.4 }]);
    expect(backend.stopped).toEqual([]);
    expect(engine.isLit(1)).toBe(false);
  });

  it("releases every voice on that pad and no other pad's", () => {
    const { engine, backend } = engineWith({ a: 1, b: 1 });
    engine.noteOn(1, "a", { trigger: "gate" });
    engine.noteOn(1, "a", { trigger: "gate" });
    engine.noteOn(2, "b", { trigger: "gate" });
    expect(engine.noteOff(1, { trigger: "gate" })).toBe(2);
    expect(backend.released.map((r) => r.voiceId)).toEqual([1, 2]);
    expect(engine.isLit(2)).toBe(true);
  });

  it("releases everything sounding when focus is lost mid-hold", () => {
    const { engine, backend } = engineWith({ a: 1, b: 1 });
    engine.noteOn(1, "a", { trigger: "gate" });
    engine.noteOn(5, "b", { trigger: "gate" });
    expect(engine.releaseAll()).toBe(2);
    expect(backend.released).toHaveLength(2);
    expect(backend.released.every((r) => r.fadeS === PAD_RELEASE_S)).toBe(true);
    expect(engine.litPads()).toEqual([]);
  });

  it("a release with nothing sounding is a no-op", () => {
    const { engine, backend } = engineWith();
    expect(engine.noteOff(7, { trigger: "gate" })).toBe(0);
    expect(engine.releaseAll()).toBe(0);
    expect(backend.released).toHaveLength(0);
  });
});

describe("PadEngine, note mode", () => {
  it("transposes by resampling, and the voice is exactly that much shorter", () => {
    const { engine, backend } = engineWith({ stab: 2 });
    const up = engine.noteOn(9, "stab", { semitones: 12 });
    expect(backend.started[0]?.rate).toBeCloseTo(2, 12);
    expect(up?.durationS).toBeCloseTo(1, 12);
    const down = engine.noteOn(7, "stab", { semitones: -12 });
    expect(backend.started[1]?.rate).toBeCloseTo(0.5, 12);
    expect(down?.durationS).toBeCloseTo(4, 12);
  });

  it("plays at rate 1 with no transposition asked for", () => {
    const { engine, backend } = engineWith();
    engine.noteOn(3, "chop");
    expect(backend.started[0]?.rate).toBe(1);
  });
});

describe("PadEngine, loading", () => {
  it("shares one decode between concurrent callers and reports the status", async () => {
    const backend = new FakePadBackend();
    const engine = new PadEngine(backend);
    let urls = 0;
    const getUrl = async () => {
      urls++;
      return "https://example.test/a.wav";
    };
    const a = engine.load("late", getUrl);
    const b = engine.load("late", getUrl);
    expect(a).toBe(b);
    await Promise.resolve();
    expect(engine.status("late")).toBe("loading");
    backend.makeReady("late", 0.75);
    expect(await a).toBe(0.75);
    expect(engine.status("late")).toBe("ready");
    expect(engine.durationOf("late")).toBe(0.75);
    expect(urls).toBe(1);
  });

  it("remembers a failure and says why, and forget() lets a retry try again", async () => {
    const backend = new FakePadBackend();
    const engine = new PadEngine(backend);
    await expect(engine.load("bad", () => Promise.reject(new Error("Could not fetch the audio (404).")))).rejects.toThrow("404");
    expect(engine.status("bad")).toBe("error");
    expect(engine.errorFor("bad")).toContain("404");
    engine.forget("bad");
    expect(engine.status("bad")).toBeNull();
  });

  it("tells its listeners when anything changes", () => {
    const { engine } = engineWith();
    let changes = 0;
    const off = engine.onChange(() => changes++);
    engine.noteOn(1, "chop");
    expect(changes).toBeGreaterThan(0);
    off();
    const before = changes;
    engine.noteOn(2, "chop");
    expect(changes).toBe(before);
  });

  it("stays usable after dispose, because React remounts effects in development", () => {
    const { engine, backend } = engineWith();
    engine.noteOn(1, "chop");
    engine.dispose();
    expect(backend.disposed).toBe(true);
    expect(engine.litPads()).toEqual([]);
    backend.makeReady("chop", 1);
    expect(engine.noteOn(1, "chop")).not.toBeNull();
  });
});
