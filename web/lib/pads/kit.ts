// A kit is every choice the producer makes about how the keyboard plays:
// the layout, one-shot or gate, chop or note, where the root sits, and which
// key got which slice. It is plain data with pure updaters, so the on-screen
// controls, a sentence from the chat and a test all move the same thing.

import { defaultRootPad } from "./note";
import { DEFAULT_LAYOUT_ID, layoutOr, padCountOf, type LayoutId } from "./layouts";

/** One-shot fires the whole slice; gate sounds only while the key is down. */
export type TriggerMode = "one-shot" | "gate";
/** Chop: a slice per key. Note: one slice transposed across the keys. */
export type PlayMode = "chop" | "note";

export const TRIGGER_MODES: ReadonlyArray<{ id: TriggerMode; label: string; describe: string }> = [
  { id: "one-shot", label: "One-shot", describe: "The whole slice plays out; holding the key changes nothing. Drums want this." },
  { id: "gate", label: "Gate", describe: "Sounds while the key is down and cuts on release, with a 2 ms fade so it does not click." },
];

export const PLAY_MODES: ReadonlyArray<{ id: PlayMode; label: string; describe: string }> = [
  { id: "chop", label: "Chop", describe: "Each key is a different slice." },
  { id: "note", label: "Note", describe: "Every key plays the same slice transposed, so one stab becomes an instrument." },
];

/**
 * The ceiling, and it is hardware. A laptop keyboard matrix registers only
 * two or three simultaneous keys in arbitrary combinations, so more keys buys
 * more slices and never more polyphony. Chords are a controller feature (Web
 * MIDI, Phase 13), and the interface says so rather than letting a producer
 * find out by having a chord swallowed.
 */
export const MAX_SIMULTANEOUS_KEYS = 3;
export const POLYPHONY_NOTE =
  "A laptop keyboard registers about three keys at once, whatever the layout. More keys is more slices, not more polyphony — chords need a MIDI controller.";

export interface PadKit {
  layoutId: LayoutId;
  trigger: TriggerMode;
  play: PlayMode;
  /** 1-based pad that sounds untransposed in note mode */
  rootPad: number;
  /** the pad whose slice note mode plays; null means "whatever is on the root pad" */
  notePad: number | null;
  /**
   * Which key gets what: `order[i]` is the slice index the pad `i + 1` plays.
   * Identity until the producer or the AI reorders it, so the default is
   * still file order and nothing is hidden.
   */
  order: readonly number[];
}

export function identityOrder(padCount: number): number[] {
  return Array.from({ length: Math.max(0, padCount) }, (_, i) => i);
}

export function defaultKit(layoutId: LayoutId = DEFAULT_LAYOUT_ID): PadKit {
  const count = padCountOf(layoutOr(layoutId));
  return { layoutId, trigger: "one-shot", play: "chop", rootPad: defaultRootPad(count), notePad: null, order: identityOrder(count) };
}

export function padCountOfKit(kit: PadKit): number {
  return padCountOf(layoutOr(kit.layoutId));
}

export function setTrigger(kit: PadKit, trigger: TriggerMode): PadKit {
  return kit.trigger === trigger ? kit : { ...kit, trigger };
}

export function setPlay(kit: PadKit, play: PlayMode): PadKit {
  return kit.play === play ? kit : { ...kit, play };
}

/**
 * A new layout keeps the slice order it can (the first N keys keep their
 * slices) and puts the root back in the middle unless the producer had moved
 * it somewhere that still exists.
 */
export function setLayout(kit: PadKit, layoutId: LayoutId): PadKit {
  if (kit.layoutId === layoutId) return kit;
  const count = padCountOf(layoutOr(layoutId));
  const order = identityOrder(count).map((i) => kit.order[i] ?? i);
  const wasDefaultRoot = kit.rootPad === defaultRootPad(padCountOfKit(kit));
  const rootPad = wasDefaultRoot || kit.rootPad > count ? defaultRootPad(count) : kit.rootPad;
  const notePad = kit.notePad !== null && kit.notePad <= count ? kit.notePad : null;
  return { ...kit, layoutId, order, rootPad, notePad };
}

export function setRootPad(kit: PadKit, pad: number): PadKit {
  const count = padCountOfKit(kit);
  const rootPad = Math.max(1, Math.min(count, Math.round(pad)));
  return kit.rootPad === rootPad ? kit : { ...kit, rootPad };
}

export function setNotePad(kit: PadKit, pad: number | null): PadKit {
  if (pad === null) return kit.notePad === null ? kit : { ...kit, notePad: null };
  const count = padCountOfKit(kit);
  const notePad = Math.max(1, Math.min(count, Math.round(pad)));
  return kit.notePad === notePad ? kit : { ...kit, notePad };
}

export function setOrder(kit: PadKit, order: readonly number[]): PadKit {
  return { ...kit, order: [...order] };
}

/** Drag a pad's slice onto another pad: the two swap, which is what a producer means. */
export function swapPads(kit: PadKit, a: number, b: number): PadKit {
  const count = padCountOfKit(kit);
  if (a === b || a < 1 || b < 1 || a > count || b > count) return kit;
  const order = [...kit.order];
  const tmp = order[a - 1] as number;
  order[a - 1] = order[b - 1] as number;
  order[b - 1] = tmp;
  return { ...kit, order };
}

/** One line naming the kit, in the same words the controls use. */
export function describeKit(kit: PadKit): string {
  const layout = layoutOr(kit.layoutId);
  const mode = kit.play === "note" ? `note mode, root on ${layout.keys[kit.rootPad - 1]?.toUpperCase() ?? kit.rootPad}` : "chop mode";
  return `${layout.label} keys, ${kit.trigger}, ${mode}`;
}
