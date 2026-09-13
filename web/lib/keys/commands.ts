// Keyboard map (OPEN_QUESTIONS K.34) and a tiny command bus. The shell owns
// the window listener; the surface and the loops tab subscribe to commands.
//
//   space        play / pause
//   [  ]         loop start / end at the cursor
//   L            new loop at the cursor
//   D            set the first downbeat at the cursor
//   ,  .         nudge the selected loop by a 16th
//   1–8, Q–I     pads 1–16 (stubs until Phase 3)
//   ?            this map

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
  { keys: "1–8", does: "Pads 1–8 (chops, Phase 3)" },
  { keys: "Q–I", does: "Pads 9–16 (chops, Phase 3)" },
  { keys: "?", does: "Show this map" },
  { keys: "Esc", does: "Close a sheet or cancel a rename" },
];

const COMMAND_EVENT = "crateai:command";
const PAD_EVENT = "crateai:pad";

export interface PadDetail {
  pad: number;
  key: string;
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
    emitPad({ pad, key: key.toUpperCase() });
    return true;
  }
  return false;
}
