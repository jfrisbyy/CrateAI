// The seam between the chat and the surfaces that live in the browser.
//
// What matters here, and what each group asserts:
//
//   one parser — a step the model says goes through the same
//   `parseSessionCommand` the composer's own command line uses, so the two
//   halves cannot drift;
//   failures are answers — a step naming a lane that is not there, or asking
//   for bars in a session with no tempo, comes back with the line the control
//   itself would have put in the chat, not silence and not a cheerful claim;
//   grounding — nothing the session block says is a musical fact except the
//   values read off a report row, with the method attached.

import { describe, expect, it } from "vitest";
import { fakeFile, fakeRegion, fakeSnapshot, fakeTrack } from "./fakes";
import {
  checkSessionCommand,
  grammarLines,
  noSessionText,
  planSteps,
  readSession,
  sessionFileIds,
  sessionLines,
  songShape,
  type SessionSnapshot,
} from "./surfaces";

const lines = (snapshot: SessionSnapshot, files = []) => sessionLines(snapshot, files).join("\n");

describe("a step is the session's own sentence, parsed by the session's own parser", () => {
  it("turns each step into the command the command line produces, with the control's own line", () => {
    const plan = planSteps(["solo the drums", "loop bars 9 to 16", "play"], fakeSnapshot());
    expect(plan.refused).toEqual([]);
    expect(plan.steps.map((s) => s.command)).toEqual([
      { kind: "solo", target: "drums", on: true },
      { kind: "loop-bars", fromBar: 9, toBar: 16 },
      { kind: "play" },
    ]);
    expect(plan.steps.map((s) => s.line)).toEqual(["soloed drums", "looping bars 9–16", "playing"]);
    expect(plan.steps.every((s) => s.bus === "session")).toBe(true);
  });

  it("routes the keyboard's verbs to the keyboard's bus, with its own line", () => {
    const plan = planSteps(["gate", "the 32 key layout"], fakeSnapshot({ keyboardOpen: true, openFileId: "f1" }));
    expect(plan.steps.map((s) => s.bus)).toEqual(["keyboard", "keyboard"]);
    expect(plan.steps[0]?.command).toEqual({ kind: "set-trigger", mode: "gate" });
    expect(plan.steps[0]?.line).toContain("gate");
  });

  it("refuses a keyboard verb when the instrument is not on screen rather than swallowing it", () => {
    const plan = planSteps(["gate"], fakeSnapshot({ keyboardOpen: false }));
    expect(plan.steps).toEqual([]);
    expect(plan.refused[0]?.note).toContain("not on screen");
  });

  it("refuses anything neither parser recognises, and says where the vocabulary is", () => {
    const plan = planSteps(["sidechain the pad to the kick"], fakeSnapshot());
    expect(plan.steps).toEqual([]);
    expect(plan.refused[0]).toEqual({ said: "sidechain the pad to the kick", note: expect.stringContaining("not one of the session's steps") });
  });

  it("carries the good steps and names the bad one, rather than refusing the lot", () => {
    const plan = planSteps(["solo the drums", "mute the horns"], fakeSnapshot());
    expect(plan.steps).toHaveLength(1);
    expect(plan.refused[0]?.note).toBe("nothing in the session is called horns.");
  });

  it("takes the arrangement verbs, the rack verbs and the chain verbs through the same path", () => {
    const snapshot = fakeSnapshot({
      selectedRegionId: "r1",
      focusTrackId: "t1",
      rack: { title: "on the panel", listed: false, rows: [], auditioning: 2 },
      openFileId: "f1",
    });
    const said = [
      "move it to bar 17",
      "trim the drums to 4 bars",
      "duplicate it",
      "snap to 16ths",
      "hear what fits this",
      "next",
      "keep it",
      "make the drums less muddy",
    ];
    const plan = planSteps(said, snapshot);
    expect(plan.refused).toEqual([]);
    expect(plan.steps.map((s) => s.command.kind)).toEqual([
      "move-region",
      "trim-region",
      "duplicate-region",
      "snap",
      "rack-fits",
      "audition-next",
      "commit",
      "fix",
    ]);
  });

  it("leaves an empty step out instead of refusing it", () => {
    expect(planSteps(["  ", "play"], fakeSnapshot()).steps).toHaveLength(1);
  });
});

describe("the vocabulary the model is shown is the vocabulary the parser takes", () => {
  // The grammar block is the one place a second copy of the verb list exists.
  // This runs every example in it through the parsers, so a form that drifted
  // out of the parser fails here rather than becoming a refusal in a session.
  const examples = grammarLines(null).flatMap((line) => {
    const forms = line.slice(line.indexOf(":") + 1);
    return forms.split("|").map((f) => f.trim()).filter((f) => f.length > 0);
  });

  it("shows a real grammar, not an empty one", () => {
    expect(examples.length).toBeGreaterThan(40);
  });

  it("parses every example it shows", () => {
    const snapshot = fakeSnapshot({
      selectedRegionId: "r1",
      focusTrackId: "t1",
      openFileId: "f1",
      keyboardOpen: true,
      undoLabel: "trim the start",
      redoLabel: "trim the start",
      rack: { title: "on the panel", listed: false, rows: [], auditioning: 1 },
    });
    // "the drums" is the one lane in the fixture; the rest of the examples name
    // lanes a fixture session does not have, so only the parse is asserted here.
    const unparsed = examples.filter((form) => planSteps([form], snapshot).refused.some((r) => r.note.includes("not one of the session's steps")));
    expect(unparsed).toEqual([]);
  });
});

