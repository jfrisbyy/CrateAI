// The breakdown as a document (BUILD_PACKET section 11): sections in the
// order a producer reads them, one line per fact with its confidence dot,
// the hedge already in the text, a link to the waveform for every fact that
// has a time, the citation for every world fact, and "not measured yet" with
// the one action that measures it. Pure: everything comes in as props.

import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btn, btnQuiet, cx } from "@/components/ui";
import { missingJobLabel } from "@/lib/api/breakdown";
import { fmtClock } from "@/lib/format";
import { hedgeWord } from "@/lib/report/hedge";
import type { BreakdownContent, BreakdownFact, BreakdownMissing, BreakdownSection, JobRow } from "@/lib/types/db";
import { isPending, jobStatusText } from "./jobStatus";

export interface FactRef {
  /** `${section.key}:${index}` */
  key: string;
  fact: BreakdownFact;
}

export interface BreakdownDocumentProps {
  content: BreakdownContent;
  /** a fact with a time was clicked: seek there (and select the span when it has an end) */
  onSeek?: (ref: FactRef) => void;
  selectedKey?: string | null;
  /** the latest job (any status) that measures what a missing entry names */
  jobFor?: (job: string | null) => JobRow | undefined;
  canQueue?: (job: string | null) => boolean;
  onQueue?: (job: string) => void;
  onRetry?: (job: JobRow) => void;
}

const ROW = "grid grid-cols-[12px_minmax(0,1fr)_auto] gap-x-2 items-baseline py-1 border-b border-rule/50 last:border-b-0 text-sm";

export function BreakdownDocument({ content, onSeek, selectedKey, jobFor, canQueue, onQueue, onRetry }: BreakdownDocumentProps) {
  return (
    <div className="max-w-[760px]">
      {content.sections.map((section) => (
        <SectionView
          key={section.key}
          section={section}
          onSeek={onSeek}
          selectedKey={selectedKey ?? null}
          jobFor={jobFor}
          canQueue={canQueue}
          onQueue={onQueue}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

function SectionView({
  section,
  onSeek,
  selectedKey,
  jobFor,
  canQueue,
  onQueue,
  onRetry,
}: { section: BreakdownSection; selectedKey: string | null } & Omit<BreakdownDocumentProps, "content" | "selectedKey">) {
  const empty = section.facts.length === 0 && section.missing.length === 0;
  return (
    <section className="border-t border-rule py-2.5" aria-label={section.title}>
      <h2 className="text-sm font-medium">{section.title}</h2>
      {empty ? (
        <p className="mt-1 text-xs text-chalk-dim">nothing measured here yet</p>
      ) : (
        <ul className="mt-1">
          {section.facts.map((fact, i) => {
            const key = `${section.key}:${i}`;
            return <FactLine key={key} fact={fact} refKey={key} numbered={section.key === "recipe" ? i + 1 : null} selected={selectedKey === key} onSeek={onSeek} />;
          })}
          {section.missing.map((m, i) => (
            <MissingLine key={`missing:${i}`} missing={m} job={jobFor?.(m.job)} canQueue={canQueue ? canQueue(m.job) : m.job !== null && m.job !== "identify_context"} onQueue={onQueue} onRetry={onRetry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function citationTitle(fact: BreakdownFact): string | null {
  const cite = fact.citation;
  if (!cite || typeof cite.url !== "string") return null;
  if (typeof cite.title === "string" && cite.title.trim()) return cite.title.trim();
  try {
    return new URL(cite.url).hostname;
  } catch {
    return cite.url;
  }
}

function factTitle(fact: BreakdownFact): string {
  const parts = [`from ${fact.source}`];
  if (fact.confidence !== null && fact.confidence !== undefined) {
    const word = hedgeWord(fact.confidence);
    parts.push(`confidence ${fact.confidence.toFixed(2)}${word ? ` (${word})` : ""}`);
  }
  if (fact.time_s !== null && fact.time_s !== undefined) parts.push(`click to seek to ${fmtClock(fact.time_s)}`);
  return parts.join(", ");
}

function FactLine({
  fact,
  refKey,
  numbered,
  selected,
  onSeek,
}: {
  fact: BreakdownFact;
  refKey: string;
  numbered: number | null;
  selected: boolean;
  onSeek: BreakdownDocumentProps["onSeek"];
}) {
  const linkable = fact.time_s !== null && fact.time_s !== undefined && Boolean(onSeek);
  const cite = citationTitle(fact);
  const text = numbered !== null ? `${numbered}. ${fact.text}` : fact.text;
  return (
    <li className={cx(ROW, "relative", selected && "bg-slate")} title={factTitle(fact)} data-selected={selected || undefined}>
      {selected && <span className="absolute left-[-16px] top-0 bottom-0 w-0.5 bg-pad" aria-hidden />}
      <span className="self-center flex items-center justify-center h-3">
        <ConfidenceDot confidence={fact.confidence} />
      </span>
      <div className="min-w-0">
        {linkable ? (
          <button
            type="button"
            className="text-left hover:text-pad focus-visible:text-pad"
            onClick={() => onSeek?.({ key: refKey, fact })}
            aria-label={`${fact.text} Seek to ${fmtClock(fact.time_s as number)}`}
          >
            {text}
          </button>
        ) : (
          <span>{text}</span>
        )}
        {cite && fact.citation && (
          <>
            {" "}
            <a
              href={fact.citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-chalk-dim underline underline-offset-2 hover:text-pad"
              title={fact.citation.url}
            >
              [{cite}]
            </a>
          </>
        )}
      </div>
      <span className="font-mono text-xs text-chalk-dim whitespace-nowrap">
        {fact.time_s !== null && fact.time_s !== undefined ? (
          <>
            {fmtClock(fact.time_s)}
            {fact.end_s !== null && fact.end_s !== undefined && ` – ${fmtClock(fact.end_s)}`}
          </>
        ) : fact.bar !== null && fact.bar !== undefined ? (
          `bar ${fact.bar + 1}`
        ) : null}
      </span>
    </li>
  );
}

function MissingLine({
  missing,
  job,
  canQueue,
  onQueue,
  onRetry,
}: {
  missing: BreakdownMissing;
  job: JobRow | undefined;
  canQueue: boolean;
  onQueue: BreakdownDocumentProps["onQueue"];
  onRetry: BreakdownDocumentProps["onRetry"];
}) {
  const label = missingJobLabel(missing.job);
  const pending = isPending(job);
  return (
    <li className={cx(ROW, "text-chalk-dim")} title={missing.job ? `job ${missing.job}` : undefined}>
      <span aria-hidden />
      <div className="min-w-0">
        <span className="text-chalk-faint">not measured yet</span> {missing.text}
      </div>
      <div className="flex items-center gap-2 whitespace-nowrap">
        {label && pending && <span className="text-xs">{`${label[0]!.toLowerCase()}${label.slice(1)} ${jobStatusText(job)}`}</span>}
        {label && !pending && job?.status === "failed" && (
          <>
            <span className="text-xs">{jobStatusText(job)}</span>
            {onRetry && (
              <button type="button" className={btnQuiet} onClick={() => onRetry(job)}>
                Retry
              </button>
            )}
          </>
        )}
        {label && !pending && job?.status !== "failed" && (
          <button
            type="button"
            className={btn}
            disabled={!canQueue || !onQueue}
            onClick={() => missing.job && onQueue?.(missing.job)}
            title={canQueue ? `Queue the job that measures this (${missing.job})` : "That stem isn't in the library; separate stems again"}
          >
            {label}
          </button>
        )}
      </div>
    </li>
  );
}
