// A region on the timeline, rendered. The assertions are about what a producer
// can actually see and grab: the lineage line, the bars of the record it is,
// the two separate trim handles, and the fact that a sliver too narrow to grab
// does not pretend to have them.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import type { RegionLineage } from "@/lib/session/lineage";
import type { SessionRegion } from "@/lib/session/types";
import { RegionBlock } from "./RegionBlock";

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
  return { id: "r1", trackId: "t1", sourceId: "file-1", startS: 0, durationS: BAR * 4, offsetS: 8, gain: 1, lineage: lineage(), ...overrides };
}

function render(overrides: Partial<Parameters<typeof RegionBlock>[0]> = {}) {
  return renderToStaticMarkup(
    <RegionBlock
      region={region()}
      x={120}
      widthPx={240}
      selected={false}
      ghosted={false}
      waiting={false}
      peaks={null}
      sourceDurationS={180}
      onGrab={() => undefined}
      onSelect={() => undefined}
      {...overrides}
    />,
  );
}

group("a region says what it is", () => {
  it("carries the whole lineage in its title, so hovering it answers the question", () => {
    const html = render();
    expect(html).toContain("Masquerade");
    expect(html).toContain("drums");
    expect(html).toContain("bars 1–4");
    expect(html).toContain("separated: separator-a");
  });

  it("shows the bars of the record it now is, after a trim", () => {
    // a bar off the front: it is bars 2-4 of the record now
    const trimmed = region({ startS: BAR, offsetS: 8 + BAR, durationS: BAR * 3 });
    expect(render({ region: trimmed })).toContain("bars 2–4");
  });

  it("says it is still decoding rather than drawing a silent block", () => {
    expect(render({ waiting: true })).toContain("decoding");
  });

  it("is placed and sized in pixels the viewport worked out", () => {
    const html = render({ x: 120, widthPx: 240 });
    expect(html).toContain("left:120px");
    expect(html).toContain("width:240px");
  });

  it("marks the selected one, which is the region a sentence means by &ldquo;it&rdquo;", () => {
    expect(render({ selected: true })).toContain('data-selected="true"');
    expect(render({ selected: false })).toContain('data-selected="false"');
  });
});

group("the two edges are two different edits", () => {
  it("offers a start handle and an end handle, each saying what it does", () => {
    const html = render();
    expect(html).toContain("Trim the start");
    expect(html).toContain("moves where the region begins");
    expect(html).toContain("Trim the end");
    expect(html).toContain("changes only how long the region sounds");
  });

  it("drops the handles on a sliver too narrow to grab them apart", () => {
    const html = render({ widthPx: 6 });
    expect(html).not.toContain("Trim the start");
    expect(html).toContain("Drag to move"); // the body is still there
  });
});
