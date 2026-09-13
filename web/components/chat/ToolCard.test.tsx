import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/chat/cards";
import type { JobRow } from "@/lib/types/db";
import { ToolCardView, type CardActions } from "./ToolCard";

const noop = () => undefined;
const actions = (jobs: JobRow[] = [], confirm = true): CardActions => ({
  jobs,
  openFile: noop,
  showLoop: noop,
  openTab: noop,
  confirmBatch: confirm ? noop : null,
});

const job: JobRow = {
  id: "job-1",
  user_id: "u",
  file_id: "file-1",
  kind: "stems",
  status: "running",
  params: {},
  result: null,
  error: null,
  modal_call_id: null,
  progress: 0.4,
  created_at: "2026-09-13T00:00:00Z",
  started_at: null,
  finished_at: null,
};

describe("tool cards", () => {
  it("job: shows kind, status and progress live from the jobs list", () => {
    const card: Card = { type: "job", job_id: "job-1", kind: "stems", file_id: "file-1", status: "queued", label: "stems (htdemucs_ft)", dispatch: null };
    const html = renderToStaticMarkup(<ToolCardView card={card} actions={actions([job])} />);
    expect(html).toContain("stems");
    expect(html).toContain("running 40%");
    expect(html).toContain("width:40%");
    const stale = renderToStaticMarkup(<ToolCardView card={{ ...card, dispatch: "compute not configured" }} actions={actions([])} />);
    expect(stale).toContain("queued (compute not configured)");
  });

  it("loops: lists loops with a show-on-surface action", () => {
    const card: Card = {
      type: "loops",
      file_id: "file-1",
      file_name: "song.wav",
      job_id: null,
      loops: [{ id: "l1", file_id: "file-1", start_s: 4, end_s: 14.435, bars: 4, name: null, score: 0.82, origin: "finder", render_file_id: null }],
    };
    const html = renderToStaticMarkup(<ToolCardView card={card} actions={actions()} />);
    expect(html).toContain("Show on surface");
    expect(html).toContain("0:04.000–0:14.435");
    expect(html).toContain("0.82");
  });

  it("web: every item is a link with its citation", () => {
    const card: Card = {
      type: "web",
      kind: "context",
      query: "who produced x",
      items: [{ title: "Credits", url: "https://credits.example/x", snippet: "Produced by Someone.", kind: "producer" }],
      citations: [{ url: "https://credits.example/x", title: "Credits" }],
    };
    const html = renderToStaticMarkup(<ToolCardView card={card} actions={actions()} />);
    expect(html).toContain('href="https://credits.example/x"');
    expect(html).toContain("Produced by Someone.");
    expect(html).toContain("producer");
  });

  it("edit: shows field, predicted and corrected", () => {
    const html = renderToStaticMarkup(<ToolCardView card={{ type: "edit", file_id: "f", file_name: "song.wav", field: "tempo_bpm", predicted: 92, corrected: 90 }} actions={actions()} />);
    expect(html).toContain("tempo_bpm");
    expect(html).toContain("92");
    expect(html).toContain("90");
  });

  it("confirm: has a Run button that is disabled while a turn is in flight", () => {
    const card: Card = {
      type: "confirm",
      batch_id: "abc",
      operations: [{ tool: "separate_stems", input_json: '{"file_id":"x"}' }],
      gpu_count: 6,
      estimate: "6 GPU jobs",
      message: "Confirm before I run it.",
    };
    const html = renderToStaticMarkup(<ToolCardView card={card} actions={actions()} />);
    expect(html).toContain("Run 6 GPU jobs");
    expect(html).not.toContain('disabled=""');
    const busy = renderToStaticMarkup(<ToolCardView card={card} actions={actions([], false)} />);
    expect(busy).toContain('disabled=""');
  });

  it("batch: renders nested cards", () => {
    const card: Card = {
      type: "batch",
      items: [
        { tool: "separate_stems", summary: "queued stems", is_error: false, card: { type: "job", job_id: "j", kind: "stems", file_id: "f", status: "queued", label: "stems", dispatch: null } },
        { tool: "get_report", summary: "bad id", is_error: true, card: null },
      ],
    };
    const html = renderToStaticMarkup(<ToolCardView card={card} actions={actions()} />);
    expect(html).toContain("queued stems");
    expect(html).toContain("failed");
  });

  it("report and search: vitals with hedges, matched fields with Open", () => {
    const report: Card = {
      type: "report",
      file_id: "f",
      file_name: "song.wav",
      vitals: { bpm: 92, bpm_confidence: 0.91, bpm_hedge: "", key: "F minor", key_confidence: 0.7, key_hedge: "likely", meter: "4/4", feel: "swung 58%", swing_pct: 58, duration_s: 100, status: "ready" },
      not_analyzed: ["chords"],
    };
    const html = renderToStaticMarkup(<ToolCardView card={report} actions={actions()} />);
    expect(html).toContain("92.0 BPM");
    expect(html).toContain("likely F minor");
    expect(html).toContain("not analyzed yet: chords");
    const search: Card = { type: "search", query: "q", mode: "vector", note: null, results: [{ file_id: "f", name: "song.wav", kind: "original", matched: { bpm: 92, key: "F minor", tags: ["dusty"] }, similarity: 0.87 }] };
    const shtml = renderToStaticMarkup(<ToolCardView card={search} actions={actions()} />);
    expect(shtml).toContain("92.0 BPM · F minor · dusty");
    expect(shtml).toContain("0.87");
    expect(shtml).toContain("Open");
  });
});
