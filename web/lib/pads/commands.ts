// The keyboard instrument as a command line.
//
// The rule from the direction document: everything the mouse can do, a
// sentence can do, and the sentence moves the same control. This is the
// sentence half of the instrument — the same shape as lib/session/commands.ts
// and deliberately just as narrow. A sentence becomes a command only when it
// is unmistakably one; "why does gate mode click" is a question and reaches
// the model untouched.

import type { LayoutId } from "./layouts";
import { LAYOUTS } from "./layouts";
import type { PlayMode, TriggerMode } from "./kit";
import type { OrderStrategy } from "./kitOrder";
import type { SliceMaterial } from "./slices";

export type KeyboardCommand =
  | { kind: "play-pad"; key: string }
  | { kind: "set-trigger"; mode: TriggerMode }
  | { kind: "set-play"; mode: PlayMode }
  | { kind: "set-layout"; layout: LayoutId }
  | { kind: "set-root"; key: string }
  | { kind: "propose-cuts"; material: SliceMaterial | null }
  | { kind: "cut" }
  | { kind: "add-cut" }
  | { kind: "remove-cut"; index: number }
  | { kind: "move-cut"; index: number }
  | { kind: "order-kit"; strategy: OrderStrategy }
  | { kind: "swap-pads"; a: number; b: number }
  | { kind: "record"; bars: number | null }
  | { kind: "click"; on: boolean }
  | { kind: "save-midi" }
  | { kind: "stop-record" }
  | { kind: "clear-take" }
  | { kind: "clean-take"; tighten: number | null }
  | { kind: "collapse-flams"; on: boolean }
  | { kind: "use-cleaned" }
  | { kind: "use-played" }
  | { kind: "suggest-patterns" }
  | { kind: "use-pattern"; index: number }
  | { kind: "keep-take" }
  | { kind: "all-off" };

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  sixteen: 16, "twenty four": 24, "thirty two": 32,
};

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

/** A question or anything with a conjunction is a conversation, not a command. */
function conversational(s: string): boolean {
  return /\b(why|how|what|which|who|whether|should i|can you|could you|and|but|because)\b/.test(s);
}

