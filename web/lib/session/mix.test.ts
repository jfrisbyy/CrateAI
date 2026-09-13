import { describe as group, expect, it } from "vitest";
import { anySoloed, audible, clearSolo, dbFromGain, gainFromDb, mixOf, toggleMute, toggleSolo, trackGain } from "./mix";
import type { SessionTrack } from "./types";

function track(id: string, partial: Partial<SessionTrack> = {}): SessionTrack {
  return { id, name: id, gain: 1, muted: false, soloed: false, fileId: null, origin: "file", provenance: null, ...partial };
}

group("solo and mute", () => {
  it("plays everything when nothing is soloed", () => {
    const tracks = [track("a"), track("b")];
    expect(anySoloed(tracks)).toBe(false);
    expect(mixOf(tracks)).toEqual(new Map([["a", 1], ["b", 1]]));
  });

  it("silences the rest of the session when one lane is soloed", () => {
    const tracks = [track("a", { soloed: true, gain: 0.8 }), track("b"), track("c")];
    expect(mixOf(tracks)).toEqual(new Map([["a", 0.8], ["b", 0], ["c", 0]]));
  });

  it("lets two lanes be soloed together", () => {
    const tracks = [track("a", { soloed: true }), track("b", { soloed: true }), track("c")];
    expect(mixOf(tracks)).toEqual(new Map([["a", 1], ["b", 1], ["c", 0]]));
  });

  it("mutes a soloed lane: mute wins on the same lane", () => {
    const tracks = [track("a", { soloed: true, muted: true }), track("b")];
    // nothing is left soloed, so the session is not in solo mode and b is heard
    expect(anySoloed(tracks)).toBe(false);
    expect(mixOf(tracks)).toEqual(new Map([["a", 0], ["b", 1]]));
  });

  it("keeps a gain but reports zero while the lane is not heard", () => {
    const muted = track("a", { muted: true, gain: 0.5 });
    expect(trackGain(muted, false)).toBe(0);
    expect(muted.gain).toBe(0.5); // the fader has not moved; unmuting restores it
    expect(audible(muted, false)).toBe(false);
  });

  it("clamps a nonsense gain instead of passing it to a gain node", () => {
    expect(trackGain(track("a", { gain: Number.NaN }), false)).toBe(1);
    expect(trackGain(track("a", { gain: -3 }), false)).toBe(0);
    expect(trackGain(track("a", { gain: 99 }), false)).toBe(4);
  });

  it("toggles are pure and leave the other lanes alone", () => {
    const tracks = [track("a"), track("b")];
    expect(toggleSolo(tracks, "a")[0]?.soloed).toBe(true);
    expect(toggleSolo(tracks, "a")[1]?.soloed).toBe(false);
    expect(toggleMute(tracks, "b")[1]?.muted).toBe(true);
    expect(tracks[0]?.soloed).toBe(false); // the input was not mutated
    expect(clearSolo([track("a", { soloed: true })])[0]?.soloed).toBe(false);
  });
});

group("decibels", () => {
  it("round-trips through the fader", () => {
    for (const db of [-48, -12, -6, 0, 6]) expect(dbFromGain(gainFromDb(db))).toBeCloseTo(db, 6);
  });

  it("treats the bottom of the fader as silence", () => {
    expect(gainFromDb(-60)).toBe(0);
    expect(gainFromDb(-80)).toBe(0);
    expect(dbFromGain(0)).toBe(-60);
  });

  it("puts unity at 0 dB and -6 dB at half amplitude", () => {
    expect(gainFromDb(0)).toBeCloseTo(1, 9);
    expect(gainFromDb(-6)).toBeCloseTo(0.501, 3);
  });
});
