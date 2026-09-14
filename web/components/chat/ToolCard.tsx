"use client";

// Tool-call cards. Rows with a left rule, never boxes; numbers in mono; the
// one amber is the running progress line and the Run button on a
// confirmation. Cards are pure: what they need from the app (live jobs,
// navigation) comes in through `actions`, so they render in tests too.

import { btn, btnPrimary, btnQuiet, cx } from "@/components/ui";
import type { Card, LoopSummary } from "@/lib/chat/cards";
import { fmtBpm, fmtClock, fmtNumber, fmtPercent } from "@/lib/format";
import type { JobRow } from "@/lib/types/db";

export type ConfirmCard = Extract<Card, { type: "confirm" }>;

export interface CardActions {
  /** the live job rows, for status and progress */
  jobs: JobRow[];
  openFile: (fileId: string) => void;
  showLoop: (loop: LoopSummary) => void;
  openTab: (fileId: string, tab: "breakdown" | "compare" | "loops" | "stems" | "chops" | "layers" | "revoice") => void;
  confirmBatch: ((card: ConfirmCard) => void) | null;
}

const row = "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-0.5";
const dim = "text-chalk-dim";

function jobStatusText(job: JobRow | undefined, fallback: string, dispatch: string | null): string {
  if (!job) return dispatch ? `${fallback} (${dispatch})` : fallback;
  if (job.status === "queued") {
    const note = job.error?.startsWith("dispatch:") ? job.error.slice("dispatch:".length).trim() : null;
    return note ? `queued (${note})` : "queued";
  }
  if (job.status === "running") return job.progress !== null ? `running ${fmtPercent(job.progress)}` : "running";
  if (job.status === "failed") return `failed: ${job.error ?? "unknown error"}`;
  return "done";
}

function JobLine({ jobId, kind, label, status, dispatch, fileId, actions }: { jobId: string; kind: string; label: string; status: string; dispatch: string | null; fileId: string | null; actions: CardActions }) {
  const live = actions.jobs.find((j) => j.id === jobId);
  const running = live?.status === "running";
  const done = live?.status === "done";
  return (
    <div className="relative">
      <div className={row}>
        <span className="truncate">
          <span className="font-mono">{kind}</span>
          <span className={cx("ml-2", dim)}>{label}</span>
        </span>
        <span className="font-mono text-right">{jobStatusText(live, status, dispatch)}</span>
      </div>
      {running && (
        <div className="h-px bg-rule" aria-hidden>
          <div className="h-px bg-pad transition-[width] duration-300" style={{ width: `${Math.round(Math.max(0.03, live?.progress ?? 0.03) * 100)}%` }} />
        </div>
      )}
      {fileId && (done || !live) && (
        <div className="flex justify-end">
          <button type="button" className={btnQuiet} onClick={() => actions.openFile(fileId)}>
            Open file
          </button>
        </div>
      )}
    </div>
  );
}

function LoopRowView({ loop, actions }: { loop: LoopSummary; actions: CardActions }) {
  return (
    <div className={row}>
      <span className="truncate">
        {loop.name ?? (loop.origin === "finder" ? "found" : loop.origin === "chat" ? "chat" : "user")}
        {loop.bars !== null && <span className={cx("ml-2 font-mono", dim)}>{loop.bars} bar{loop.bars === 1 ? "" : "s"}</span>}
        {loop.score !== null && <span className={cx("ml-2 font-mono", dim)}>{fmtNumber(loop.score, 2)}</span>}
      </span>
      <span className="flex items-baseline gap-2">
        <span className="font-mono">
          {fmtClock(loop.start_s)}–{fmtClock(loop.end_s)}
        </span>
        <button type="button" className={btnQuiet} onClick={() => actions.showLoop(loop)}>
          Show on surface
        </button>
      </span>
    </div>
  );
}

function matchedText(m: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof m.bpm === "number") parts.push(`${fmtBpm(m.bpm)} BPM`);
  if (typeof m.key === "string") parts.push(m.key);
  if (typeof m.kind === "string") parts.push(m.kind);
  if (Array.isArray(m.tags) && m.tags.length > 0) parts.push(m.tags.join(", "));
  if (m.has_drums === false) parts.push("no drums");
  if (m.has_drums === true) parts.push("drums");
  if (m.is_loop_based === true) parts.push("loop-based");
  if (typeof m.name === "string") parts.push("name");
  return parts.join(" · ");
}

