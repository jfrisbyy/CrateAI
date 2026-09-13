// The command line. Two properties matter equally: the commands a producer
// would actually type are understood, and everything else is left alone so the
// model still gets the conversation.

import { describe as group, expect, it } from "vitest";
import { ALL_TRACKS, describeCommand, parseSessionCommand, resolveTarget } from "./commands";
import type { SessionTrack } from "./types";

function track(id: string, name: string, provenance: string | null = null): SessionTrack {
  return { id, name, gain: 1, muted: false, soloed: false, fileId: null, origin: "file", provenance };
}

group("the transport by sentence", () => {
  it("understands the words a producer uses for the transport", () => {
    expect(parseSessionCommand("play")).toEqual({ kind: "play" });
    expect(parseSessionCommand("Play it.")).toEqual({ kind: "play" });
    expect(parseSessionCommand("stop")).toEqual({ kind: "stop" });
    expect(parseSessionCommand("pause")).toEqual({ kind: "pause" });
  });

  it("sets and clears the locators", () => {
    expect(parseSessionCommand("loop bars 9 to 16")).toEqual({ kind: "loop-bars", fromBar: 9, toBar: 16 });
    expect(parseSessionCommand("loop bar 1 through 5")).toEqual({ kind: "loop-bars", fromBar: 1, toBar: 5 });
    expect(parseSessionCommand("loop the first 8 bars")).toEqual({ kind: "loop-bars", fromBar: 1, toBar: 9 });
    expect(parseSessionCommand("loop 12 to 20s")).toEqual({ kind: "loop-seconds", fromS: 12, toS: 20 });
    expect(parseSessionCommand("no loop")).toEqual({ kind: "loop-off" });
    expect(parseSessionCommand("turn the loop off")).toEqual({ kind: "loop-off" });
  });

  it("refuses locators that are the wrong way round rather than guessing", () => {
    expect(parseSessionCommand("loop bars 16 to 9")).toBeNull();
    expect(parseSessionCommand("loop 20 to 12")).toBeNull();
  });
});

group("the mix by sentence", () => {
  it("mutes, unmutes, solos and unsolos a named lane", () => {
    expect(parseSessionCommand("mute the drums")).toEqual({ kind: "mute", target: "drums", on: true });
    expect(parseSessionCommand("unmute drums")).toEqual({ kind: "mute", target: "drums", on: false });
    expect(parseSessionCommand("solo the bass")).toEqual({ kind: "solo", target: "bass", on: true });
    expect(parseSessionCommand("unsolo everything")).toEqual({ kind: "solo", target: ALL_TRACKS, on: false });
  });

  it("moves a fader by a default step or by a stated one", () => {
    expect(parseSessionCommand("turn the drums down")).toEqual({ kind: "gain", target: "drums", db: -3 });
    expect(parseSessionCommand("turn the horns up 6db")).toEqual({ kind: "gain", target: "horns", db: 6 });
    expect(parseSessionCommand("the bass down 2 dB")).toEqual({ kind: "gain", target: "bass", db: -2 });
  });

  it("does not turn a conversation into a fader move", () => {
    expect(parseSessionCommand("what's up with these drums")).toBeNull();
    expect(parseSessionCommand("the low end is muddy, what's going on")).toBeNull();
  });
});

