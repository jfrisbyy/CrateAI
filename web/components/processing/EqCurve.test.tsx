// The curve has to be the response of the filters that are running, not a
// drawing of them. These assertions check the two things that make that true:
// the line is computed from the same arithmetic the audio uses, and a band's
// handle is where the curve says that band is.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import { defaultBands, setBand } from "@/lib/processing/chain";
import { dbToRatio, freqToRatio } from "@/lib/processing/eq";
import type { TrackProcessing } from "@/lib/processing/types";
import { EqCurve, SPAN_DB } from "./EqCurve";

const RATE = 48000;
const W = 1000;
const H = 300;

function chain(edit: (p: TrackProcessing) => TrackProcessing = (p) => p): TrackProcessing {
  return edit({ bypassed: false, trimDb: 0, tuneCents: 0, bands: defaultBands() });
}

function render(processing: TrackProcessing, extra: Partial<Parameters<typeof EqCurve>[0]> = {}) {
  return renderToStaticMarkup(
    <EqCurve bands={processing.bands} sampleRate={RATE} bypassed={processing.bypassed} selected={null} onSelect={() => undefined} onDrag={() => undefined} {...extra} />,
  );
}

/** Pull the curve's points back out of the path so they can be checked against the arithmetic. */
function curvePoints(html: string): Array<{ x: number; y: number }> {
  const path = /data-testid="eq-curve"[^>]*?d="([^"]+)"/.exec(html) ?? /d="([^"]+)"[^>]*?data-testid="eq-curve"/.exec(html);
  const d = path?.[1];
  if (!d) throw new Error("no curve was drawn");
  return d
    .split(/(?=[ML])/)
    .map((part) => part.slice(1).trim().split(/\s+/).map(Number))
    .filter((pair) => pair.length === 2 && pair.every((n) => Number.isFinite(n)))
    .map(([x, y]) => ({ x: x as number, y: y as number }));
}

group("the line", () => {
  it("is flat down the middle when nothing is switched on", () => {
    const points = curvePoints(render(chain()));
    expect(points.length).toBeGreaterThan(100);
    for (const point of points) expect(point.y).toBeCloseTo(H / 2, 6);
  });

  it("dips where the band dips, by the amount the band says", () => {
    const processing = chain((p) => setBand(p, "lo", { frequency: 250, gainDb: -6, q: 1.2, enabled: true }));
    const points = curvePoints(render(processing));
    const lowest = points.reduce((worst, point) => (point.y > worst.y ? point : worst), points[0]!);
    expect(lowest.x).toBeCloseTo(freqToRatio(250) * W, 0);
    expect(lowest.y).toBeCloseTo(dbToRatio(-6, SPAN_DB) * H, 0);
  });

  it("rolls off at the bottom when a high-pass is on", () => {
    const processing = chain((p) => setBand(p, "hp", { frequency: 100, enabled: true }));
    const points = curvePoints(render(processing));
    expect(points[0]!.y).toBeGreaterThan(H / 2 + 30);
    expect(points[points.length - 1]!.y).toBeCloseTo(H / 2, 0);
  });

  it("draws the same shape the audio makes, at the rate that is sounding", () => {
    const processing = chain((p) => setBand(p, "hs", { frequency: 12000, gainDb: 6, enabled: true }));
    const at48 = curvePoints(render(processing));
    const at441 = curvePoints(renderToStaticMarkup(<EqCurve bands={processing.bands} sampleRate={44100} bypassed={false} selected={null} onSelect={() => undefined} onDrag={() => undefined} />));
    expect(at48[at48.length - 1]!.y).not.toBeCloseTo(at441[at441.length - 1]!.y, 2);
  });
});

group("the handles", () => {
  it("puts one on every band that is doing something, and none on the rest", () => {
    const none = render(chain());
    expect(none.match(/<circle/g) ?? []).toHaveLength(0);
    const two = render(chain((p) => setBand(setBand(p, "lo", { gainDb: -4, enabled: true }), "hs", { gainDb: 3, enabled: true })));
    expect(two.match(/<circle/g) ?? []).toHaveLength(2);
  });

  it("puts the handle where the curve says the band is", () => {
    const html = render(chain((p) => setBand(p, "mid", { frequency: 900, gainDb: 5, q: 1, enabled: true })));
    const circle = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(html);
    expect(Number(circle?.[1])).toBeCloseTo(freqToRatio(900) * W, 3);
    expect(Number(circle?.[2])).toBeCloseTo(dbToRatio(5, SPAN_DB) * H, 3);
  });

  it("keeps a pass filter's handle on the zero line, because it has no gain", () => {
    const html = render(chain((p) => setBand(p, "hp", { frequency: 80, enabled: true })));
    const circle = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(html);
    expect(Number(circle?.[2])).toBeCloseTo(H / 2, 6);
  });

  it("says what each handle is and that the numbers below do the same thing", () => {
    const html = render(chain((p) => setBand(p, "lo", { frequency: 250, gainDb: -4, enabled: true })));
    expect(html).toContain("Low mid");
    expect(html).toContain("250 Hz");
    expect(html).toContain("the numbers below do the same thing");
  });

  it("marks the bands a proposal moved, so the producer can see what the AI touched", () => {
    const processing = chain((p) => setBand(p, "lo", { gainDb: -4, enabled: true }));
    const plain = render(processing);
    const marked = render(processing, { proposed: new Set(["lo" as const]) });
    expect(marked).not.toBe(plain);
    expect(marked).toContain("fill-[#f0a63a]");
  });
});

group("bypass", () => {
  it("says so on the drawing rather than hiding the curve", () => {
    const processing = chain((p) => ({ ...setBand(p, "lo", { gainDb: -4, enabled: true }), bypassed: true }));
    const html = render(processing);
    expect(html).toContain("bypassed");
    expect(html.match(/<circle/g) ?? []).toHaveLength(1);
  });
});

group("the axis", () => {
  it("labels the frequencies where the gridlines are, not spread evenly", () => {
    const html = render(chain());
    expect(html).toContain("1 kHz");
    const label = /left:([\d.]+)%"[^>]*>1 kHz</.exec(html);
    expect(Number(label?.[1])).toBeCloseTo(freqToRatio(1000) * 100, 1);
  });
});
