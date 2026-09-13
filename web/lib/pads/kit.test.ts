import { describe, expect, it } from "vitest";
import { applyOrder, bindPads, boundCount } from "./bindings";
import type { ChopWithFile } from "@/lib/api/chops";
import {
  MAX_SIMULTANEOUS_KEYS,
  defaultKit,
  describeKit,
  identityOrder,
  padCountOfKit,
  setLayout,
  setNotePad,
  setPlay,
  setRootPad,
  setTrigger,
  swapPads,
} from "./kit";

const chop = (index: number, fileId: string): ChopWithFile => ({
  id: `chop-${index}`,
  user_id: "u",
  source_file_id: "src",
  start_s: index,
  end_s: index + 1,
  index,
  name: null,
  chop_file_id: fileId,
  created_at: "2026-09-13T00:00:00Z",
  file: null,
});

describe("the kit", () => {
  it("starts as Phase 3 shipped: sixteen keys, one-shot, chop mode, root in the middle", () => {
    const kit = defaultKit();
    expect(kit).toMatchObject({ layoutId: "16", trigger: "one-shot", play: "chop", rootPad: 8, notePad: null });
    expect(kit.order).toEqual(identityOrder(16));
    expect(describeKit(kit)).toBe("16 keys, one-shot, chop mode");
  });

  it("switches trigger and play mode without touching anything else", () => {
    const kit = setPlay(setTrigger(defaultKit(), "gate"), "note");
    expect(kit.trigger).toBe("gate");
    expect(kit.play).toBe("note");
    expect(kit.order).toEqual(defaultKit().order);
    expect(describeKit(kit)).toBe("16 keys, gate, note mode, root on 8");
    expect(setTrigger(kit, "gate")).toBe(kit);
  });

  it("keeps the slices it can when the layout grows, and puts the root back in the middle", () => {
    const kit = setLayout(defaultKit(), "32");
    expect(padCountOfKit(kit)).toBe(32);
    expect(kit.order.slice(0, 16)).toEqual(identityOrder(16));
    expect(kit.rootPad).toBe(16);
  });

  it("leaves a root the producer moved alone when it still exists", () => {
    const moved = setRootPad(defaultKit(), 3);
    expect(setLayout(moved, "24").rootPad).toBe(3);
    const high = setRootPad(setLayout(defaultKit(), "32"), 30);
    expect(setLayout(high, "8").rootPad).toBe(4);
  });

  it("clamps the root and the note pad to the layout", () => {
    expect(setRootPad(defaultKit(), 99).rootPad).toBe(16);
    expect(setRootPad(defaultKit(), 0).rootPad).toBe(1);
    expect(setNotePad(defaultKit(), 4).notePad).toBe(4);
    expect(setNotePad(defaultKit(), 99).notePad).toBe(16);
    expect(setNotePad(setNotePad(defaultKit(), 4), null).notePad).toBeNull();
  });

  it("swaps two pads when a slice is dragged onto another key", () => {
    const kit = swapPads(defaultKit(), 1, 5);
    expect(kit.order[0]).toBe(4);
    expect(kit.order[4]).toBe(0);
    expect(swapPads(kit, 1, 1)).toBe(kit);
    expect(swapPads(kit, 1, 99)).toBe(kit);
  });

  it("lays the bindings out in the kit's order, and the pad number always says where it sits", () => {
    const bindings = bindPads([chop(0, "f0"), chop(1, "f1"), chop(2, "f2")], []);
    const ordered = applyOrder(bindings, swapPads(defaultKit(), 1, 3).order);
    expect(ordered[0]).toMatchObject({ pad: 1, file_id: "f2" });
    expect(ordered[2]).toMatchObject({ pad: 3, file_id: "f0" });
    expect(boundCount(ordered)).toBe(3);
  });

  it("binds as many pads as the layout has", () => {
    const chops = Array.from({ length: 40 }, (_, i) => chop(i, `f${i}`));
    expect(bindPads(chops, [], 8)).toHaveLength(8);
    expect(bindPads(chops, [], 40)).toHaveLength(40);
    expect(boundCount(bindPads(chops, [], 40))).toBe(40);
    expect(bindPads(chops.slice(0, 3), [], 32).filter((b) => b !== null)).toHaveLength(3);
  });

  it("names the hardware ceiling rather than pretending it is a setting", () => {
    expect(MAX_SIMULTANEOUS_KEYS).toBe(3);
  });

  it("an empty pad in the order comes back as an empty pad, not a crash", () => {
    const bindings = bindPads([chop(0, "f0")], []);
    const ordered = applyOrder(bindings, [-1, 0, 99]);
    expect(ordered[0]).toBeNull();
    expect(ordered[1]).toMatchObject({ pad: 2, file_id: "f0" });
    expect(ordered[2]).toBeNull();
  });
});
