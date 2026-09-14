import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Finding } from "@/lib/onboarding/findings";
import type { CapLine } from "@/lib/onboarding/limits";
import { planShape } from "@/lib/onboarding/limits";
import { positionAt } from "@/lib/onboarding/stages";
import { CapShape } from "./CapShape";
import { FindingsTable } from "./FindingsTable";
import { NotAGenerator } from "./NotAGenerator";
import { StageLadder } from "./StageLadder";

const findings: Finding[] = [
  { id: "tempo", label: "Tempo", value: "92.0 BPM", confidence: 0.91, note: "46.0 half-time, 184.1 double-time" },
  { id: "key", label: "Key", value: "F minor", confidence: 0.64, note: "or Ab major, which correlated 0.88" },
  { id: "structure", label: "Sections", value: "7", confidence: null, note: "likely it repeats on 8 bars" },
];

describe("the findings table", () => {
  const html = renderToStaticMarkup(<FindingsTable findings={findings} />);

  it("shows the measurement and its confidence dot", () => {
    expect(html).toContain("92.0 BPM");
    expect(html).toContain('data-level="full"');
    expect(html).toContain('data-level="half"');
    expect(html).toContain("confidence 0.64 (likely)");
  });

  it("puts the hedge word in the label, so an unsure number reads unsure", () => {
    expect(html).toMatch(/Key<span[^>]*> likely<\/span>/);
    // a confident one is stated plainly, with no hedge
    expect(html).not.toMatch(/Tempo<span[^>]*> /);
  });

  it("shows no dot at all for a value that carries no confidence", () => {
    const only = renderToStaticMarkup(<FindingsTable findings={[findings[2] as Finding]} />);
    expect(only).toContain("likely it repeats on 8 bars");
    expect(only).not.toContain("data-level");
  });

  it("renders nothing when nothing was measured", () => {
    expect(renderToStaticMarkup(<FindingsTable findings={[]} />)).toBe("");
  });
});

describe("the stage ladder", () => {
  it("marks the step running now and leaves the rest as what they will produce", () => {
    const html = renderToStaticMarkup(
      <StageLadder position={positionAt(0.4)} progress={0.4} elapsedS={31} past={null} />,
    );
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Key");
    expect(html).toContain("the key it nearly chose instead");
    expect(html).toContain("width:40%");
    expect(html).toContain("31 s so far.");
  });

  it("has no estimate for the first analysis, and says so rather than guessing", () => {
    const html = renderToStaticMarkup(<StageLadder position={positionAt(0.1)} progress={0.1} elapsedS={4} past={null} />);
    expect(html).toContain("No estimate yet: this is the first one on this account");
  });

  it("quotes the account's own past runs once there are some", () => {
    const html = renderToStaticMarkup(
      <StageLadder position={positionAt(0.5)} progress={0.5} elapsedS={20} past={{ runs: 4, medianS: 48 }} />,
    );
    expect(html).toContain("about 48 s (4 of them)");
  });

  it("says plainly that there are no half-measured numbers to show yet", () => {
    const html = renderToStaticMarkup(<StageLadder position={positionAt(0.3)} progress={0.3} elapsedS={9} past={null} />);
    expect(html).toContain("written in one pass at the end");
  });

  // The compute side publishes the report stage by stage now (report.pending,
  // analysis/lockedgroove/jobs/analyze.py), so the ladder has a second, equally
  // true sentence for that case and must not use the wrong one.
  it("says the numbers above it are final once the report arrives stage by stage", () => {
    const html = renderToStaticMarkup(<StageLadder position={positionAt(0.3)} progress={0.3} elapsedS={9} past={null} partial />);
    expect(html).toContain("written down the moment it is made");
    expect(html).not.toContain("written in one pass at the end");
  });

  it("shows a queued job as waiting rather than as zero progress", () => {
    const html = renderToStaticMarkup(<StageLadder position={positionAt(null)} progress={null} elapsedS={null} past={null} />);
    expect(html).toContain("Waiting for a machine to pick it up.");
    expect(html).not.toContain('aria-current="step"');
  });
});

describe("the caps", () => {
  it("lists them with nothing spent, and no percentages to imply otherwise", () => {
    const html = renderToStaticMarkup(<CapShape lines={planShape("free")} note="Uploading spends none of this." />);
    expect(html).toContain("2.00 GB");
    expect(html).toContain("8 a day, 40 a month");
    expect(html).toContain("Uploading spends none of this.");
    expect(html).not.toContain("%");
  });

  it("shows what is left once something is spent", () => {
    const lines: CapLine[] = [{ id: "chat", label: "Chat turns", value: "8 a day, 40 a month", fraction: 0.875, detail: "1 left" }];
    const html = renderToStaticMarkup(<CapShape lines={lines} />);
    expect(html).toContain("1 left");
    expect(html).toContain("88%");
  });
});

describe("what it will not do", () => {
  it("says it needs their audio, and why that is the reason to trust the numbers", () => {
    const long = renderToStaticMarkup(<NotAGenerator />);
    expect(long).toContain("There is no generator in here");
    expect(long).toContain("measured off your audio");
    const short = renderToStaticMarkup(<NotAGenerator short />);
    expect(short).toContain("It works on records you bring.");
    expect(short.length).toBeLessThan(long.length);
  });
});
