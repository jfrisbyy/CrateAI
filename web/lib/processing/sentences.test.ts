// The processing verbs on the command line (lib/session/commands.ts).
//
// They live in a test of their own so the transport's own test file is not
// disturbed, but they are held to exactly the same two standards it holds:
// the sentences a producer would actually type move the visible control, and
// everything that is a question still reaches the model untouched.

import { describe as group, expect, it } from "vitest";
import { describeCommand, parseSessionCommand, SELECTION, type SessionCommand } from "@/lib/session/commands";
import { proposeForComplaint, proposeForPhrase } from "./complaints";
import { applyProposal } from "./moves";
import { bandOf, defaultProcessing } from "./chain";

function parse(text: string): SessionCommand | null {
  return parseSessionCommand(text);
}

group("opening and clearing a chain", () => {
  it("opens the chain on a named lane or on the one in hand", () => {
    expect(parse("show the eq on the horns")).toEqual({ kind: "processing", target: "horns" });
    expect(parse("open the processing")).toEqual({ kind: "processing", target: SELECTION });
    expect(parse("show the eq")).toEqual({ kind: "processing", target: SELECTION });
  });

  it("clears one", () => {
    expect(parse("reset the eq on the drums")).toEqual({ kind: "processing-reset", target: "drums" });
    expect(parse("clear the processing")).toEqual({ kind: "processing-reset", target: SELECTION });
  });
});

group("the A/B, which is the control a producer reaches for most", () => {
  it("toggles with the words a producer uses for it", () => {
    expect(parse("a/b the drums")).toEqual({ kind: "processing-bypass", target: "drums", on: null });
    expect(parse("a/b")).toEqual({ kind: "processing-bypass", target: SELECTION, on: null });
    expect(parse("compare the horns")).toEqual({ kind: "processing-bypass", target: "horns", on: null });
  });

  it("sets it either way when the producer is explicit", () => {
    expect(parse("bypass the drums")).toEqual({ kind: "processing-bypass", target: "drums", on: true });
    expect(parse("engage the drums")).toEqual({ kind: "processing-bypass", target: "drums", on: false });
    expect(parse("unbypass the horns")).toEqual({ kind: "processing-bypass", target: "horns", on: false });
    expect(parse("bypass the eq on the trumpet")).toEqual({ kind: "processing-bypass", target: "trumpet", on: true });
  });
});

group("an EQ move said out loud", () => {
  it("cuts and boosts at a named frequency, on a named lane", () => {
    expect(parse("cut 300 on the drums")).toEqual({ kind: "eq", target: "drums", phrase: { move: "cut", atHz: 300, region: null, db: null } });
    expect(parse("boost 4k on the horns")).toEqual({ kind: "eq", target: "horns", phrase: { move: "boost", atHz: 4000, region: null, db: null } });
    expect(parse("dip 1.2khz by 3db on the bass")).toEqual({ kind: "eq", target: "bass", phrase: { move: "cut", atHz: 1200, region: null, db: 3 } });
  });

  it("understands a part of the spectrum instead of a number", () => {
    expect(parse("cut the low mids on the horns")).toEqual({ kind: "eq", target: "horns", phrase: { move: "cut", atHz: null, region: "low mids", db: null } });
    expect(parse("boost the highs")).toEqual({ kind: "eq", target: SELECTION, phrase: { move: "boost", atHz: null, region: "highs", db: null } });
  });

  it("puts the pass filters on their own slots", () => {
    expect(parse("high-pass the bass at 80")).toEqual({ kind: "eq", target: "bass", phrase: { move: "highpass", atHz: 80, region: null, db: null } });
    expect(parse("low pass the horns at 9k")).toEqual({ kind: "eq", target: "horns", phrase: { move: "lowpass", atHz: 9000, region: null, db: null } });
  });

  it("refuses a frequency that is not one, rather than inventing a band", () => {
    expect(parse("cut 40000 on the drums")).toBeNull();
    expect(parse("cut 2 on the drums")).toBeNull();
  });

  it("still lets an arrangement trim through, because 'cut' is that verb too", () => {
    expect(parse("cut the drums to 4 bars")).toEqual({ kind: "trim-region", target: "drums", bars: 4, seconds: null });
  });
});

group("tuning", () => {
  it("takes cents and semitones", () => {
    expect(parse("tune the horns up 20 cents")).toEqual({ kind: "tune", target: "horns", cents: 20 });
    expect(parse("tune the trumpet down 1 semitone")).toEqual({ kind: "tune", target: "trumpet", cents: -100 });
  });
});

