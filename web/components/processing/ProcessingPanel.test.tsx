// The dock's surface. Three things have to be true on screen, and they are the
// three the direction document asks for: the chain is visible, it is editable
// by hand, and what the AI did to it is shown rather than hidden.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import { defaultProcessing, setBand, setBypass, setTrim, setTune } from "@/lib/processing/chain";
import type { TrackProcessing } from "@/lib/processing/types";
import { ProcessingPanel, type ProposalNote } from "./ProcessingPanel";

const LANES = [
  { id: "t1", name: "Moonlight Highlife horns" },
  { id: "t2", name: "In The Shade break" },
];

function render(processing: TrackProcessing, extra: Partial<Parameters<typeof ProcessingPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <ProcessingPanel
      lanes={LANES}
      trackId="t1"
      processing={processing}
      sampleRate={48000}
      selected={null}
      proposal={null}
      busy={false}
      note={null}
      onPickLane={() => undefined}
      onSelect={() => undefined}
      onBand={() => undefined}
      onToggleBand={() => undefined}
      onTrim={() => undefined}
      onTune={() => undefined}
      onBypass={() => undefined}
      onReset={() => undefined}
      onRemove={() => undefined}
      onAsk={() => undefined}
      onUndoProposal={() => undefined}
      {...extra}
    />,
  );
}

group("with nothing in the session", () => {
  it("says what a lane is for rather than showing an empty EQ", () => {
    const html = render(defaultProcessing(), { lanes: [], trackId: null });
    expect(html).toContain("Nothing in the session to work on yet");
    expect(html).toContain("clean up the trumpet");
  });
});

group("every band is on screen with its numbers", () => {
  it("shows all seven slots, whether or not they are doing anything", () => {
    const html = render(defaultProcessing());
    for (const name of ["High-pass", "Low shelf", "Low mid", "Mid", "High mid", "High shelf", "Low-pass"]) expect(html, name).toContain(name);
  });

  it("gives every band an editable frequency, and a gain where there is one", () => {
    const html = render(defaultProcessing());
    expect(html).toContain('aria-label="Low mid frequency in hertz"');
    expect(html).toContain('aria-label="Low mid gain in decibels"');
    expect(html).toContain('aria-label="Low mid Q"');
    // a pass filter has no gain, so it does not pretend to have one
    expect(html).not.toContain('aria-label="High-pass gain in decibels"');
  });

  it("says a shelf's Q is not read, rather than offering one that does nothing", () => {
    const html = render(defaultProcessing());
    expect(html).not.toContain('aria-label="Low shelf Q"');
    expect(html).toContain("move the drawing and not the sound");
  });

  it("reflects a band that is on", () => {
    const html = render(setBand(defaultProcessing(), "lo", { frequency: 250, gainDb: -4, q: 1.2, enabled: true }));
    expect(html).toContain('value="250"');
    expect(html).toContain('value="-4"');
    expect(html).toContain('aria-label="Low mid on" title="Switched on');
  });
});

group("bypass and the A/B", () => {
  it("has a bypass that says which way it is, and a hold-to-compare beside it", () => {
    const off = render(defaultProcessing());
    expect(off).toContain(">Bypassed<");
    expect(off).toContain('aria-pressed="false"');
    const on = render(setBypass(defaultProcessing(), false));
    expect(on).toContain(">On<");
    expect(on).toContain("Hold to compare");
    expect(on).toContain("putting it back exactly as you found it");
  });

  it("says bypass is the dry signal, not a chain set flat", () => {
    expect(render(defaultProcessing())).toContain("never goes through a filter");
  });
});

group("trim and tune", () => {
  it("offers gain staging separately from the lane's fader, and says why", () => {
    const html = render(setTrim(defaultProcessing(), -3));
    expect(html).toContain('aria-label="Input trim in decibels"');
    expect(html).toContain("before the filters");
    expect(html).toContain("-3 dB");
  });

  it("says plainly that tuning moves time with pitch, and by how much", () => {
    const html = render(setTune(defaultProcessing(), 100));
    expect(html).toContain('aria-label="Tune in cents"');
    expect(html).toContain("pitch and time move together");
    expect(html).toContain("+1 semitone");
    expect(html).toContain("% time)");
  });
});

group("what the AI did", () => {
  const proposal: ProposalNote = {
    summary: "the build-up in the low mids",
    confidence: 0.62,
    lines: ["250 Hz down +4 dB, Q 1.2", "high-pass at 60 Hz"],
    notes: ["the record stops at 13.5 kHz, so a lift at 16 kHz would be lifting nothing that is there; moved to 13.5 kHz."],
    bands: ["lo", "hp"],
    why: { lo: "200-300 Hz is where two parts stacked on each other stop being two parts" },
  };

  it("shows the moves it made, with its confidence, and a way to take it back", () => {
    const html = render(setBand(defaultProcessing(), "lo", { gainDb: -4, enabled: true }), { proposal });
    expect(html).toContain("the build-up in the low mids");
    expect(html).toContain("250 Hz down +4 dB, Q 1.2");
    expect(html).toContain("Undo that");
  });

  it("keeps its reason on the band it moved, in its own words", () => {
    const html = render(setBand(defaultProcessing(), "lo", { gainDb: -4, enabled: true }), { proposal });
    expect(html).toContain("200-300 Hz is where two parts stacked");
  });

  it("shows what it refused to do rather than only what it did", () => {
    const html = render(defaultProcessing(), { proposal });
    expect(html).toContain("the record stops at 13.5 kHz");
  });
});

group("asking in words", () => {
  it("has the same ask the chat has, and offers the vocabulary that lands straight away", () => {
    const html = render(defaultProcessing());
    expect(html).toContain('aria-label="What is wrong with this track"');
    expect(html).toContain("muddy");
    expect(html).toContain("Fix it");
  });

  it("says it is working rather than looking stuck", () => {
    expect(render(defaultProcessing(), { busy: true })).toContain(">Working<");
  });
});

group("never destructive", () => {
  it("offers to take the chain off, and says the audio was never touched", () => {
    const html = render(defaultProcessing());
    expect(html).toContain("Take it off");
    expect(html).toContain("The audio was never touched");
  });
});

group("which lane", () => {
  it("picks the lane the chain belongs to, and says processing stays with the track", () => {
    const html = render(defaultProcessing());
    expect(html).toContain("Moonlight Highlife horns");
    expect(html).toContain("In The Shade break");
    expect(html).toContain("a property of the track");
  });
});
