import { describe, expect, it } from "vitest";
import { describeKeyboardCommand, parseKeyboardCommand } from "./commands";

describe("the instrument's command line", () => {
  it("switches the trigger", () => {
    expect(parseKeyboardCommand("gate")).toEqual({ kind: "set-trigger", mode: "gate" });
    expect(parseKeyboardCommand("switch to gate")).toEqual({ kind: "set-trigger", mode: "gate" });
    expect(parseKeyboardCommand("one-shot")).toEqual({ kind: "set-trigger", mode: "one-shot" });
    expect(parseKeyboardCommand("one shot mode")).toEqual({ kind: "set-trigger", mode: "one-shot" });
  });

  it("switches chop and note mode", () => {
    expect(parseKeyboardCommand("note mode")).toEqual({ kind: "set-play", mode: "note" });
    expect(parseKeyboardCommand("play it chromatically")).toEqual({ kind: "set-play", mode: "note" });
    expect(parseKeyboardCommand("chop mode")).toEqual({ kind: "set-play", mode: "chop" });
  });

  it("picks a layout by its size or by name", () => {
    expect(parseKeyboardCommand("8 keys")).toEqual({ kind: "set-layout", layout: "8" });
    expect(parseKeyboardCommand("use the 24 key layout")).toEqual({ kind: "set-layout", layout: "24" });
    expect(parseKeyboardCommand("switch to 32 pads")).toEqual({ kind: "set-layout", layout: "32" });
    expect(parseKeyboardCommand("the full keyboard")).toEqual({ kind: "set-layout", layout: "full" });
    expect(parseKeyboardCommand("sixteen keys")).toEqual({ kind: "set-layout", layout: "16" });
    expect(parseKeyboardCommand("12 keys")).toBeNull(); // there is no such preset, so it is not a command
  });

  it("moves the root in note mode", () => {
    expect(parseKeyboardCommand("root on 5")).toEqual({ kind: "set-root", key: "5" });
    expect(parseKeyboardCommand("put the root key w")).toEqual({ kind: "set-root", key: "w" });
  });

  it("asks for cuts, by material when the producer says which", () => {
    expect(parseKeyboardCommand("propose cuts")).toEqual({ kind: "propose-cuts", material: null });
    expect(parseKeyboardCommand("cuts on the transients")).toEqual({ kind: "propose-cuts", material: "break" });
    expect(parseKeyboardCommand("slices for melodic")).toEqual({ kind: "propose-cuts", material: "melodic" });
    expect(parseKeyboardCommand("cuts on sections")).toEqual({ kind: "propose-cuts", material: "phrase" });
  });

  it("orders the kit", () => {
    expect(parseKeyboardCommand("sort the kit by hit class")).toEqual({ kind: "order-kit", strategy: "hit-class" });
    expect(parseKeyboardCommand("order the pads by pitch")).toEqual({ kind: "order-kit", strategy: "pitch" });
    expect(parseKeyboardCommand("back to file order")).toEqual({ kind: "order-kit", strategy: "file" });
    expect(parseKeyboardCommand("sort the kit by vibe")).toBeNull();
  });

  it("drives the recorder", () => {
    expect(parseKeyboardCommand("record")).toEqual({ kind: "record", bars: null });
    expect(parseKeyboardCommand("record 4 bars")).toEqual({ kind: "record", bars: 4 });
    expect(parseKeyboardCommand("record two bars")).toEqual({ kind: "record", bars: 2 });
    expect(parseKeyboardCommand("record until i stop")).toEqual({ kind: "record", bars: null });
    expect(parseKeyboardCommand("stop recording")).toEqual({ kind: "stop-record" });
    expect(parseKeyboardCommand("clear the take")).toEqual({ kind: "clear-take" });
  });

  it("cleans a take by an amount, not all or nothing", () => {
    expect(parseKeyboardCommand("tighten the take by 40%")).toEqual({ kind: "clean-take", tighten: 0.4 });
    expect(parseKeyboardCommand("tighten it 100%")).toEqual({ kind: "clean-take", tighten: 1 });
    expect(parseKeyboardCommand("clean it up")).toEqual({ kind: "clean-take", tighten: null });
    expect(parseKeyboardCommand("keep the cleaned take")).toEqual({ kind: "use-cleaned" });
  });

  it("asks for variations and takes one", () => {
    expect(parseKeyboardCommand("suggest patterns")).toEqual({ kind: "suggest-patterns" });
    expect(parseKeyboardCommand("use the second one")).toEqual({ kind: "use-pattern", index: 2 });
    expect(parseKeyboardCommand("keep the 3rd variation")).toEqual({ kind: "use-pattern", index: 3 });
  });

  it("plays a pad, so the mouse and the sentence reach the same key", () => {
    expect(parseKeyboardCommand("play q")).toEqual({ kind: "play-pad", key: "q" });
    expect(parseKeyboardCommand("hit pad 3")).toEqual({ kind: "play-pad", key: "3" });
    expect(parseKeyboardCommand("tap key w")).toEqual({ kind: "play-pad", key: "w" });
    expect(parseKeyboardCommand("play the whole record")).toBeNull();
  });

  it("takes, adds, moves and removes cuts", () => {
    expect(parseKeyboardCommand("cut it")).toEqual({ kind: "cut" });
    expect(parseKeyboardCommand("make the chops")).toEqual({ kind: "cut" });
    expect(parseKeyboardCommand("add a cut at the playhead")).toEqual({ kind: "add-cut" });
    expect(parseKeyboardCommand("remove cut 3")).toEqual({ kind: "remove-cut", index: 3 });
    expect(parseKeyboardCommand("move cut 12 to the playhead")).toEqual({ kind: "move-cut", index: 12 });
  });

  it("swaps two pads, which is the one command with a conjunction in it", () => {
    expect(parseKeyboardCommand("swap pads 3 and 5")).toEqual({ kind: "swap-pads", a: 3, b: 5 });
    expect(parseKeyboardCommand("swap 1 with 2")).toEqual({ kind: "swap-pads", a: 1, b: 2 });
    expect(parseKeyboardCommand("swap the drums and tell me why")).toBeNull();
  });

  it("moves the recorder's own controls, not a second copy of them", () => {
    expect(parseKeyboardCommand("click off")).toEqual({ kind: "click", on: false });
    expect(parseKeyboardCommand("metronome on")).toEqual({ kind: "click", on: true });
    expect(parseKeyboardCommand("save the take as midi")).toEqual({ kind: "save-midi" });
    expect(parseKeyboardCommand("collapse the flams")).toEqual({ kind: "collapse-flams", on: true });
    expect(parseKeyboardCommand("leave the flams")).toEqual({ kind: "collapse-flams", on: false });
    expect(parseKeyboardCommand("the one i played")).toEqual({ kind: "use-played" });
    // A question word is a question, even about the take: it goes to the model.
    expect(parseKeyboardCommand("what did i play")).toBeNull();
  });

  it("sends the take to the session, and silences everything", () => {
    expect(parseKeyboardCommand("put the take in the session")).toEqual({ kind: "keep-take" });
    expect(parseKeyboardCommand("all off")).toEqual({ kind: "all-off" });
  });

  it("leaves a conversation alone: a question must reach the model intact", () => {
    const conversational = [
      "why does gate mode click",
      "what does note mode do to the length",
      "should i use gate or one-shot for drums",
      "can you sort the kit by hit class and tell me why",
      "how many keys can a laptop register at once",
      "tighten the take and then suggest patterns",
      "which layout is best for a break",
      "is one-shot the same as an mpc",
    ];
    for (const sentence of conversational) expect(parseKeyboardCommand(sentence)).toBeNull();
  });

  it("has a line for every command, in the same words the controls use", () => {
    const commands = [
      "play q",
      "cut it",
      "add a cut at the playhead",
      "remove cut 3",
      "move cut 2 to the playhead",
      "swap pads 3 and 5",
      "click off",
      "save the take as midi",
      "collapse the flams",
      "the one i played",
      "gate",
      "note mode",
      "use the 24 key layout",
      "root on 5",
      "propose cuts",
      "sort the kit by hit class",
      "record 4 bars",
      "stop recording",
      "clear the take",
      "tighten the take by 40%",
      "keep the cleaned take",
      "suggest patterns",
      "use the second one",
      "put the take in the session",
      "all off",
    ];
    for (const sentence of commands) {
      const command = parseKeyboardCommand(sentence);
      expect(command, sentence).not.toBeNull();
      expect(describeKeyboardCommand(command!).length).toBeGreaterThan(0);
    }
    expect(describeKeyboardCommand({ kind: "set-trigger", mode: "gate" })).toContain("while it is down");
    expect(describeKeyboardCommand({ kind: "record", bars: 4 })).toBe("recording 4 bars.");
  });

  it("is not fooled by an empty line", () => {
    expect(parseKeyboardCommand("")).toBeNull();
    expect(parseKeyboardCommand("   ")).toBeNull();
  });
});
