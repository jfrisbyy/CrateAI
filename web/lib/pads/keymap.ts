// The default pad keyboard map (OPEN_QUESTIONS K.34): 1–8 are pads 1–8, Q–I
// are pads 9–16. This is the `16` preset in layouts.ts, which is now the one
// mapping function; everything here reads it so the two can never drift.
//
// Grid layout, four rows of four, reading like the keyboard:
//   1 2 3 4      pads 1–4
//   5 6 7 8      pads 5–8
//   Q W E R      pads 9–12
//   T Y U I      pads 13–16
//
// A layout other than `16` is addressed through layouts.ts directly
// (`padForKeyIn`, `keyForPadIn`); these helpers keep the Phase 3 callers and
// their tests working unchanged.

import { keyForPadIn, keyLabel, layoutOr, padCountOf, padForKeyIn } from "./layouts";

const DEFAULT_LAYOUT = layoutOr("16");

export const PAD_COUNT = padCountOf(DEFAULT_LAYOUT);
export const PAD_COLUMNS = DEFAULT_LAYOUT.columns;

export const PAD_KEYS: readonly string[] = DEFAULT_LAYOUT.keys;

/** 1-based pad for a key (either case), or null when the key is not a pad key. */
export function padForKey(key: string): number | null {
  return padForKeyIn(DEFAULT_LAYOUT, key);
}

/** The key label shown on a pad (uppercase for letters). */
export function keyForPad(pad: number): string {
  return keyLabel(keyForPadIn(DEFAULT_LAYOUT, pad));
}

export function isPadNumber(pad: number): boolean {
  return Number.isInteger(pad) && pad >= 1 && pad <= PAD_COUNT;
}
