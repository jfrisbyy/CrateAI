// The pad keyboard map (OPEN_QUESTIONS K.34): 1–8 are pads 1–8, Q–I are
// pads 9–16. Mirrors PAD_KEYS in lib/keys/commands.ts, which owns the window
// listener and emits `crateai:pad` events with the same 1-based pad numbers.
//
// Grid layout, four rows of four, reading like the keyboard:
//   1 2 3 4      pads 1–4
//   5 6 7 8      pads 5–8
//   Q W E R      pads 9–12
//   T Y U I      pads 13–16

export const PAD_COUNT = 16;
export const PAD_COLUMNS = 4;

export const PAD_KEYS: readonly string[] = ["1", "2", "3", "4", "5", "6", "7", "8", "q", "w", "e", "r", "t", "y", "u", "i"];

/** 1-based pad for a key (either case), or null when the key is not a pad key. */
export function padForKey(key: string): number | null {
  const i = PAD_KEYS.indexOf(key.toLowerCase());
  return i < 0 ? null : i + 1;
}

/** The key label shown on a pad (uppercase for letters). */
export function keyForPad(pad: number): string {
  const key = PAD_KEYS[pad - 1];
  if (key === undefined) throw new RangeError(`pad ${pad} is out of range 1..${PAD_COUNT}`);
  return key.toUpperCase();
}

export function isPadNumber(pad: number): boolean {
  return Number.isInteger(pad) && pad >= 1 && pad <= PAD_COUNT;
}