describe("a step that cannot be carried out comes back in the words the control uses", () => {
  const snapshot = fakeSnapshot();

  it("says there is no lane by that name", () => {
    expect(checkSessionCommand({ kind: "mute", target: "horns", on: true }, snapshot)).toBe("nothing in the session is called horns.");
    expect(checkSessionCommand({ kind: "gain", target: "horns", db: -3 }, snapshot)).toBe("nothing in the session is called horns.");
    expect(checkSessionCommand({ kind: "remove-track", target: "horns" }, snapshot)).toBe("nothing in the session is called horns.");
  });

  it("refuses bars when nothing has measured a tempo, and never invents one", () => {
    const noTempo = fakeSnapshot({ tempo: null });
    expect(checkSessionCommand({ kind: "loop-bars", fromBar: 1, toBar: 5 }, noTempo)).toContain("no measured tempo");
    expect(checkSessionCommand({ kind: "move-region", target: "drums", toBar: 17, toS: null }, noTempo)).toContain("no measured tempo");
    expect(checkSessionCommand({ kind: "loop-seconds", fromS: 0, toS: 4 }, noTempo)).toBeNull();
  });

  it("answers the region question the panel answers: nothing selected, or which one", () => {
    expect(checkSessionCommand({ kind: "delete-region", target: "~selection" }, snapshot)).toContain("nothing is selected");
    const twoRegions = fakeSnapshot({
      arrangement: {
        tracks: [fakeTrack("t1", "Drums", "file-drums")],
        regions: [fakeRegion("r1", "t1", "file-drums"), fakeRegion("r2", "t1", "file-drums", { startS: 20 })],
      },
    });
    expect(checkSessionCommand({ kind: "duplicate-region", target: "drums" }, twoRegions)).toContain("2 regions");
  });

  it("says there is nothing to keep when nothing is auditioning, and nothing to undo when nothing was done", () => {
    expect(checkSessionCommand({ kind: "commit" }, snapshot)).toBe("nothing is auditioning, so there is nothing to keep.");
    expect(checkSessionCommand({ kind: "undo" }, snapshot)).toBe("there is nothing to undo yet.");
    expect(checkSessionCommand({ kind: "redo" }, snapshot)).toBe("there is nothing to redo.");
    const auditioning = fakeSnapshot({ rack: { title: "on the panel", listed: false, rows: [], auditioning: 3 } });
    expect(checkSessionCommand({ kind: "commit" }, auditioning)).toBeNull();
  });

  it("leaves a row it cannot see to the rack, and decides only when the whole rack is known", () => {
    const unlisted = fakeSnapshot({ rack: { title: "on the panel", listed: false, rows: [], auditioning: 1 } });
    expect(checkSessionCommand({ kind: "audition", index: 3 }, unlisted)).toBeNull();
    const listed = fakeSnapshot({
      rack: { title: "drums", listed: true, rows: [{ index: 1, title: "a break", reason: "vocal-free", confidence: 0.8 }], auditioning: null },
    });
    expect(checkSessionCommand({ kind: "audition", index: 3 }, listed)).toBe("there is no candidate 3 in the rack.");
    expect(checkSessionCommand({ kind: "audition", index: 1 }, listed)).toBeNull();
  });

  it("says there is nothing to rack against with no file open", () => {
    expect(checkSessionCommand({ kind: "rack-fits" }, snapshot)).toBe("no file is open, so there is nothing to rack against.");
    expect(checkSessionCommand({ kind: "rack-fits" }, fakeSnapshot({ openFileId: "f1" }))).toBeNull();
  });

  it("uses the same line the processing dock uses when no lane is under the hand", () => {
    expect(checkSessionCommand({ kind: "processing-reset", target: "~selection" }, snapshot)).toBe("nothing in the session is called the lane you are on.");
    expect(checkSessionCommand({ kind: "processing-reset", target: "~selection" }, fakeSnapshot({ focusTrackId: "t1" }))).toBeNull();
    expect(checkSessionCommand({ kind: "tune", target: "drums", cents: 20 }, snapshot)).toBeNull();
  });
});

describe("a question is never swallowed as a step", () => {
  it("leaves real conversational sentences to the model", () => {
    const said = [
      "why do these drums sound muddy",
      "what is in bar 17",
      "should i use gate or one-shot for drums",
      "solo the drums and tell me why they are quiet",
      "can you clean up the trumpet and tell me what you did",
      "remove the vocals from this record",
      "find me drums that fit this",
    ];
    const plan = planSteps(said, fakeSnapshot({ keyboardOpen: true, openFileId: "f1" }));
    expect(plan.steps).toEqual([]);
    expect(plan.refused).toHaveLength(said.length);
  });
});

