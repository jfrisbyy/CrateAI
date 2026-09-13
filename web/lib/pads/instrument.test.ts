import { describe, expect, it } from "vitest";
import { PadEngine } from "./engine";
import { FakePadBackend } from "./fakes";
import { PadInstrument, type InstrumentHit, type InstrumentRelease } from "./instrument";
import { defaultKit, setLayout, setPlay, setRootPad, setTrigger, type PadKit } from "./kit";

function rig(options: { kit?: PadKit; files?: Record<number, string>; ready?: Record<string, number> } = {}) {
  const ready = options.ready ?? { "file-1": 1, "file-2": 1, "file-8": 2 };
  const backend = new FakePadBackend(ready);
  const engine = new PadEngine(backend);
  let kit = options.kit ?? defaultKit();
  const files = options.files ?? { 1: "file-1", 2: "file-2", 8: "file-8" };
  const hits: InstrumentHit[] = [];
  const releases: InstrumentRelease[] = [];
  const instrument = new PadInstrument({
    engine,
    kit: () => kit,
    fileForPad: (pad) => files[pad] ?? null,
    now: () => backend.clock,
    onHit: (h) => hits.push(h),
    onRelease: (r) => releases.push(r),
  });
  return {
    backend,
    engine,
    instrument,
    hits,
    releases,
    setKit(next: PadKit) {
      kit = next;
    },
    get kit() {
      return kit;
    },
  };
}

describe("PadInstrument, key repeat", () => {
  it("ignores the OS repeat of a held key: one press, one voice", () => {
    const r = rig();
    expect(r.instrument.press(1, { repeat: false })).toBe("started");
    expect(r.instrument.press(1, { repeat: true })).toBe("repeat");
    expect(r.instrument.press(1, { repeat: true })).toBe("repeat");
    expect(r.backend.started).toHaveLength(1);
    expect(r.hits).toHaveLength(1);
  });

  it("ignores a repeat even when the browser does not flag it", () => {
    const r = rig();
    r.instrument.press(1);
    expect(r.instrument.press(1)).toBe("repeat");
    expect(r.backend.started).toHaveLength(1);
  });

  it("plays again after the key really comes up", () => {
    const r = rig({ kit: setTrigger(defaultKit(), "gate") });
    r.instrument.press(1);
    r.instrument.release(1);
    expect(r.instrument.press(1)).toBe("started");
    expect(r.backend.started).toHaveLength(2);
  });
});

describe("PadInstrument, gate and one-shot", () => {
  it("gate cuts the voice on the key up and reports how long the key was held", () => {
    const r = rig({ kit: setTrigger(defaultKit(), "gate") });
    r.instrument.press(1);
    r.backend.clock = 0.25;
    expect(r.instrument.release(1)).toBe(true);
    expect(r.backend.released).toHaveLength(1);
    expect(r.releases[0]).toMatchObject({ pad: 1, heldS: 0.25, gate: true });
  });

  it("one-shot ignores the key up entirely, and its hold time is not a note length", () => {
    const r = rig();
    r.instrument.press(1);
    r.backend.clock = 0.25;
    r.instrument.release(1);
    expect(r.backend.released).toHaveLength(0);
    expect(r.engine.isLit(1)).toBe(true);
    expect(r.releases[0]).toMatchObject({ pad: 1, gate: false });
  });

  it("a stray key-up for a pad that was never down does nothing", () => {
    const r = rig({ kit: setTrigger(defaultKit(), "gate") });
    expect(r.instrument.release(4)).toBe(false);
    expect(r.releases).toHaveLength(0);
  });
});

describe("PadInstrument, lost focus", () => {
  it("releases everything held when the window blurs mid-hold, so no note hangs", () => {
    const r = rig({ kit: setTrigger(defaultKit(), "gate") });
    r.instrument.press(1);
    r.instrument.press(2);
    r.backend.clock = 1;
    expect(r.instrument.releaseAll()).toBe(2);
    expect(r.backend.released).toHaveLength(2);
    expect(r.instrument.heldPads()).toEqual([]);
    expect(r.releases.map((x) => x.pad).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("can also cut one-shot voices when the producer asks for silence", () => {
    const r = rig();
    r.instrument.press(1);
    r.instrument.releaseAll({ engineToo: true });
    expect(r.backend.released).toHaveLength(1);
    expect(r.engine.litPads()).toEqual([]);
  });

  it("a key still down when the layout changes is released, not left hanging", () => {
    const r = rig({ kit: setTrigger(defaultKit(), "gate") });
    r.instrument.press(1);
    r.instrument.releaseAll();
    r.setKit(setLayout(setTrigger(defaultKit(), "gate"), "32"));
    expect(r.instrument.heldPads()).toEqual([]);
    expect(r.backend.released).toHaveLength(1);
  });
});

describe("PadInstrument, note mode", () => {
  it("plays the same slice on every key, transposed from the root", () => {
    const kit = setPlay(defaultKit(), "note");
    const r = rig({ kit });
    expect(r.instrument.fileFor(1)).toBe("file-8"); // the root pad's slice, not pad 1's
    expect(r.instrument.semitonesFor(1)).toBe(-7);
    expect(r.instrument.semitonesFor(8)).toBe(0);
    r.instrument.press(10);
    expect(r.backend.started[0]).toMatchObject({ pad: 10, fileId: "file-8" });
    expect(r.backend.started[0]?.rate).toBeCloseTo(2 ** (2 / 12), 12);
  });

  it("moves the root and every key moves with it", () => {
    const r = rig({ kit: setRootPad(setPlay(defaultKit(), "note"), 1) });
    expect(r.instrument.semitonesFor(1)).toBe(0);
    expect(r.instrument.semitonesFor(13)).toBe(12);
    expect(r.instrument.fileFor(13)).toBe("file-1");
  });

  it("chop mode is unchanged: every key its own slice, no transposition", () => {
    const r = rig();
    expect(r.instrument.fileFor(2)).toBe("file-2");
    expect(r.instrument.semitonesFor(2)).toBe(0);
  });
});

describe("PadInstrument, what a key means", () => {
  it("maps a key through the kit's own layout", () => {
    const r = rig({ kit: setLayout(defaultKit(), "32") });
    expect(r.instrument.padForKey("r")).toBe(12);
    expect(r.instrument.padForKey("z")).toBe(25);
    expect(r.instrument.pressKey("z")).toBe("empty"); // held, but nothing bound
    expect(r.instrument.heldPads()).toEqual([25]);
    expect(r.instrument.releaseKey("z")).toBe(true);
  });

  it("says when a pad is empty or still decoding, and holds the key either way", () => {
    const r = rig({ ready: {} });
    expect(r.instrument.press(1)).toBe("not-ready");
    expect(r.instrument.heldPads()).toEqual([1]);
    expect(r.instrument.press(99)).toBe("out-of-range");
  });

  it("knows when the laptop's three-key ceiling has been reached", () => {
    const r = rig();
    r.instrument.press(1);
    r.instrument.press(2);
    expect(r.instrument.atPolyphonyCeiling()).toBe(false);
    r.instrument.press(3);
    expect(r.instrument.atPolyphonyCeiling()).toBe(true);
    expect(r.instrument.peakHeld).toBe(3);
  });
});