export function parseKeyboardCommand(text: string): KeyboardCommand | null {
  const s = normalise(text);
  if (s === "") return null;

  // "swap pads 3 and 5" is the one command with a conjunction in it, so it is
  // matched before the conversational guard rather than losing to it.
  const swap = /^swap (?:pads? )?(\d{1,2}) (?:and|with) (?:pad )?(\d{1,2})$/.exec(s);
  if (swap?.[1] && swap[2]) return { kind: "swap-pads", a: Number(swap[1]), b: Number(swap[2]) };

  if (conversational(s)) return null;

  // --- play a pad by its key ---
  const playPad = /^(?:play|hit|tap|trigger) (?:pad |key )?([a-z0-9;,./])$/.exec(s);
  if (playPad?.[1]) return { kind: "play-pad", key: playPad[1] };

  // --- trigger ---
  if (/^(gate|gate mode|switch to gate|use gate|play in gate)$/.test(s)) return { kind: "set-trigger", mode: "gate" };
  if (/^(one[- ]?shot|one[- ]?shot mode|switch to one[- ]?shot|use one[- ]?shot)$/.test(s)) return { kind: "set-trigger", mode: "one-shot" };

  // --- chop or note ---
  if (/^(note mode|switch to note mode|play it chromatically|play chromatically|make it an instrument)$/.test(s)) return { kind: "set-play", mode: "note" };
  if (/^(chop mode|switch to chop mode|back to chops|a slice per key)$/.test(s)) return { kind: "set-play", mode: "chop" };

  // --- layout ---
  const layout = layoutFrom(s);
  if (layout) return { kind: "set-layout", layout };

  // --- the root in note mode ---
  const root = /^(?:put the |set the )?root (?:key |on |to |at )+([a-z0-9;,./])$/.exec(s);
  if (root?.[1]) return { kind: "set-root", key: root[1] };

  // --- where the cuts go ---
  if (/^(propose cuts|suggest cuts|where should the cuts go|find the cuts|slice it|propose slice points)$/.test(s)) return { kind: "propose-cuts", material: null };
  const material = /^(?:propose |suggest )?(?:cuts?|slices?) (?:on|for|as) (?:a |the )?(break|transients?|melodic|notes?|phrase|sections?)$/.exec(s);
  if (material?.[1]) return { kind: "propose-cuts", material: materialFrom(material[1]) };
  if (/^(cut it|make the chops|chop it|take these cuts|use these cuts)$/.test(s)) return { kind: "cut" };
  if (/^add a cut(?: at the playhead| here)?$/.test(s)) return { kind: "add-cut" };
  const removeCut = /^(?:remove|delete|drop) cut (\d{1,3})$/.exec(s);
  if (removeCut?.[1]) return { kind: "remove-cut", index: Number(removeCut[1]) };
  const moveCut = /^move cut (\d{1,3})(?: to the playhead| here)$/.exec(s);
  if (moveCut?.[1]) return { kind: "move-cut", index: Number(moveCut[1]) };

  // --- which key gets what ---
  const order = /^(?:sort|order|lay out|arrange) (?:the )?(?:kit|pads|slices) by (?:the )?([a-z ]+)$/.exec(s);
  if (order?.[1]) {
    const strategy = strategyFrom(order[1].trim());
    if (strategy) return { kind: "order-kit", strategy };
  }
  if (/^(sort the kit|order the kit|lay the kit out)$/.test(s)) return { kind: "order-kit", strategy: "hit-class" };
  if (/^(reset the kit|file order|back to file order)$/.test(s)) return { kind: "order-kit", strategy: "file" };

  // --- record ---
  const record = /^record(?: (\d+|one|two|three|four|five|six|seven|eight) bars?)?$/.exec(s);
  if (record) {
    const raw = record[1];
    const bars = raw ? (Number.isFinite(Number(raw)) ? Number(raw) : (WORD_NUMBERS[raw] ?? null)) : null;
    return { kind: "record", bars: bars ?? null };
  }
  if (/^record until (i )?stop$/.test(s)) return { kind: "record", bars: null };
  if (/^(stop recording|stop the take|end the take)$/.test(s)) return { kind: "stop-record" };
  if (/^(clear the take|drop the take|start again)$/.test(s)) return { kind: "clear-take" };
  if (/^(click on|turn the click on|metronome on)$/.test(s)) return { kind: "click", on: true };
  if (/^(click off|turn the click off|metronome off|no click)$/.test(s)) return { kind: "click", on: false };
  if (/^(save (?:it|the take) as midi|save as midi|export the take)$/.test(s)) return { kind: "save-midi" };

  // --- clean up a take ---
  const tighten = /^tighten (?:the take |it )?(?:to the grid )?(?:by )?(\d{1,3}) ?%$/.exec(s);
  if (tighten?.[1]) return { kind: "clean-take", tighten: Math.max(0, Math.min(100, Number(tighten[1]))) / 100 };
  if (/^(tighten it|tighten the take|clean the take|clean it up|tidy the take)$/.test(s)) return { kind: "clean-take", tighten: null };
  if (/^(keep the cleaned take|use the cleaned take|take the clean one)$/.test(s)) return { kind: "use-cleaned" };
  if (/^(keep the played take|use the played take|the one i played|as i played it)$/.test(s)) return { kind: "use-played" };
  if (/^(collapse the flams|collapse flams)$/.test(s)) return { kind: "collapse-flams", on: true };
  if (/^(leave the flams|keep the flams|no flam collapsing)$/.test(s)) return { kind: "collapse-flams", on: false };

  // --- patterns ---
  if (/^(suggest patterns|suggest variations|what else could this be|give me variations|vary it)$/.test(s)) return { kind: "suggest-patterns" };
  const usePattern = /^(?:use|keep|take) (?:the )?(first|second|third|fourth|1st|2nd|3rd|4th|\d) (?:one|variation|pattern)$/.exec(s);
  if (usePattern?.[1]) {
    // Only a digit carries an ordinal suffix; stripping "nd" off "second"
    // would leave "secon" and lose the command.
    const raw = usePattern[1];
    const digits = /^(\d+)(?:st|nd|rd|th)?$/.exec(raw);
    const index = digits ? Number(digits[1]) : (WORD_NUMBERS[raw] ?? null);
    if (index !== null && index >= 1) return { kind: "use-pattern", index };
  }

  // --- the session ---
  if (/^(keep the take|put the take in the session|send the take to the session|keep it)$/.test(s)) return { kind: "keep-take" };

  // --- panic ---
  if (/^(all off|stop the pads|silence|kill the notes|panic)$/.test(s)) return { kind: "all-off" };

  return null;
}

function layoutFrom(s: string): LayoutId | null {
  if (/^(the )?full keyboard$|^full layout$|^use the whole keyboard$/.test(s)) return "full";
  const sized = /^(?:use |switch to |give me )?(?:the )?(\d{1,2}|eight|sixteen|twenty four|thirty two) (?:key|keys|pads?|pad layout|key layout)$/.exec(s);
  const word = sized?.[1];
  if (!word) return null;
  const n = Number.isFinite(Number(word)) ? Number(word) : (WORD_NUMBERS[word] ?? null);
  if (n === null) return null;
  const match = LAYOUTS.find((l) => l.keys.length === n);
  return match ? match.id : null;
}

