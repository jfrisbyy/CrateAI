// A lane's head. The three controls a producer reaches for while deciding are
// the ones that have to be one click away, and each of them has to say what it
// does — mute in particular, because "the audio keeps running" is the reason
// unmuting lands on the beat instead of restarting the region.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import type { SessionTrack } from "@/lib/session/types";
import { LaneHeader } from "./LaneHeader";

function track(overrides: Partial<SessionTrack> = {}): SessionTrack {
  return { id: "t1", name: "Masquerade drums", gain: 1, muted: false, soloed: false, fileId: "f1", origin: "candidate", provenance: "Masquerade, drums, separated: separator-a", ...overrides };
}

function render(overrides: Partial<Parameters<typeof LaneHeader>[0]> = {}) {
  return renderToStaticMarkup(
    <LaneHeader
      track={track()}
      audible
      waiting={false}
      regionCount={3}
      onMute={() => undefined}
      onSolo={() => undefined}
      onGain={() => undefined}
      onRemove={() => undefined}
      onMoveUp={() => undefined}
      onMoveDown={() => undefined}
      canMoveUp
      canMoveDown
      {...overrides}
    />,
  );
}

group("the lane's head", () => {
  it("names the lane and carries its provenance where a producer can read it", () => {
    const html = render();
    expect(html).toContain("Masquerade drums");
    expect(html).toContain("separated: separator-a");
  });

  it("shows how much material is on it", () => {
    expect(render({ regionCount: 3 })).toContain(">3<");
  });

  it("has mute, solo and a level, and says why mute is musical", () => {
    const html = render();
    expect(html).toContain(">M<");
    expect(html).toContain(">S<");
    expect(html).toContain("the audio keeps running");
    expect(html).toContain("level in decibels");
  });

  it("reflects the state of mute and solo rather than only styling them", () => {
    expect(render({ track: track({ muted: true }) })).toContain('aria-pressed="true"');
    expect(render({ track: track({ soloed: true }) })).toContain('aria-pressed="true"');
    expect(render()).not.toContain('aria-pressed="true"');
  });

  it("says the lane is still decoding instead of looking empty", () => {
    expect(render({ waiting: true })).toContain("decoding");
  });

  it("stops offering a restack that has nowhere to go", () => {
    const html = render({ canMoveUp: false, canMoveDown: false });
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(2);
  });

  it("offers to take the lane out, and says undo brings it back", () => {
    expect(render()).toContain("undo brings it back");
  });
});
