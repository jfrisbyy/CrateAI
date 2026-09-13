// The grid draws what the mapping says and nothing of its own: the keys in the
// rows they sit in, the slice under each one in chop mode, the interval under
// each one in note mode. The point of the test is that the picture and the
// engine read the same pure function, so a producer's "R" is one thing.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import { PadGrid } from "@/components/chops/PadGrid";
import { KitControls } from "@/components/keyboard/KitControls";
import type { ChopWithFile } from "@/lib/api/chops";
import { bindPads } from "@/lib/pads/bindings";
import { defaultKit, setLayout, setPlay, setTrigger } from "@/lib/pads/kit";
import type { KitState } from "@/components/keyboard/useKit";

const chop = (index: number, fileId: string, name: string): ChopWithFile => ({
  id: `chop-${index}`,
  user_id: "u",
  source_file_id: "src",
  start_s: index,
  end_s: index + 1,
  index,
  name,
  chop_file_id: fileId,
  created_at: "2026-09-13T00:00:00Z",
  file: null,
});

const CHOPS = [chop(0, "f0", "kick"), chop(1, "f1", "snare"), chop(2, "f2", "hat")];

function grid(overrides: Partial<Parameters<typeof PadGrid>[0]> = {}) {
  const kit = overrides.kit ?? defaultKit();
  return renderToStaticMarkup(
    <PadGrid
      bindings={bindPads(CHOPS, [], kit.order.length)}
      kit={kit}
      lit={new Set()}
      held={new Set()}
      statuses={{ f0: "ready", f1: "ready", f2: "loading" }}
      onPress={() => undefined}
      onRelease={() => undefined}
      {...overrides}
    />,
  );
}

group("the pad grid", () => {
  it("draws the sixteen in four rows of four, with their key caps", () => {
    const html = grid();
    expect(html).toContain(">1<");
    expect(html).toContain(">I<");
    expect(html).toContain("kick");
    expect(html).toContain("Pad 1, kick");
    expect((html.match(/data-pad=/g) ?? []).length).toBe(16);
  });

  it("draws every key of a bigger layout, and only as many as the layout has", () => {
    const html = grid({ kit: setLayout(defaultKit(), "full") });
    expect((html.match(/data-pad=/g) ?? []).length).toBe(40);
    expect(html).toContain(">;<");
    expect(html).toContain(">/<");
  });

  it("says a slice is still decoding rather than pretending it will sound", () => {
    expect(grid()).toContain("decoding");
  });

  it("shows the interval on every key in note mode, and names the root", () => {
    const html = grid({ kit: setPlay(defaultKit(), "note"), rootNote: "F" });
    expect(html).toContain("root");
    expect(html).toContain("+1");
    expect(html).toContain("-7");
    // With the file's measured key known, the caps name the notes.
    expect(html).toContain("F#");
  });

  it("marks a held key so a gate player can see what is sounding", () => {
    const html = grid({ kit: setTrigger(defaultKit(), "gate"), held: new Set([3]), lit: new Set([3]) });
    expect(html).toContain('data-held="true"');
    expect(html).toContain('data-lit="true"');
    expect(html).toContain('aria-pressed="true"');
  });
});

group("the kit controls", () => {
  const kitState = {
    kit: defaultKit(),
    setTrigger: () => undefined,
    setPlay: () => undefined,
    setLayout: () => undefined,
    setRootPad: () => undefined,
    setRootKey: () => true,
    setNotePad: () => undefined,
    setOrder: () => undefined,
    swap: () => undefined,
    reset: () => undefined,
  } satisfies KitState;

  function controls(kit = defaultKit(), held = new Set<number>(), hitCeiling = false) {
    return renderToStaticMarkup(
      <KitControls
        kit={kit}
        kitState={{ ...kitState, kit }}
        latency={{ count: 12, medianMs: 11.2, p95Ms: 16.4, worstMs: 22 }}
        held={held}
        hitCeiling={hitCeiling}
        onAllOff={() => undefined}
      />,
    );
  }

  it("says the hardware ceiling where it matters, rather than letting a chord be swallowed", () => {
    const html = controls();
    expect(html).toContain("about three keys at once");
    expect(html).toContain("chords need a MIDI controller");
  });

  it("says how long the keyboard is actually taking, measured, against the 20 ms line", () => {
    expect(controls()).toContain("16 ms at the 95th over 12 hits");
    expect(controls()).toContain("inside the 20 ms that feels played");
  });

  it("names the shortcuts a bigger layout takes over", () => {
    const html = controls(setLayout(defaultKit(), "32"));
    expect(html).toContain("so while it is on screen those keys are pads");
    expect(html).toContain("Ctrl and Cmd shortcuts are never touched");
    expect(controls()).not.toContain("so while it is on screen those keys are pads");
  });

  it("describes the mode that is on, in the words the producer chose it by", () => {
    expect(controls(setTrigger(defaultKit(), "gate"))).toContain("Sounds while the key is down");
    expect(controls(setPlay(defaultKit(), "note"))).toContain("transposed");
  });
});