group("the rack by sentence", () => {
  it("moves through the candidates", () => {
    expect(parseSessionCommand("next")).toEqual({ kind: "audition-next" });
    expect(parseSessionCommand("try the next one")).toEqual({ kind: "audition-next" });
    expect(parseSessionCommand("previous")).toEqual({ kind: "audition-previous" });
    expect(parseSessionCommand("play the third one under this")).toEqual({ kind: "audition", index: 3 });
    expect(parseSessionCommand("audition 2")).toEqual({ kind: "audition", index: 2 });
    expect(parseSessionCommand("hear the 4th")).toEqual({ kind: "audition", index: 4 });
  });

  it("commits the one that won", () => {
    expect(parseSessionCommand("keep it")).toEqual({ kind: "commit" });
    expect(parseSessionCommand("add it to the session")).toEqual({ kind: "commit" });
  });

  it("opens a rack by name, and by what it is against", () => {
    expect(parseSessionCommand("rack drums")).toEqual({ kind: "rack", query: "drums" });
    expect(parseSessionCommand("hear some 90 bpm breaks")).toEqual({ kind: "rack", query: "90 bpm breaks" });
    expect(parseSessionCommand("hear what fits this")).toEqual({ kind: "rack-fits" });
    expect(parseSessionCommand("rack the loops here")).toEqual({ kind: "rack-loops" });
  });

  it("leaves a question alone even when it starts with a rack verb", () => {
    expect(parseSessionCommand("hear why this sounds muddy")).toBeNull();
    expect(parseSessionCommand("rack and explain what you find")).toBeNull();
  });

  it("dismisses and goes back", () => {
    expect(parseSessionCommand("close the panel")).toEqual({ kind: "panel", action: "close" });
    expect(parseSessionCommand("go back")).toEqual({ kind: "panel", action: "back" });
  });
});

group("what is left to the model", () => {
  it("passes questions and requests through untouched", () => {
    const conversation = [
      "find me drums that fit this",
      "why do these drums sound muddy",
      "separate the stems with the better model",
      "solo the drums and tell me why they are quiet",
      "can you loop bars 9 to 16 and explain what changed",
      "who produced this record",
      "what's in bar 17",
      "",
      "   ",
    ];
    for (const text of conversation) expect(parseSessionCommand(text), text).toBeNull();
  });
});

group("naming a lane", () => {
  const tracks = [track("t1", "Masquerade drums", "Masquerade, drums, 0:08–0:16"), track("t2", "Bass"), track("t3", "In The Shade break")];

  it("finds a lane by its exact name, then by a word in it", () => {
    expect(resolveTarget("bass", tracks)).toEqual(["t2"]);
    expect(resolveTarget("drums", tracks)).toEqual(["t1"]);
    expect(resolveTarget("in the shade", tracks)).toEqual(["t3"]);
  });

  it("falls back to the provenance line", () => {
    expect(resolveTarget("0:08", tracks)).toEqual(["t1"]);
  });

  it("says nothing rather than guessing a lane", () => {
    expect(resolveTarget("horns", tracks)).toBeNull();
    expect(resolveTarget("", tracks)).toBeNull();
  });

  it("takes everything when the sentence says everything", () => {
    expect(resolveTarget(ALL_TRACKS, tracks)).toEqual(["t1", "t2", "t3"]);
  });
});

group("saying what happened", () => {
  it("has a line for every command, in the same words as the control", () => {
    const commands = [
      { kind: "play" as const },
      { kind: "pause" as const },
      { kind: "stop" as const },
      { kind: "loop-off" as const },
      { kind: "loop-bars" as const, fromBar: 9, toBar: 16 },
      { kind: "loop-seconds" as const, fromS: 1, toS: 2 },
      { kind: "mute" as const, target: "drums", on: true },
      { kind: "solo" as const, target: ALL_TRACKS, on: false },
      { kind: "gain" as const, target: "drums", db: -3 },
      { kind: "audition" as const, index: 3 },
      { kind: "audition-next" as const },
      { kind: "audition-previous" as const },
      { kind: "audition-off" as const },
      { kind: "commit" as const },
      { kind: "rack" as const, query: "drums" },
      { kind: "rack-fits" as const },
      { kind: "rack-loops" as const },
      { kind: "panel" as const, action: "close" as const },
      { kind: "panel" as const, action: "back" as const },
    ];
    for (const command of commands) expect(describeCommand(command).length).toBeGreaterThan(0);
    expect(describeCommand({ kind: "loop-bars", fromBar: 9, toBar: 16 })).toBe("looping bars 9–16");
    expect(describeCommand({ kind: "solo", target: ALL_TRACKS, on: false })).toBe("unsoloed everything");
  });
});
