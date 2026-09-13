import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sampleContent } from "@/lib/narration/fixtures";
import type { JobRow } from "@/lib/types/db";
import { BreakdownDocument } from "./BreakdownDocument";

const noop = () => {};

function job(over: Partial<JobRow>): JobRow {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    user_id: "u",
    file_id: "00000000-0000-4000-8000-000000000001",
    kind: "analyze",
    status: "running",
    params: { stages: ["chords"], force: true },
    result: null,
    error: null,
    modal_call_id: null,
    progress: 0.4,
    created_at: "2026-09-13T08:00:00Z",
    started_at: "2026-09-13T08:00:01Z",
    finished_at: null,
    ...over,
  };
}

describe("BreakdownDocument", () => {
  it("renders the sections in producer order, one line per fact, with the confidence dot", () => {
    const html = renderToStaticMarkup(<BreakdownDocument content={sampleContent()} onSeek={noop} />);
    const titles = ["The vitals", "The structure", "The sample", "The drums", "The bass", "The harmony", "The melodic layer", "The arrangement", "The mix", "The context", "The recipe"];
    const positions = titles.map((t) => html.indexOf(`aria-label="${t}"`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain("Likely it sits at 92 BPM");
    expect(html).toContain('data-level="half"'); // 0.72
    expect(html).toContain('data-level="low"'); // 0.55, 0.4
    expect(html).toContain('data-level="full"'); // 0.86
    expect(html).toContain("1. Find a 4-bar loop around 92 in F minor.");
  });

  it("links every fact with a time to the waveform and shows the span in the mono face", () => {
    const html = renderToStaticMarkup(<BreakdownDocument content={sampleContent()} onSeek={noop} />);
    expect(html).toContain('aria-label="Bars 9 to 24: verse, 16 bars. Seek to 0:20.870"');
    expect(html).toContain("0:20.870 – 1:02.600");
    expect(html).toContain("from structure.sections[1], confidence 0.70 (likely), click to seek to 0:20.870");
    // a fact without a time is not a button
    expect(html).not.toContain('aria-label="The key is F minor. Seek');
    expect(html).toContain("<span>The key is F minor.</span>");
  });

  it("renders a world fact's citation as a link that opens in a new tab", () => {
    const html = renderToStaticMarkup(<BreakdownDocument content={sampleContent({ identified: true })} onSeek={noop} />);
    expect(html).toContain('href="https://example.com/interview"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("[Interview with Test Producer]");
  });

  it("says not measured yet with the one action that measures it", () => {
    const content = sampleContent({ chords: false });
    const html = renderToStaticMarkup(<BreakdownDocument content={content} onSeek={noop} onQueue={noop} />);
    expect(html).toContain("not measured yet");
    expect(html).toContain("Chords weren&#x27;t measured yet.");
    expect(html).toContain(">Run chord analysis</button>");
    // identify_context is not a job: text only, no button
    expect(html).toContain("Identify the track and I can add what");
    expect(html).not.toContain("Identify the track</button>");
  });

  it("shows the live job instead of the button while it runs, and a retry when it failed", () => {
    const content = sampleContent({ chords: false });
    const running = renderToStaticMarkup(<BreakdownDocument content={content} onQueue={noop} jobFor={() => job({})} />);
    expect(running).toContain("run chord analysis running 40%");
    expect(running).not.toContain(">Run chord analysis</button>");
    const failed = renderToStaticMarkup(
      <BreakdownDocument content={content} onQueue={noop} onRetry={noop} jobFor={() => job({ status: "failed", error: "no stems", progress: null })} />,
    );
    expect(failed).toContain("failed: no stems");
    expect(failed).toContain(">Retry</button>");
  });

  it("disables the action when the job cannot be resolved", () => {
    const content = sampleContent({ chords: false });
    const html = renderToStaticMarkup(<BreakdownDocument content={content} onQueue={noop} canQueue={() => false} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Run chord analysis<\/button>/);
  });
});