function materialFrom(word: string): SliceMaterial {
  if (/^(melodic|notes?)$/.test(word)) return "melodic";
  if (/^(phrase|sections?)$/.test(word)) return "phrase";
  return "break";
}

function strategyFrom(word: string): OrderStrategy | null {
  if (/^(hit class|class|drum class|kit class)$/.test(word)) return "hit-class";
  if (/^(pitch|note|key)$/.test(word)) return "pitch";
  if (/^(position|time|where they are|order in the record)$/.test(word)) return "position";
  if (/^(length|duration)$/.test(word)) return "length";
  if (/^(file|file order|index)$/.test(word)) return "file";
  return null;
}

/** One line, in the same words the controls use, for the echo under the chat. */
export function describeKeyboardCommand(command: KeyboardCommand): string {
  switch (command.kind) {
    case "play-pad":
      return `played ${command.key.toUpperCase()}.`;
    case "set-trigger":
      return command.mode === "gate" ? "gate: a key sounds while it is down." : "one-shot: a key plays the whole slice.";
    case "set-play":
      return command.mode === "note" ? "note mode: one slice across the keys." : "chop mode: a slice per key.";
    case "set-layout":
      return `${LAYOUTS.find((l) => l.id === command.layout)?.label ?? command.layout} keys.`;
    case "set-root":
      return `root on ${command.key.toUpperCase()}.`;
    case "propose-cuts":
      return command.material ? `proposing ${command.material} cuts.` : "proposing cuts.";
    case "cut":
      return "cutting the file at the proposed points.";
    case "add-cut":
      return "cut added at the playhead.";
    case "remove-cut":
      return `cut ${command.index} removed.`;
    case "move-cut":
      return `cut ${command.index} moved to the playhead.`;
    case "order-kit":
      return `kit ordered by ${command.strategy.replace("-", " ")}.`;
    case "swap-pads":
      return `pads ${command.a} and ${command.b} swapped.`;
    case "record":
      return command.bars === null ? "recording until you stop." : `recording ${command.bars} ${command.bars === 1 ? "bar" : "bars"}.`;
    case "stop-record":
      return "take ended.";
    case "clear-take":
      return "take cleared.";
    case "click":
      return command.on ? "the click runs while you record." : "no click while you record.";
    case "save-midi":
      return "the take is saved as MIDI.";
    case "clean-take":
      return command.tighten === null ? "cleaning the take." : `tightening ${Math.round(command.tighten * 100)}% toward the grid.`;
    case "collapse-flams":
      return command.on ? "flams collapse into one hit." : "flams are left as played.";
    case "use-cleaned":
      return "keeping the cleaned take.";
    case "use-played":
      return "keeping the take as you played it.";
    case "suggest-patterns":
      return "suggesting variations of your take.";
    case "use-pattern":
      return `variation ${command.index}.`;
    case "keep-take":
      return "the take goes on a track in the session.";
    case "all-off":
      return "every pad released.";
  }
}

// --- the bus -----------------------------------------------------------------
//
// The same shape the session's command line uses: a sentence becomes a command,
// the command goes on the bus, the panel applies it to the control the mouse
// would have moved, and one line comes back in the same words. The instrument's
// own command line puts commands on this bus, so wiring the chat to it is one
// call to `parseKeyboardCommand` and one to `emitKeyboardCommand` — the path a
// sentence takes is then identical whichever box it was typed into.

const COMMAND_EVENT = "crateai:keyboard-command";
const RESULT_EVENT = "crateai:keyboard-command-result";

export interface KeyboardCommandResult {
  /** one line, in the same words the control uses */
  text: string;
  /** false when the command could not be carried out (no take yet, no chops yet) */
  ok: boolean;
}

export function emitKeyboardCommand(command: KeyboardCommand): void {
  window.dispatchEvent(new CustomEvent<KeyboardCommand>(COMMAND_EVENT, { detail: command }));
}

export function onKeyboardCommand(handler: (command: KeyboardCommand) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && typeof (detail as KeyboardCommand).kind === "string") handler(detail as KeyboardCommand);
  };
  window.addEventListener(COMMAND_EVENT, listener);
  return () => window.removeEventListener(COMMAND_EVENT, listener);
}

export function emitKeyboardResult(result: KeyboardCommandResult): void {
  window.dispatchEvent(new CustomEvent<KeyboardCommandResult>(RESULT_EVENT, { detail: result }));
}

export function onKeyboardResult(handler: (result: KeyboardCommandResult) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (detail && typeof detail === "object" && typeof (detail as KeyboardCommandResult).text === "string") handler(detail as KeyboardCommandResult);
  };
  window.addEventListener(RESULT_EVENT, listener);
  return () => window.removeEventListener(RESULT_EVENT, listener);
}
