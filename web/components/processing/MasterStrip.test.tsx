// The master bus. The assertions are the line: a level, a gentle limiter, no
// makeup gain, no loudness readout, and a reduction number that comes off the
// node rather than being estimated.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import { defaultMaster, setLimiter, setMasterBypass } from "@/lib/processing/chain";
import type { MasterProcessing } from "@/lib/processing/types";
import { MasterStrip } from "./MasterStrip";

function render(master: MasterProcessing, extra: Partial<Parameters<typeof MasterStrip>[0]> = {}) {
  return renderToStaticMarkup(
    <MasterStrip master={master} levelDb={0} reductionDb={0} onLevel={() => undefined} onLimiter={() => undefined} onBypass={() => undefined} {...extra} />,
  );
}

group("the bus", () => {
  it("has a level for the whole session", () => {
    const html = render(defaultMaster(), { levelDb: -3 });
    expect(html).toContain('aria-label="Master level in decibels"');
    expect(html).toContain("-3 dB");
  });

  it("has a limiter that is off until it is asked for", () => {
    const html = render(defaultMaster());
    expect(html).toContain(">Limiter<");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">off<");
  });

  it("says exactly what the limiter is set to, with no loudness claim", () => {
    const html = render(setLimiter(defaultMaster(), { enabled: true, ceilingDb: -2, releaseMs: 200 }));
    expect(html).toContain("holding peaks at -2 dB, 8:1, 200 ms release");
    expect(html).not.toMatch(/lufs/i);
  });

  it("says in the interface that it can only make things quieter", () => {
    expect(render(defaultMaster())).toContain("No makeup gain");
  });

  it("shows what it is holding back, measured off the node", () => {
    const limiting = setLimiter(defaultMaster(), { enabled: true, ceilingDb: -1, releaseMs: 120 });
    expect(render(limiting, { reductionDb: -2.4 })).toContain("holding 2.4 dB");
    expect(render(limiting, { reductionDb: 0 })).not.toContain("holding 0");
  });

  it("can be taken out of circuit without losing its settings", () => {
    const html = render(setMasterBypass(setLimiter(defaultMaster(), { enabled: true, ceilingDb: -3 }), true));
    expect(html).toContain(">Bypassed<");
    expect(html).toContain('value="-3"');
  });

  it("does not offer a ceiling to set when there is no limiter to set it on", () => {
    expect(render(defaultMaster())).toContain('disabled="" aria-label="Limiter ceiling in decibels"');
    expect(render(setLimiter(defaultMaster(), { enabled: true }))).not.toContain('disabled="" aria-label="Limiter ceiling in decibels"');
  });
});
