// One band's row. This is the keyboard path to every processor — the curve is
// the fast way and this is the exact one — so what matters is that the numbers
// are real inputs with real bounds and that each one says what it does.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import { bandOf, defaultProcessing, setBand } from "@/lib/processing/chain";
import type { EqBand } from "@/lib/processing/types";
import { BandRow } from "./BandRow";

function render(band: EqBand, extra: Partial<Parameters<typeof BandRow>[0]> = {}) {
  return renderToStaticMarkup(
    <BandRow band={band} selected={false} why={null} onSelect={() => undefined} onChange={() => undefined} onToggle={() => undefined} {...extra} />,
  );
}

const flat = defaultProcessing();

group("a peaking band", () => {
  const band = bandOf(setBand(flat, "lo", { frequency: 250, gainDb: -4, q: 1.2, enabled: true }), "lo");

  it("has a frequency, a gain and a Q, all editable", () => {
    const html = render(band);
    expect(html).toContain('value="250"');
    expect(html).toContain('value="-4"');
    expect(html).toContain('value="1.2"');
  });

  it("bounds the gain at the corrective limits rather than at anything", () => {
    const html = render(band);
    expect(html).toContain('min="-24"');
    expect(html).toContain('max="12"');
  });
});

group("a pass filter", () => {
  it("has no gain, and its frequency stops where a correction stops", () => {
    const html = render(bandOf(setBand(flat, "hp", { frequency: 80, enabled: true }), "hp"));
    expect(html).toContain('max="400"');
    expect(html).not.toContain("gain in decibels");
    expect(html).toContain("an effect, not a correction");
  });

  it("says the same from the other end for a low-pass", () => {
    expect(render(bandOf(setBand(flat, "lp", { frequency: 9000, enabled: true }), "lp"))).toContain('min="800"');
  });
});

group("switching a band on and off", () => {
  it("is a real toggle, and says that off costs the signal nothing", () => {
    const off = render(bandOf(flat, "mid"));
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain("Switch this band on");
    const on = render(bandOf(setBand(flat, "mid", { enabled: true }), "mid"));
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("exactly unity");
  });
});

group("a band a proposal moved", () => {
  it("carries the reason it gave, in its own words", () => {
    const html = render(bandOf(setBand(flat, "lo", { gainDb: -4, enabled: true }), "lo"), { why: "200-300 Hz is where two parts stop being two parts" });
    expect(html).toContain("200-300 Hz is where two parts stop being two parts");
  });
});
