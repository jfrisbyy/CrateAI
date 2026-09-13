// Named keyboard layouts, over one pure mapping function.
//
// The producer picks how much of the keyboard is the instrument: eight keys
// for a break in eighths, sixteen for the 4x4 that shipped in Phase 3,
// twenty-four or thirty-two for a longer phrase, the full four rows for the
// deepest chopping. More keys buys more *slices*, never more polyphony — see
// MAX_SIMULTANEOUS_KEYS in kit.ts.
//
// `padForKeyIn` / `keyForPadIn` are the only mapping in the product: the
// on-screen grid, the engine, the recorder and the chat all read them, so
// they cannot disagree about what `R` means.

/** Physical rows as `KeyboardEvent.key` gives them, lowercase, US QWERTY. */
export const KEY_ROWS = {
  digits: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  top: ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  home: ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";"],
  bottom: ["z", "x", "c", "v", "b", "n", "m", ",", ".", "/"],
} as const;

export type LayoutId = "8" | "16" | "24" | "32" | "full";

export interface PadLayout {
  id: LayoutId;
  label: string;
  /** pad N (1-based) plays `keys[N - 1]`; lowercase */
  keys: readonly string[];
  /** how the grid is drawn: keys per row, mirroring the physical rows */
  columns: number;
  describe: string;
}

const first = (row: readonly string[], n: number): string[] => row.slice(0, n);

/** The presets, smallest first. `16` is exactly the Phase 3 map and stays the default. */
export const LAYOUTS: readonly PadLayout[] = [
  {
    id: "8",
    label: "8",
    keys: first(KEY_ROWS.digits, 8),
    columns: 8,
    describe: "The number row. A break in eighths, coarse and instantly memorable.",
  },
  {
    id: "16",
    label: "16",
    keys: [...first(KEY_ROWS.digits, 8), ...first(KEY_ROWS.top, 8)],
    columns: 4,
    describe: "1–8 and Q–I in a 4x4. The default, and what Phase 3 shipped.",
  },
  {
    id: "24",
    label: "24",
    keys: [...first(KEY_ROWS.digits, 8), ...first(KEY_ROWS.top, 8), ...first(KEY_ROWS.home, 8)],
    columns: 8,
    describe: "The number row and two letter rows. A longer phrase.",
  },
  {
    id: "32",
    label: "32",
    keys: [
      ...first(KEY_ROWS.digits, 8),
      ...first(KEY_ROWS.top, 8),
      ...first(KEY_ROWS.home, 8),
      ...first(KEY_ROWS.bottom, 8),
    ],
    columns: 8,
    describe: "The number row and three letter rows. The deepest chopping, two-handed.",
  },
  {
    id: "full",
    label: "Full",
    keys: [...KEY_ROWS.digits, ...KEY_ROWS.top, ...KEY_ROWS.home, ...KEY_ROWS.bottom],
    columns: 10,
    describe: "Every key of the four rows: forty slices.",
  },
];

export const DEFAULT_LAYOUT_ID: LayoutId = "16";
export const LAYOUT_IDS: readonly LayoutId[] = LAYOUTS.map((l) => l.id);

const BY_ID = new Map<string, PadLayout>(LAYOUTS.map((l) => [l.id, l]));

export function layoutById(id: string): PadLayout | null {
  return BY_ID.get(id) ?? null;
}

/** The layout, or the default when the id is not one we know. */
export function layoutOr(id: string | null | undefined, fallback: LayoutId = DEFAULT_LAYOUT_ID): PadLayout {
  return (id ? BY_ID.get(id) : null) ?? (BY_ID.get(fallback) as PadLayout);
}

export function padCountOf(layout: PadLayout): number {
  return layout.keys.length;
}

/** 1-based pad for a key (either case) in this layout, or null when the key is not one of its pads. */
export function padForKeyIn(layout: PadLayout, key: string): number | null {
  if (key.length !== 1) return null;
  const i = layout.keys.indexOf(key.toLowerCase());
  return i < 0 ? null : i + 1;
}

/** The key a pad sounds from, lowercase as the event gives it. */
export function keyForPadIn(layout: PadLayout, pad: number): string {
  const key = layout.keys[pad - 1];
  if (key === undefined) throw new RangeError(`pad ${pad} is out of range 1..${layout.keys.length}`);
  return key;
}

/** What the key looks like on the cap: letters uppercase, punctuation as it is. */
export function keyLabel(key: string): string {
  return key.toUpperCase();
}

/** The grid as rows, exactly as the keys sit under the hands. */
export function rowsOf(layout: PadLayout): string[][] {
  const rows: string[][] = [];
  for (let i = 0; i < layout.keys.length; i += layout.columns) rows.push(layout.keys.slice(i, i + layout.columns));
  return rows;
}

/**
 * The single-key file shortcuts (lib/keys/commands.ts) a layout swallows while
 * it is the instrument. The interface says which, rather than letting a
 * producer find out by pressing L and getting a slice.
 */
export const SINGLE_KEY_SHORTCUTS: ReadonlyArray<{ key: string; does: string }> = [
  { key: "l", does: "new loop" },
  { key: "d", does: "set the downbeat" },
  { key: ",", does: "nudge the loop earlier" },
  { key: ".", does: "nudge the loop later" },
];

export function shortcutsTakenBy(layout: PadLayout): Array<{ key: string; does: string }> {
  return SINGLE_KEY_SHORTCUTS.filter((s) => layout.keys.includes(s.key));
}
