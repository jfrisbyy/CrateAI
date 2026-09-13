// The keyboard layer, against a two-line DOM stub: `window` is an EventTarget,
// `document` answers "no dialog is open", and `HTMLElement` exists so the
// typing guard can ask. Everything asserted here is what decides whether a
// producer's browser shortcuts still work while the instrument has the keys.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYMAP, handleKeydown, handleKeyup, onPad, onPadUp, padForEventKey, setPadKeyResolver, type PadDetail, type PadUpDetail } from "./commands";
import { layoutOr, padForKeyIn } from "@/lib/pads/layouts";

interface Stub {
  window: EventTarget;
}

const saved: Record<string, unknown> = {};

beforeEach(() => {
  saved.window = (globalThis as { window?: unknown }).window;
  saved.document = (globalThis as { document?: unknown }).document;
  saved.HTMLElement = (globalThis as { HTMLElement?: unknown }).HTMLElement;
  const target = new EventTarget();
  (globalThis as unknown as Stub).window = target;
  (globalThis as unknown as { document: { querySelector: () => null } }).document = { querySelector: () => null };
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = class {};
});

afterEach(() => {
  setPadKeyResolver(null);
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { document?: unknown }).document = saved.document;
  (globalThis as { HTMLElement?: unknown }).HTMLElement = saved.HTMLElement;
});

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return { metaKey: false, ctrlKey: false, altKey: false, repeat: false, timeStamp: 100, target: null, ...init } as KeyboardEvent;
}

function captured(): { pads: PadDetail[]; ups: PadUpDetail[]; stop: () => void } {
  const pads: PadDetail[] = [];
  const ups: PadUpDetail[] = [];
  const offPad = onPad((d) => pads.push(d));
  const offUp = onPadUp((d) => ups.push(d));
  return { pads, ups, stop: () => { offPad(); offUp(); } };
}

describe("browser shortcuts are never swallowed", () => {
  it("leaves every Ctrl, Cmd and Alt combination alone", () => {
    for (const e of [
      key({ key: "r", metaKey: true }),
      key({ key: "t", ctrlKey: true }),
      key({ key: "1", metaKey: true }),
      key({ key: "q", ctrlKey: true }),
      key({ key: " ", metaKey: true }),
      key({ key: "w", altKey: true }),
    ]) {
      expect(handleKeydown(e), e.key).toBe(false);
      expect(handleKeyup(e), e.key).toBe(false);
    }
  });

  it("leaves the keys alone while someone is typing", () => {
    const input = Object.assign(new (globalThis as unknown as { HTMLElement: new () => object }).HTMLElement(), {
      tagName: "INPUT",
      isContentEditable: false,
    });
    expect(handleKeydown(key({ key: "q", target: input as unknown as EventTarget }))).toBe(false);
    expect(handleKeyup(key({ key: "q", target: input as unknown as EventTarget }))).toBe(false);
  });
});

describe("what a key means", () => {
  it("is the default sixteen with no instrument mounted", () => {
    expect(padForEventKey("q")).toBe(9);
    expect(padForEventKey("Q")).toBe(9);
    expect(padForEventKey("d")).toBeNull();
    expect(padForEventKey("Shift")).toBeNull();
  });

  it("is the mounted layout while there is one, so D is a pad and not the downbeat shortcut", () => {
    const layout = layoutOr("32");
    const unregister = setPadKeyResolver((k) => padForKeyIn(layout, k));
    const seen = captured();
    expect(handleKeydown(key({ key: "d" }))).toBe(true);
    expect(seen.pads).toEqual([{ pad: 19, key: "D", repeat: false, atMs: 100 }]);
    unregister();
    seen.pads.length = 0;
    expect(handleKeydown(key({ key: "d" }))).toBe(true);
    expect(seen.pads).toEqual([]); // back to the downbeat command
    seen.stop();
  });

  it("carries the repeat flag and the event's timestamp, which gate mode and the latency readout need", () => {
    const seen = captured();
    handleKeydown(key({ key: "1", repeat: true, timeStamp: 4242 }));
    expect(seen.pads[0]).toMatchObject({ pad: 1, repeat: true, atMs: 4242 });
    seen.stop();
  });

  it("emits a pad-up for a pad key and nothing for any other key", () => {
    const seen = captured();
    expect(handleKeyup(key({ key: "1" }))).toBe(true);
    expect(handleKeyup(key({ key: "z" }))).toBe(false);
    expect(handleKeyup(key({ key: "Shift" }))).toBe(false);
    expect(seen.ups).toEqual([{ pad: 1, key: "1", atMs: 100 }]);
    seen.stop();
  });

  it("still routes space and the loop keys", () => {
    expect(handleKeydown(key({ key: " " }))).toBe(true);
    expect(handleKeydown(key({ key: "[" }))).toBe(true);
    expect(handleKeydown(key({ key: "?" }))).toBe(true);
    expect(handleKeydown(key({ key: "Escape" }))).toBe(false);
  });

  it("has a line in the key map for the pads", () => {
    expect(KEYMAP.some((row) => row.keys === "1–8")).toBe(true);
  });
});
