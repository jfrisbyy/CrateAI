// Keyboard map (OPEN_QUESTIONS K.34) and a tiny command bus. The shell owns
// the window listener; the surface and the loops tab subscribe to commands.
//
//   space        play / pause
//   [  ]         loop start / end at the cursor
//   L            new loop at the cursor
//   D            set the first downbeat at the cursor
//   ,  .         nudge the selected loop by a 16th
//   1–8, Q–I     pads 1–16 (more, on other keys, under a bigger layout)
//   ?            this map
//
// Two things the instrument needs from here (PRODUCT_DIRECTION, Surface 4):
//
//   - **The layout decides what a key means.** A pad layout wider than the
//     sixteen of Phase 3 claims letters that are also single-key shortcuts, so
//     the instrument registers a resolver (`setPadKeyResolver`) while it is on
//     screen and pad keys are matched *before* the letter commands. Nothing is
//     registered when no instrument is mounted, and the sixteen defaults still
//     apply, so the shortcuts behave exactly as they did.
//   - **Key-up matters.** Gate mode cuts the note when the key comes up, so
//     `handleKeyup` emits a pad-up event the same way `handleKeydown` emits a
//     pad. Releases are idempotent: releasing a pad that is not held is a
//     no-op, so it does not matter if two listeners both report one.
//
// Ctrl/Cmd/Alt combinations are never touched, here or anywhere else in the
// product: Cmd-R reloads, Cmd-T opens a tab, Ctrl-C copies. The instrument
// takes single keys only, and a producer's browser keeps working.

export type Command =
  | "play-pause"
  | "loop-start"
  | "loop-end"
  | "new-loop"
  | "set-downbeat"
  | "nudge-left"
  | "nudge-right"
  | "keymap";

export const KEYMAP: ReadonlyArray<{ keys: string; does: string }> = [
  { keys: "Space", does: "Play or pause the open file" },
  { keys: "[ ]", does: "Set the selected loop's start / end at the cursor" },
  { keys: "L", does: "New loop at the cursor" },
  { keys: "D", does: "Set the first downbeat at the cursor" },
  { keys: ", .", does: "Nudge the selected loop a 16th earlier / later" },
  { keys: "1–8", does: "Pads 1–8" },
  { keys: "Q–I", does: "Pads 9–16; a bigger layout adds the other rows" },
  { keys: "?", does: "Show this map" },
  { keys: "Esc", does: "Close a sheet or cancel a rename" },
];

const COMMAND_EVENT = "crateai:command";
const PAD_EVENT = "crateai:pad";
const PAD_UP_EVENT = "crateai:pad-up";

export interface PadDetail {
  pad: number;
  key: string;
  /** true when the OS fired this keydown because the key is being held */
  repeat?: boolean;
  /** `KeyboardEvent.timeStamp`, for the key-to-sound measurement (lib/pads/latency.ts) */
  atMs?: number;
}

export interface PadUpDetail {
  pad: number;
  key: string;
  atMs?: number;
}

export function emitCommand(command: Command): void {
  window.dispatchEvent(new CustomEvent<Command>(COMMAND_EVENT, { detail: command }));
}

/** Pad triggers are a custom event so the Phase 3 pad grid can subscribe without touching the shell. */
export function emitPad(detail: PadDetail): void {
  window.dispatchEvent(new CustomEvent<PadDetail>(PAD_EVENT, { detail }));
}

export function onCommand(handler: (command: Command) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<Command>).detail);
  window.addEventListener(COMMAND_EVENT, listener);
  return () => window.removeEventListener(COMMAND_EVENT, listener);
}

export function onPad(handler: (detail: PadDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<PadDetail>).detail);
  window.addEventListener(PAD_EVENT, listener);
  return () => window.removeEventListener(PAD_EVENT, listener);
}

export function emitPadUp(detail: PadUpDetail): void {
  window.dispatchEvent(new CustomEvent<PadUpDetail>(PAD_UP_EVENT, { detail }));
}

export function onPadUp(handler: (detail: PadUpDetail) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<PadUpDetail>).detail);
  window.addEventListener(PAD_UP_EVENT, listener);
  return () => window.removeEventListener(PAD_UP_EVENT, listener);
}

/**
 * The instrument's mapping while it is on screen: a key to a 1-based pad, or
 * null when that key is not one of its pads. One resolver at a time, and the
 * default sixteen apply when there is none.
 */
export type PadKeyResolver = (key: string) => number | null;

let padKeyResolver: PadKeyResolver | null = null;

export function setPadKeyResolver(resolver: PadKeyResolver | null): () => void {
  padKeyResolver = resolver;
  return () => {
    if (padKeyResolver === resolver) padKeyResolver = null;
  };
}

/** The pad a key plays right now: the mounted instrument's layout, else the default sixteen. */
export function padForEventKey(key: string): number | null {
  if (key.length !== 1) return null;
  const lower = key.toLowerCase();
  if (padKeyResolver) return padKeyResolver(lower);
  return PAD_KEYS[lower] ?? null;
}

const PAD_KEYS: Record<string, number> = {
  "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8,
  q: 9, w: 10, e: 11, r: 12, t: 13, y: 14, u: 15, i: 16,
};

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** Translate a keydown into a command or pad event. Returns true when handled. */
export function handleKeydown(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isTyping(e.target)) return false;
  if (document.querySelector("dialog[open]") && e.key !== "?" && e.key !== "Escape") return false;

  const key = e.key;
  if (key === " ") {
    emitCommand("play-pause");
    return true;
  }
  // The instrument's layout wins over the single-key shortcuts, but only over
  // the keys it actually claims, and only while it is mounted.
  const layoutPad = padKeyResolver ? padKeyResolver(key.toLowerCase()) : null;
  if (layoutPad !== null) {
    emitPad({ pad: layoutPad, key: key.toUpperCase(), repeat: e.repeat, atMs: e.timeStamp });
    return true;
  }
  if (key === "[") return (emitCommand("loop-start"), true);
  if (key === "]") return (emitCommand("loop-end"), true);
  if (key === "," ) return (emitCommand("nudge-left"), true);
  if (key === ".") return (emitCommand("nudge-right"), true);
  if (key === "?") return (emitCommand("keymap"), true);
  const lower = key.toLowerCase();
  if (lower === "l") return (emitCommand("new-loop"), true);
  if (lower === "d") return (emitCommand("set-downbeat"), true);
  const pad = PAD_KEYS[lower];
  if (pad !== undefined) {
    emitPad({ pad, key: key.toUpperCase(), repeat: e.repeat, atMs: e.timeStamp });
    return true;
  }
  return false;
}

/**
 * The key came up. Emits a pad-up for a pad key and nothing else — every other
 * key-up belongs to whatever else is listening. Returns true when handled.
 *
 * Gate mode needs this and the shell's keydown listener is not enough on its
 * own, so the instrument attaches it. It is safe for both to: a release of a
 * pad that is not held does nothing (lib/pads/held.ts).
 */
export function handleKeyup(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isTyping(e.target)) return false;
  const pad = padForEventKey(e.key);
  if (pad === null) return false;
  emitPadUp({ pad, key: e.key.toUpperCase(), atMs: e.timeStamp });
  return true;
}