group("a complaint", () => {
  it("catches the sentence the owner actually types", () => {
    expect(parse("clean up the trumpet")).toEqual({ kind: "fix", target: "trumpet", complaint: "clean up the trumpet" });
    expect(parse("clean the horns up")).toMatchObject({ kind: "fix", target: "horns" });
    expect(parse("sort out the drums")).toMatchObject({ kind: "fix", target: "drums" });
  });

  it("catches the owner's own sentence, which has two clauses in it", () => {
    // The rest of the parser refuses a sentence with two clauses on principle.
    // A trailing "clean it up" is an instruction however the sentence starts,
    // so it is the one exception — and only when nothing in it is a question.
    expect(parse("this trumpet sounds awful, clean it up")).toEqual({ kind: "fix", target: SELECTION, complaint: "this trumpet sounds awful, clean it up" });
    expect(parse("it's a mess, sort it out")).toMatchObject({ kind: "fix", target: SELECTION });
    expect(parse("fix it")).toMatchObject({ kind: "fix", target: SELECTION });
    // still a question, and still whole
    expect(parse("why does this sound bad, clean it up")).toBeNull();
    expect(parse("tell me what is wrong and clean it up")).toBeNull();
  });

  it("catches the comparative forms and keeps the words that say how hard", () => {
    expect(parse("make the horns less muddy")).toEqual({ kind: "fix", target: "horns", complaint: "make it less muddy" });
    expect(parse("make the trumpet brighter")).toEqual({ kind: "fix", target: "trumpet", complaint: "make it brighter" });
    expect(parse("the drums are too boomy")).toMatchObject({ kind: "fix", target: "drums" });
  });

  it("hands the complaint on in words the decision can read", () => {
    const command = parse("make the horns less muddy");
    if (command?.kind !== "fix") throw new Error("expected a fix");
    const proposal = proposeForComplaint(command.complaint);
    expect(proposal).not.toBeNull();
    const out = applyProposal(defaultProcessing(), proposal!);
    expect(bandOf(out.processing, "lo").gainDb).toBeLessThan(0);
  });
});

group("the master bus", () => {
  it("turns the limiter on and off", () => {
    expect(parse("limit the master")).toEqual({ kind: "limiter", on: true });
    expect(parse("turn the limiter on")).toEqual({ kind: "limiter", on: true });
    expect(parse("turn the limiter off")).toEqual({ kind: "limiter", on: false });
    expect(parse("no limiter")).toEqual({ kind: "limiter", on: false });
  });
});

group("what is still left to the model", () => {
  it("passes every one of these through untouched", () => {
    const conversation = [
      "why do these drums sound muddy",
      "the low end is muddy, what's going on",
      "what would you eq out of this",
      "is this too muddy to use",
      "can you clean up the trumpet and tell me what you did",
      "explain the eq you put on the horns",
      "does this need an eq",
      "clean up the arrangement and bounce it",
      "what's the difference between a shelf and a bell",
      "undo the damage to the low end",
      "remove the vocals from this record",
      "cut this record up into chops",
    ];
    for (const text of conversation) expect(parse(text), text).toBeNull();
  });

  it("does not turn a fader move into an EQ move", () => {
    expect(parse("turn the drums down")).toEqual({ kind: "gain", target: "drums", db: -3 });
    expect(parse("turn the horns up 6db")).toEqual({ kind: "gain", target: "horns", db: 6 });
  });
});

group("every processing command has a line", () => {
  it("says what it did in the words the control uses", () => {
    const commands: SessionCommand[] = [
      { kind: "processing", target: "horns" },
      { kind: "processing-bypass", target: "horns", on: true },
      { kind: "processing-bypass", target: "horns", on: false },
      { kind: "processing-bypass", target: "horns", on: null },
      { kind: "processing-reset", target: "horns" },
      { kind: "fix", target: "horns", complaint: "muddy" },
      { kind: "eq", target: "horns", phrase: { move: "cut", atHz: 300, region: null, db: null } },
      { kind: "tune", target: "horns", cents: -20 },
      { kind: "limiter", on: true },
      { kind: "limiter", on: false },
    ];
    for (const command of commands) {
      const line = describeCommand(command);
      expect(line, command.kind).toBeTruthy();
      expect(line.length, command.kind).toBeLessThan(80);
    }
    expect(describeCommand({ kind: "tune", target: "horns", cents: -20 })).toBe("tuned horns down 20 cents");
  });
});

group("a phrase and a complaint reach the same controls", () => {
  it("puts a spoken cut on the same band a dragged one lands on", () => {
    const spoken = applyProposal(defaultProcessing(), proposeForPhrase({ move: "cut", atHz: 250, region: null, db: 4 }));
    const complained = applyProposal(defaultProcessing(), proposeForComplaint("muddy")!);
    expect(bandOf(spoken.processing, "lo").id).toBe(bandOf(complained.processing, "lo").id);
    expect(bandOf(spoken.processing, "lo").gainDb).toBe(-4);
  });
});
