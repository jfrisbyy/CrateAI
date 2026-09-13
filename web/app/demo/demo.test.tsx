// The prototype, as far as it can be asserted without a browser.
//
// There is no DOM here, so what is checked is what a server render can prove:
// that the tree composes (the real SessionProvider, the real LibraryProvider,
// the real transport strip, with no environment at all), that the crate says
// what was measured and says "no tempo" where nothing was, that the script's
// four steps are on screen in order, and that a typed sentence lands on the
// right half of the interface. Everything that needs a pointer or an ear is
// listed in docs/HANDOFF_prototype.md instead of being asserted here.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseSessionCommand } from "@/lib/session/commands";
import { buildDemoLibrary } from "@/lib/demo/material";
import { DEMO_SAMPLE_RATE } from "@/lib/demo/audio";
import { DemoChat } from "./DemoChat";
import { DemoCrate } from "./DemoCrate";
import { DemoShell } from "./DemoShell";
import { COMMAND_EXAMPLES, DEMO_STEPS, matchStep, stepById } from "./script";

const library = buildDemoLibrary(DEMO_SAMPLE_RATE);

describe("the page", () => {
  const html = renderToStaticMarkup(<DemoShell library={library} />);

  it("renders the whole workspace with no environment and no session", () => {
    expect(html).toContain("Cratebox");
    expect(html).toContain("prototype");
    // the transport strip is outside the panes and always there
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain("No lanes yet");
  });

  it("opens as a chat, with nothing on the panel and the panel button disabled", () => {
    expect(html).toContain('aria-label="Chat"');
    expect(html).not.toContain('aria-label="Surface"');
    expect(html).toContain("Nothing on the panel yet");
  });

  it("says on the page that the audio is synthesised", () => {
    expect(html).toContain("synthesised");
  });

  it("puts the crate beside the chat", () => {
    expect(html).toContain('aria-label="Crate"');
    expect(html).toContain("Moonlight Highlife");
  });
});

describe("the crate", () => {
  const html = renderToStaticMarkup(<DemoCrate files={library.files} />);

  it("lists every record with what was measured on it", () => {
    expect(html).toContain("Moonlight Highlife");
    expect(html).toContain("92.0 BPM");
    expect(html).toContain("F minor");
    expect(html).toContain("174.0 BPM");
  });

  it("says 'no tempo' rather than guessing one", () => {
    expect(html).toContain("no tempo");
    expect(html).toContain("no key");
  });

  it("carries the two rack buttons the app's panel header carries", () => {
    expect(html).toContain("What fits this");
    expect(html).toContain("Loops here");
  });
});

describe("the chat", () => {
  const html = renderToStaticMarkup(<DemoChat done={new Set()} onStep={() => undefined} />);

  it("opens with what is real and what is not", () => {
    expect(html).toContain("The audio is synthesised in your browser");
    expect(html).toContain("not a separation result");
  });

  it("offers the four steps in order", () => {
    const positions = DEMO_STEPS.map((step) => html.indexOf(step.said.slice(0, 24)));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("shows the sentences that really are wired up", () => {
    for (const example of COMMAND_EXAMPLES) expect(html).toContain(example);
  });

  it("has the real composer under it", () => {
    expect(html).toContain("Enter sends, Shift+Enter for a new line");
  });
});

describe("which half of the interface a sentence lands on", () => {
  it("sends every wired-up example to the command line, not to the script", () => {
    for (const example of COMMAND_EXAMPLES) {
      expect(parseSessionCommand(example), example).not.toBeNull();
    }
  });

  it("sends the four written turns to the script, not to the command line", () => {
    for (const step of DEMO_STEPS) {
      expect(parseSessionCommand(step.said), step.said).toBeNull();
      expect(matchStep(step.said)?.id, step.said).toBe(step.id);
    }
  });

  it("reads the asks a producer would actually type", () => {
    expect(matchStep("find me drums that fit this")?.id).toBe("fits");
    expect(matchStep("what breaks have I got")?.id).toBe("fits");
    expect(matchStep("show me the song")?.id).toBe("song");
    expect(matchStep("what loops are in masquerade")?.id).toBe("loops");
    expect(matchStep("put moonlight highlife in the song")?.id).toBe("bed");
  });

  it("answers nothing it was not asked", () => {
    expect(matchStep("who produced this record")).toBeNull();
    expect(matchStep("")).toBeNull();
    expect(stepById("nope")).toBeNull();
  });

  it("never lets a command be swallowed by the script", () => {
    // "solo the drums" mentions drums; the command line must win.
    expect(parseSessionCommand("solo the drums")).not.toBeNull();
    expect(matchStep("solo the drums")?.id).toBe("fits");
  });
});