describe("what the model is told about the open session", () => {
  it("says the grid, the transport, the lanes and what is selected, and calls them controls", () => {
    const text = lines(
      fakeSnapshot({ playing: true, positionS: 10.435, loop: { startS: 0, endS: 10.435 }, selectedRegionId: "r1", chains: [{ trackId: "t1", line: "250 Hz -4.0 dB" }] }),
    );
    expect(text).toContain("positions of controls");
    expect(text).toContain("92 BPM, 4/4, bar 1 is second 0");
    expect(text).toContain("playing at bar 5");
    expect(text).toContain("loop bar 1 to bar 5");
    expect(text).toContain("Drums");
    expect(text).toContain("chain: 250 Hz -4.0 dB");
    expect(text).toContain("selected region: on Drums");
  });

  it("says plainly that a session with no tempo has no bars", () => {
    expect(lines(fakeSnapshot({ tempo: null }))).toContain("no measured tempo, so the session has no bars");
  });

  it("states a record's tempo, key and bandwidth only from its report, with the method", () => {
    const file = fakeFile({ id: "file-drums" });
    const text = sessionLines(fakeSnapshot(), [file]).join("\n");
    expect(text).toContain("92 BPM (0.91)");
    expect(text).toContain("F minor (0.7)");
    expect(text).toContain("bandwidth not measured");
  });

  it("says a bandwidth that was measured, and names what measured it", () => {
    const file = fakeFile({ id: "file-drums" }, { spectral: { centroid_hz_mean: 0, stereo_width: 0, low_high_ratio_db: 0, method: "stft", bandwidth: { value: 13500, confidence: 0.9, method: "rolloff_0.99", notes: null } } });
    expect(sessionLines(fakeSnapshot(), [file]).join("\n")).toContain("bandwidth 13.5 kHz (rolloff_0.99)");
  });

  it("lists only the families that have something listening", () => {
    const empty = grammarLines(fakeSnapshot({ arrangement: { tracks: [], regions: [] } })).join("\n");
    expect(empty).toContain("transport:");
    expect(empty).not.toContain("song:");
    expect(empty).not.toContain("chain:");
    expect(empty).not.toContain("keyboard:");

    const full = grammarLines(fakeSnapshot({ keyboardOpen: true, openFileId: "f1" })).join("\n");
    expect(full).toContain("song:");
    expect(full).toContain("chain:");
    expect(full).toContain("rack:");
    expect(full).toContain("keyboard:");
  });

  it("says an empty session is empty rather than pretending there is a song", () => {
    expect(lines(fakeSnapshot({ arrangement: { tracks: [], regions: [] } }))).toContain("lanes: none yet");
  });

  it("teaches the vocabulary when there is no session at all", () => {
    expect(noSessionText()).toContain("no session open");
    expect(noSessionText()).toContain("transport:");
  });

  it("names every record the lanes point at, so the route can read their reports", () => {
    expect(sessionFileIds(fakeSnapshot())).toEqual(["file-drums"]);
  });
});

describe("reading the song", () => {
  it("answers what is in a bar, with each region's lineage", () => {
    const reading = readSession(fakeSnapshot(), { bar: 1 });
    expect(reading.text).toContain("bar 1: Drums (Masquerade, drums)");
    expect(reading.text).toContain("Masquerade");
    expect(reading.summary).toBe("bar 1: 1 region");
  });

  it("refuses a bar in a session with no tempo instead of inventing one", () => {
    expect(readSession(fakeSnapshot({ tempo: null }), { bar: 17 }).text).toContain("no measured tempo");
  });

  it("says nothing is in an empty bar rather than guessing", () => {
    expect(readSession(fakeSnapshot(), { bar: 40 }).text).toContain("nothing is in bar 40");
  });

  it("reads one lane with the separator, the take and the record's own bars", () => {
    const reading = readSession(fakeSnapshot({ chains: [{ trackId: "t1", line: "250 Hz -4.0 dB" }] }), { track: "drums" });
    expect(reading.text).toContain("chain: 250 Hz -4.0 dB");
    expect(reading.text).toContain("separated: bs_roformer");
    expect(reading.text).toContain("the record's own bars: 1–4");
  });

  it("says there is no lane by that name", () => {
    expect(readSession(fakeSnapshot(), { track: "horns" }).text).toBe("nothing in the session is called horns.");
  });

  it("falls back to the whole session, and shapes it as data", () => {
    expect(readSession(fakeSnapshot(), {}).summary).toBe("1 lanes, 1 regions");
    const shape = songShape(fakeSnapshot());
    expect(shape.tracks[0]).toMatchObject({ id: "t1", name: "Drums" });
    expect(shape.regions[0]).toMatchObject({ trackId: "t1", bar: 1 });
  });
});
