// The inspector is the part a normal DAW does not have: a block of audio that
// can say it is bars 9 to 16 of a named record, separated a particular way,
// resampled by a particular ratio — with the measurement behind every claim.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import type { RegionLineage } from "@/lib/session/lineage";
import type { SessionTempo } from "@/lib/session/time";
import type { SessionRegion } from "@/lib/session/types";
import { RegionInspector } from "./RegionInspector";

const NINETY: SessionTempo = { bpm: 90, beatsPerBar: 4 };
const BAR = (60 / 90) * 4;

function lineage(overrides: Partial<RegionLineage> = {}): RegionLineage {
  return {
    fileId: "file-1",
    fileName: "Masquerade",
    parentFileId: null,
    kind: "loop",
    stem: "drums",
    separationModel: "separator-a",
    separationModelLabel: "the strong separator",
    takeStartS: 8,
    takeEndS: 8 + BAR * 4,
    downbeatS: 8,
    sourceDurationS: 180,
    sourceBpm: 90,
    sourceBeatsPerBar: 4,
    cents: 0,
    stretch: 1,
    candidateId: "loop:abc",
    reason: "4 bars on the grid",
    confidence: 0.82,
    ...overrides,
  };
}

function region(overrides: Partial<SessionRegion> = {}): SessionRegion {
  return { id: "r1", trackId: "t1", sourceId: "file-1", startS: BAR * 16, durationS: BAR * 4, offsetS: 8, gain: 1, lineage: lineage(), ...overrides };
}

function render(props: Partial<Parameters<typeof RegionInspector>[0]> = {}) {
  return renderToStaticMarkup(
    <RegionInspector
      region={region()}
      laneName="Drums"
      tempo={NINETY}
      onMoveToBar={() => undefined}
      onLengthBars={() => undefined}
      onGain={() => undefined}
      onDuplicate={() => undefined}
      onSplit={() => undefined}
      onDelete={() => undefined}
      onLoopRegion={() => undefined}
      {...props}
    />,
  );
}

group("what the selected region is", () => {
  it("names the record, the stem, its own bars and the separation", () => {
    const html = render();
    expect(html).toContain("Masquerade");
    expect(html).toContain("drums");
    expect(html).toContain("bars 1–4");
    expect(html).toContain("separated: separator-a");
    expect(html).toContain("Drums"); // the lane it is on
  });

  it("puts the measurement behind every claim in its title, never a bare number", () => {
    const html = render({ region: region({ rate: 0.964 }) });
    expect(html).toContain("×0.964");
    expect(html).toContain("cents"); // the pitch the resample moves
    expect(html).toContain("the way a sampler does");
  });

  it("carries the reason it was offered, with its confidence", () => {
    const html = render();
    expect(html).toContain("4 bars on the grid");
    expect(html).toContain("confidence 0.82");
  });

  it("shows the seconds of the record that are actually sounding", () => {
    expect(render()).toContain("of the record");
  });
});

group("the numbers are editable, because an output you cannot correct is not done", () => {
  it("offers the start bar and the length in bars", () => {
    const html = render();
    expect(html).toContain('aria-label="Start bar"');
    expect(html).toContain('value="17"'); // bar 17: sixteen bars in
    expect(html).toContain('aria-label="Length in bars"');
    expect(html).toContain('value="4"');
  });

  it("disables the session's bar boxes when the session has no measured tempo, instead of guessing bars", () => {
    const html = render({ tempo: null });
    expect(html).toContain('aria-label="Start bar"');
    expect(html).toContain("disabled");
    expect(html).toContain('value=""'); // no bar number, because the session has no bars
    // but the record's own bars survive: they are counted from the record's
    // measured tempo, which is a different measurement from the session's grid
    expect(html).toContain("bars 1–4");
  });

  it("offers the same edits the mouse and the sentence make", () => {
    const html = render();
    expect(html).toContain("Duplicate");
    expect(html).toContain("Split at playhead");
    expect(html).toContain("Loop it");
    expect(html).toContain("Delete");
  });
});

group("nothing selected", () => {
  it("says what to do rather than showing an empty form", () => {
    const html = render({ region: null });
    expect(html).toContain("Click a region");
    expect(html).toContain("drag an edge to trim");
  });
});