export function ToolCardView({ card, actions }: { card: Card; actions: CardActions }) {
  switch (card.type) {
    case "job":
      return <JobLine jobId={card.job_id} kind={card.kind} label={card.label} status={card.status} dispatch={card.dispatch} fileId={card.file_id} actions={actions} />;

    case "loop":
      return (
        <div>
          <div className={cx("text-2xs", dim)}>{card.file_name}</div>
          <LoopRowView loop={card.loop} actions={actions} />
        </div>
      );

    case "loops":
      return (
        <div>
          <div className={cx("text-2xs", dim)}>
            {card.loops.length} loop{card.loops.length === 1 ? "" : "s"} on {card.file_name}
          </div>
          {card.loops.map((l) => (
            <LoopRowView key={l.id} loop={l} actions={actions} />
          ))}
        </div>
      );

    case "layer":
      return (
        <div>
          <div className={row}>
            <span className="truncate">{card.name ?? "layer"}</span>
            <span className="font-mono">
              {card.tempo_bpm !== null ? `${fmtBpm(card.tempo_bpm)} BPM` : ""}
              {card.key ? ` ${card.key}` : ""}
            </span>
          </div>
          {card.items.map((it) => (
            <div key={it.file_id} className={cx(row, dim)}>
              <button type="button" className="truncate text-left hover:text-chalk" onClick={() => actions.openFile(it.file_id)}>
                {it.name}
              </button>
              <span className="font-mono">
                {it.gain_db >= 0 ? "+" : ""}
                {fmtNumber(it.gain_db, 1)} dB · {fmtNumber(it.offset_s, 3)} s
              </span>
            </div>
          ))}
          {card.job_id && <JobLine jobId={card.job_id} kind="layer" label="render" status="queued" dispatch={null} fileId={null} actions={actions} />}
        </div>
      );

    case "breakdown":
      return (
        <div>
          <div className={row}>
            <span className="truncate">
              breakdown of {card.file_name}
              {card.version !== null && <span className={cx("ml-2 font-mono", dim)}>v{card.version}</span>}
            </span>
            <span className="font-mono">{card.status}</span>
          </div>
          {card.requires.length > 0 && <div className={cx("text-2xs", dim)}>still needs {card.requires.join(", ")}</div>}
          {card.job_id && <JobLine jobId={card.job_id} kind="breakdown" label="compose" status="queued" dispatch={null} fileId={null} actions={actions} />}
          <div className="flex justify-end">
            <button type="button" className={btnQuiet} onClick={() => actions.openTab(card.file_id, "breakdown")}>
              Open breakdown
            </button>
          </div>
        </div>
      );

    case "compare":
      return (
        <div>
          <div className={row}>
            <span className="truncate">
              {card.a_name} vs {card.b_name}
            </span>
            <span className="font-mono">{card.status}</span>
          </div>
          {card.deltas.slice(0, 12).map((d, i) => (
            <div key={i} className={cx(row, dim)}>
              <span className="truncate">{d.text}</span>
              <span className="font-mono">{d.metric}</span>
            </div>
          ))}
          {card.job_id && <JobLine jobId={card.job_id} kind="compare" label="compare" status="queued" dispatch={null} fileId={null} actions={actions} />}
          <div className="flex justify-end">
            <button type="button" className={btnQuiet} onClick={() => actions.openTab(card.file_a_id, "compare")}>
              Open compare
            </button>
          </div>
        </div>
      );

    case "search":
      return (
        <div>
          <div className={cx("text-2xs", dim)}>
            {card.results.length} result{card.results.length === 1 ? "" : "s"} · {card.mode}
            {card.note && <span className="ml-2">{card.note}</span>}
          </div>
          {card.results.slice(0, 12).map((r) => (
            <div key={r.file_id} className={row}>
              <span className="truncate">
                {r.name}
                <span className={cx("ml-2 font-mono", dim)}>{matchedText(r.matched as unknown as Record<string, unknown>)}</span>
              </span>
              <span className="flex items-baseline gap-2">
                {typeof r.similarity === "number" && <span className={cx("font-mono", dim)}>{fmtNumber(r.similarity, 2)}</span>}
                <button type="button" className={btnQuiet} onClick={() => actions.openFile(r.file_id)}>
                  Open
                </button>
              </span>
            </div>
          ))}
        </div>
      );

    case "web":
      return (
        <div>
          {card.query && <div className={cx("text-2xs truncate", dim)}>{card.query}</div>}
          {card.items.length === 0 && <div className={dim}>nothing found</div>}
          {card.items.slice(0, 10).map((it, i) => (
            <div key={`${it.url}-${i}`} className="py-0.5 min-w-0">
              <a href={it.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 hover:text-pad truncate block">
                {it.kind && <span className={cx("mr-2 font-mono no-underline", dim)}>{it.kind}</span>}
                {it.title}
              </a>
              {it.snippet && <div className={cx("truncate", dim)}>{it.snippet}</div>}
            </div>
          ))}
        </div>
      );

    case "edit":
      return (
        <div className={row}>
          <span className="truncate">
            <span className="font-mono">{card.field}</span>
            <span className={cx("ml-2", dim)}>{card.file_name}</span>
          </span>
          <span className="font-mono">
            <span className={dim}>{JSON.stringify(card.predicted)}</span> → {JSON.stringify(card.corrected)}
          </span>
        </div>
      );

    case "report": {
      const v = card.vitals;
      return (
        <div>
          <div className={row}>
            <button type="button" className="truncate text-left hover:text-pad" onClick={() => actions.openFile(card.file_id)}>
              {card.file_name}
            </button>
            <span className="font-mono">
              {v.bpm !== null ? `${v.bpm_hedge ? `${v.bpm_hedge} ` : ""}${fmtBpm(v.bpm)} BPM` : "no tempo"}
              {" · "}
              {v.key ? `${v.key_hedge ? `${v.key_hedge} ` : ""}${v.key}` : "no key"}
              {v.meter ? ` · ${v.meter}` : ""}
              {v.feel ? ` · ${v.feel}` : ""}
            </span>
          </div>
          {card.not_analyzed.length > 0 && <div className={cx("text-2xs", dim)}>not analyzed yet: {card.not_analyzed.join(", ")}</div>}
        </div>
      );
    }

    case "confirm":
      return (
        <div>
          <div>{card.message}</div>
          <div className={cx("text-2xs", dim)}>{card.estimate}</div>
          <ul className="mt-1">
            {card.operations.slice(0, 20).map((op, i) => (
              <li key={i} className={cx(row, dim)}>
                <span className="font-mono truncate">
                  {op.tool} {op.input_json}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex justify-end gap-2">
            <button type="button" className={actions.confirmBatch ? btnPrimary : btn} disabled={!actions.confirmBatch} onClick={() => actions.confirmBatch?.(card)}>
              Run {card.gpu_count} GPU job{card.gpu_count === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      );

    // A receipt, never a trigger. The steps were put on the bus once, live, by
    // components/chat/directive.ts; rendering this again — reopening the
    // conversation, say — must not replay them.
    case "directive":
      return (
        <div className="flex flex-col gap-0.5">
          {card.steps.map((step, i) => (
            <div key={`s${i}`} className={row}>
              <span className="truncate" title={step.said}>
                {step.line}
              </span>
              <span className={cx("font-mono text-2xs", dim)}>{step.bus === "keyboard" ? "keys" : "session"}</span>
            </div>
          ))}
          {card.refused.map((refusal, i) => (
            <div key={`r${i}`} className={cx(row, dim)}>
              <span className="truncate" title={refusal.said}>
                {refusal.note}
              </span>
              <span className="font-mono text-2xs">not done</span>
            </div>
          ))}
        </div>
      );

    case "session":
      return (
        <div>
          <div className={row}>
            <span className="truncate">
              {card.lanes} {card.lanes === 1 ? "lane" : "lanes"}, {card.regions} {card.regions === 1 ? "region" : "regions"}
            </span>
            <span className="font-mono text-right">{card.bpm === null ? "no tempo" : `${fmtBpm(card.bpm)} BPM`}</span>
          </div>
          <ul className={cx("mt-1 text-2xs", dim)}>
            {card.lines.slice(0, 14).map((line, i) => (
              <li key={i} className="truncate whitespace-pre">
                {line}
              </li>
            ))}
          </ul>
        </div>
      );

    case "batch":
      return (
        <div className="flex flex-col gap-1">
          {card.items.map((it, i) => (
            <div key={i} className="border-l-2 border-rule pl-2">
              <div className={row}>
                <span className="truncate">
                  <span className="font-mono">{it.tool}</span>
                  <span className={cx("ml-2", dim)}>{it.summary}</span>
                </span>
                {it.is_error && <span className="font-mono">failed</span>}
              </div>
              {it.card && it.card.type !== "batch" && <ToolCardView card={it.card} actions={actions} />}
            </div>
          ))}
        </div>
      );
  }
}
