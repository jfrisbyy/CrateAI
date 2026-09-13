// The prototype's chat, scripted.
//
// There is no model here: /demo signs nobody in, holds no keys and reaches no
// network, so the conversational half of the chat is four written turns. The
// *command* half is not scripted — a sentence is parsed by
// `lib/session/commands.ts` and applied by `components/shell/applyCommand.ts`,
// exactly as it is in the app — so everything in `COMMAND_EXAMPLES` below
// really does move the control it names.
//
// Pure, so which sentence means which step is asserted in node rather than
// discovered by typing.

/** What a step puts on the panel. */
export type DemoAction = "commit-bed" | "rack-fits" | "rack-loops" | "song";

export interface DemoStep {
  id: string;
  /** the sentence, as the chip says it and as the transcript echoes it */
  said: string;
  /** the answer, in the product's own voice */
  reply: string;
  action: DemoAction;
  /** what to do on the panel once it is there */
  hint: string;
  /** free text that means this step */
  match: RegExp;
}

export const DEMO_STEPS: readonly DemoStep[] = [
  {
    id: "bed",
    said: "Put the four bars of Moonlight Highlife in the song.",
    reply:
      "Kept it as a lane and set the locators to it. The session's grid is 92 BPM because that is the tempo measured on that record — nothing here invents one.",
    action: "commit-bed",
    hint: "Press ▶ in the strip at the bottom. The panel is the song: one lane, one region, a bar ruler and a playhead.",
    match: /\b(moonlight|highlife|the record|the bed|in the song)\b/,
  },
  {
    id: "fits",
    said: "Find me drums that fit it.",
    reply:
      "Five records in the crate have drums. They are ranked by what was measured — the octave-folded tempo ratio, and the key where there is one — and the order is a suggestion, not a verdict. Press ▶ on a row to hear it under the session; press ▶ on the next one and it takes over on the same bar without stopping anything.",
    action: "rack-fits",
    hint: "Rows one and two are the same fit to within a fifth of a per cent, so the embedding breaks the tie. Row five has no measured tempo, says so, and you can hear what that costs.",
    match: /\b(drum|drums|break|breaks|fits|fit)\b/,
  },
  {
    id: "loops",
    said: "What loops are in Masquerade?",
    reply:
      "Three, ranked by the finder's score on the beat grid, each with the components behind the score. They are rows like any other: press play and they go under the session at the ratio it would take to fit.",
    action: "rack-loops",
    hint: "Now press ← in the panel header. The drums rack comes straight back, nothing is re-fetched, and the transport never stopped.",
    match: /\b(loop|loops|masquerade)\b/,
  },
  {
    id: "song",
    said: "Show me the song.",
    reply:
      "Lanes against a bar ruler. Drag a region to move it, drag its left edge to trim the start, split it at the playhead, mute a lane, pull a fader. Undo walks all of it back.",
    action: "song",
    hint: "Click a region and read the line above the buttons: which record, which of its bars, what was done to it. Trim a bar off the front and watch that line change.",
    match: /\b(song|timeline|arrangement|lanes)\b/,
  },
];

export function stepById(id: string): DemoStep | null {
  return DEMO_STEPS.find((s) => s.id === id) ?? null;
}

/**
 * The step a typed sentence means, or null.
 *
 * Deliberately keyword-shaped and deliberately second in line: the caller tries
 * `parseSessionCommand` first, so "solo the drums" moves a fader instead of
 * opening a rack about drums.
 */
export function matchStep(text: string): DemoStep | null {
  const s = text.trim().toLowerCase();
  if (s === "") return null;
  return DEMO_STEPS.find((step) => step.match.test(s)) ?? null;
}

/** Sentences that really are wired up, for the chat's empty state and its footer. */
export const COMMAND_EXAMPLES: readonly string[] = [
  "play",
  "loop bars 1 to 2",
  "solo the drums",
  "turn the drums down",
  "next",
  "keep it",
  "move the drums to bar 3",
  "trim it to 2 bars",
  "split it here",
  "snap to 16ths",
  "undo",
  "close the panel",
];

/** What the chat says to anything it is not wired up to answer. */
export function fallbackReply(): string {
  return "There is no model in this prototype — it holds no keys and reaches no network, so the conversation is four written turns. The command line is real, though: try “solo the drums”, “loop bars 1 to 2”, “move the drums to bar 3”, “next”, “keep it”, “undo”. Each one moves the control the mouse would have moved and says what it did.";
}
