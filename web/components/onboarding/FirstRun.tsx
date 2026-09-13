"use client";

// The first four minutes, at the top of the chat column.
//
// It is one strip, and it is whatever the account's own state says it should
// be: the empty crate, the upload, the ladder of the first analysis, the
// measurements that come back, or — for a producer who already has a crate —
// what landed while they were away. When there is nothing true to say it
// renders nothing at all (lib/onboarding/state.ts decides; this file only
// draws it).
//
// It teaches by doing rather than by touring. There is no modal, no carousel
// and no checklist: the product's own output is the tutorial, and the only
// screen that has to talk is the one where there is nothing to look at yet.

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fileTitle, statusText } from "@/components/library/FileRow";
import { UploadZone } from "@/components/library/UploadZone";
import { btn, btnPrimary, btnQuiet, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { PLAN_LIMITS } from "@/lib/billing/limits";
import type { UsageReport } from "@/lib/billing/usage";
import { fmtBytes, fmtClock, fmtNumber, fmtPercent } from "@/lib/format";
import { crateLine, crateLines } from "@/lib/onboarding/crate";
import { findingsHeadline, firstFindings } from "@/lib/onboarding/findings";
import { capWarnings, planSentence, planShape, UNMETERED_NOTE, usageShape } from "@/lib/onboarding/limits";
import { EMPTY_MEMORY, readMemory, writeMemory, type OnboardingMemory } from "@/lib/onboarding/memory";
import { elapsedSeconds, pastAnalysisRuns, positionAt } from "@/lib/onboarding/stages";
import { firstRunStep, firstRunSubject, wayBackIn, type FirstRunStep } from "@/lib/onboarding/state";
import { effective } from "@/lib/report/effective";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { FileRow, JobRow, LoopRow } from "@/lib/types/db";
import { CapShape } from "./CapShape";
import { FindingsTable } from "./FindingsTable";
import { NotAGenerator } from "./NotAGenerator";
import { StageLadder } from "./StageLadder";

/** The surface tab event SurfaceTabs.tsx documents, so the loops open where they live. */
const TAB_EVENT = "crateai:tab";

function isFindJob(job: JobRow): boolean {
  return (
    job.kind === "analyze" &&
    typeof job.params === "object" &&
    job.params !== null &&
    !Array.isArray(job.params) &&
    job.params.task === "find_loops"
  );
}

function useMemory() {
  const [memory, setMemory] = useState<OnboardingMemory>(EMPTY_MEMORY);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setMemory(readMemory());
    setLoaded(true);
  }, []);

  // The visit is stamped on the way out of every change, but this session keeps
  // the *previous* stamp in state, so "while you were away" stays true for as
  // long as it is on screen.
  useEffect(() => {
    if (!loaded) return;
    writeMemory({ ...memory, lastSeenAt: new Date().toISOString() });
  }, [loaded, memory]);

  const update = useCallback((patch: Partial<OnboardingMemory>) => {
    setMemory((prev) => ({ ...prev, ...patch }));
  }, []);

  return { memory, loaded, update };
}

/** The caps, once, on page load. The account page is the live view of them. */
function useUsage(enabled: boolean): UsageReport | null {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/usage", { credentials: "same-origin", headers: { accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as UsageReport;
        if (!cancelled) setUsage(body);
      } catch {
        // the caps are a courtesy; the workspace works without them
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return usage;
}

export function FirstRun() {
  const lib = useLibrary();
  const router = useRouter();
  const pathname = usePathname();
  const { memory, loaded, update } = useMemory();

  const step = useMemo<FirstRunStep>(
    () => (loaded ? firstRunStep({ files: lib.files, jobs: lib.jobs, uploads: lib.uploads, memory }) : { kind: "silent" }),
    [loaded, lib.files, lib.jobs, lib.uploads, memory],
  );

  // Remember the record that taught them, and the one they had open last.
  useEffect(() => {
    if (!loaded || memory.firstReadyFileId) return;
    const first = firstRunSubject(lib.files, memory);
    if (first && first.status === "ready" && first.report !== null) {
      update({ firstReadyFileId: first.id, firstReadyAt: new Date().toISOString() });
    }
  }, [loaded, lib.files, memory, update]);

  useEffect(() => {
    if (!loaded) return;
    const id = pathname.startsWith("/f/") ? (pathname.slice(3).split("/")[0] ?? null) : null;
    if (id && id !== memory.lastFileId) update({ lastFileId: id });
  }, [loaded, pathname, memory.lastFileId, update]);

  useEffect(() => {
    if (loaded && step.kind === "empty" && !memory.seenConstraint) update({ seenConstraint: true });
  }, [loaded, step.kind, memory.seenConstraint, update]);

  const usage = useUsage(loaded && (step.kind === "empty" || step.kind === "ready" || step.kind === "returning"));
  const dismiss = () => update({ dismissedAt: new Date().toISOString() });

  if (!loaded || step.kind === "silent") return null;

  return (
    <section
      aria-label={step.kind === "returning" ? "Your crate" : "Getting started"}
      className="shrink-0 max-h-[60vh] overflow-y-auto border-b border-rule px-4 py-3"
    >
      {step.kind === "empty" && <EmptyCrate usage={usage} />}
      {step.kind === "uploading" && <Uploading step={step} />}
      {(step.kind === "queued" || step.kind === "analyzing") && <Working step={step} jobs={lib.jobs} />}
      {step.kind === "failed" && <Failed step={step} />}
      {step.kind === "ready" && (
        <Ready
          file={step.file}
          usage={usage}
          compact={pathname === `/f/${step.file.id}`}
          seenConstraint={memory.seenConstraint}
          onOpen={() => router.push(`/f/${step.file.id}`)}
          onDismiss={dismiss}
        />
      )}
      {step.kind === "returning" && (
        <Returning
          step={step}
          usage={usage}
          files={lib.files}
          memory={memory}
          onOpen={(id) => router.push(`/f/${id}`)}
          onDismiss={dismiss}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// empty
// ---------------------------------------------------------------------------

function EmptyCrate({ usage }: { usage: UsageReport | null }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight leading-tight">Nothing in the crate yet. Drop one record in.</h1>
        <p className="mt-1 text-sm text-chalk-dim">
          One is enough. It comes back with its tempo, its key, where bar 1 sits and where the sections change, each
          with the confidence it was measured with — and then the loops in it, ranked, and playable.
        </p>
      </div>

      <UploadZone variant="hero" />

      <ol className="text-sm">
        <Step n="1" head="It is hashed here, in your browser.">
          Bytes only move if the hash is new, so a record you already have is caught before it uploads twice.
        </Step>
        <Step n="2" head="It gets measured, and you watch which measurement is running.">
          Tempo, then beats and downbeats, key, groove, loudness, spectrum, sections. Real work on your file rather than
          a spinner, and nothing is stated before it has been measured.
        </Step>
        <Step n="3" head="You correct whatever is wrong.">
          Halve or double the tempo, take the alternate key, put bar 1 where you hear it. Your correction wins over the
          measurement everywhere, permanently.
        </Step>
      </ol>

      <NotAGenerator />

      <div>
        <p className="text-sm text-chalk-dim">{planSentence(usage?.plan ?? "free")}</p>
        <p className="mt-1 text-sm text-chalk-dim">{UNMETERED_NOTE}</p>
        <details className="mt-1">
          <summary className="text-xs text-chalk-faint hover:text-chalk-dim cursor-pointer">Every cap, and what is left</summary>
          <div className="mt-1">
            <CapShape lines={usage ? usageShape(usage) : planShape("free")} />
          </div>
        </details>
      </div>
    </div>
  );
}

function Step({ n, head, children }: { n: string; head: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2 border-t border-rule py-1.5 first:border-t-0">
      <span className="font-mono text-xs text-chalk-faint">{n}</span>
      <span>
        <span className="text-sm">{head}</span>{" "}
        <span className="text-sm text-chalk-dim">{children}</span>
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// the wait
// ---------------------------------------------------------------------------

function Uploading({ step }: { step: Extract<FirstRunStep, { kind: "uploading" }> }) {
  const { uploader } = useLibrary();
  const u = step.upload;
  const line =
    u.state === "hashing"
      ? `Hashing it here, before anything uploads — ${fmtPercent(u.progress)} of ${fmtBytes(u.size)}.`
      : u.state === "checking"
        ? "Checking it against what you already have."
        : u.state === "uploading"
          ? `Uploading — ${fmtPercent(u.progress)} of ${fmtBytes(u.size)}.`
          : u.state === "completing"
            ? "Queueing the analysis."
            : u.state === "failed"
              ? (u.error ?? "The upload failed.")
              : "Waiting to start.";
  return (
    <div>
      <h2 className="text-md truncate">{u.name}</h2>
      <p className="mt-1 text-sm text-chalk-dim">{line}</p>
      {u.state !== "failed" && (
        <p className="mt-1 text-xs text-chalk-faint">
          Nothing is measured until the bytes are up. The analysis starts on its own the moment they are.
        </p>
      )}
      {u.state === "failed" && (
        <div className="mt-2 flex gap-2">
          <button type="button" className={btn} onClick={() => uploader.retry(u.id)}>
            Retry
          </button>
          <button type="button" className={btnQuiet} onClick={() => uploader.remove(u.id)}>
            Remove
          </button>
        </div>
      )}
      {step.others > 0 && (
        <p className="mt-1 text-xs text-chalk-faint">
          {step.others} more in the queue; they upload two at a time and are hashed one at a time.
        </p>
      )}
    </div>
  );
}

function Working({ step, jobs }: { step: Extract<FirstRunStep, { kind: "queued" | "analyzing" }>; jobs: JobRow[] }) {
  const { file, job } = step;
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const progress = job?.progress ?? null;
  const position = positionAt(progress);
  const past = useMemo(() => pastAnalysisRuns(jobs), [jobs]);
  const dispatchNote = job?.error?.startsWith("dispatch:") ? job.error.slice("dispatch:".length).trim() : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-md truncate">{fileTitle(file)}</h2>
        <span className="font-mono text-sm text-chalk-dim shrink-0">
          {step.kind === "analyzing" && progress !== null ? fmtPercent(progress) : statusText(file, job ? [job] : []).text}
        </span>
      </div>
      {step.kind === "queued" ? (
        <p className="mt-1 text-sm text-chalk-dim">
          {dispatchNote
            ? `Queued, but ${dispatchNote}. It will run as soon as compute is reachable.`
            : "Queued. Compute scales to zero between jobs, so a machine may have to start before it can read the file."}
        </p>
      ) : (
        <p className="mt-1 text-sm text-chalk-dim">Measuring it now.</p>
      )}
      <div className="mt-2">
        <StageLadder position={position} progress={progress} elapsedS={job ? elapsedSeconds(job) : null} past={past} />
      </div>
      <p className="mt-2 text-xs text-chalk-faint">
        Drop more records while this runs; they queue behind it. Nothing here needs your attention until it lands.
      </p>
    </div>
  );
}

function Failed({ step }: { step: Extract<FirstRunStep, { kind: "failed" }> }) {
  const { file, job } = step;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <h2 className="text-md truncate">{fileTitle(file)} did not analyze.</h2>
      <p className="mt-1 text-sm">{job?.error ?? "The job failed without saying why."}</p>
      <p className="mt-1 text-sm text-chalk-dim">
        The file is still in your library and nothing about it was lost. A retry runs the same pass again; if it fails
        the same way, the file itself is the problem and another record is the faster test.
      </p>
      {job && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void api.jobs
                .retry(job.id)
                .catch((err: unknown) => setError(errorMessage(err)))
                .finally(() => setBusy(false));
            }}
          >
            Retry
          </button>
          {error && <span className="text-xs">{error}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the payoff
// ---------------------------------------------------------------------------

function Ready({
  file,
  usage,
  compact,
  seenConstraint,
  onOpen,
  onDismiss,
}: {
  file: FileRow;
  usage: UsageReport | null;
  compact: boolean;
  seenConstraint: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const lib = useLibrary();
  const report = useMemo(() => (file.report ? effective(file.report) : null), [file.report]);
  const findings = useMemo(() => firstFindings(report), [report]);
  const headline = findingsHeadline(report);
  const warnings = usage ? capWarnings(usage) : [];

  const findJob = useMemo(() => lib.jobs.find((j) => j.file_id === file.id && isFindJob(j)) ?? null, [lib.jobs, file.id]);
  const [loops, setLoops] = useState<LoopRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (findJob?.status !== "done") return;
    let cancelled = false;
    void api.loops
      .list(file.id)
      .then((res) => {
        if (!cancelled) setLoops(res.loops);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [findJob?.status, file.id]);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.loops.find({ file_id: file.id });
      lib.upsertJob(res.job);
      if (res.dispatch && !res.dispatch.ok) setError(`Queued, but ${res.dispatch.reason}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openLoops = () => {
    onOpen();
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: "loops" })), 120);
  };

  const best = loops && loops.length > 0 ? [...loops].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] : null;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-md truncate" title={file.original_filename}>
          {fileTitle(file)}
        </h2>
        <button type="button" className={btnQuiet} onClick={onDismiss} title="Put this away; the library and the chat stay as they are">
          Hide
        </button>
      </div>
      {headline && <p className="font-mono text-sm text-chalk-dim">{headline}</p>}

      {!compact && (
        <>
          <p className="mt-2 text-sm text-chalk-dim">
            Measured off your file, not looked up. The dot is the confidence each value was measured with; where it is
            low the wording says so rather than rounding it away.
          </p>
          <div className="mt-2">
            <FindingsTable findings={findings} />
          </div>
          <p className="mt-2 text-sm text-chalk-dim">
            Anything wrong here is yours to fix, and the fix is kept: halve or double the tempo, take the alternate key,
            put bar 1 where you hear it. Corrections beat measurements everywhere afterwards.
          </p>
        </>
      )}

      <div className="mt-3 border-t border-rule pt-2">
        {findJob && findJob.status !== "done" && findJob.status !== "failed" ? (
          <p className="text-sm text-chalk-dim">
            Ranking loop candidates on the beat grid
            {findJob.progress !== null ? ` — ${fmtPercent(findJob.progress)}` : ""}.
          </p>
        ) : loops !== null ? (
          <div>
            <p className="text-sm">
              {loops.length === 0
                ? "The finder came back with nothing on this one, which happens when there is no steady grid to cut on."
                : `${loops.length} loop${loops.length === 1 ? "" : "s"} found.`}
              {best && (
                <span className="text-chalk-dim">
                  {" "}
                  Best: <span className="font-mono">{best.bars ?? "?"}</span> bars at{" "}
                  <span className="font-mono">{fmtClock(best.start_s)}</span>
                  {best.score !== null && (
                    <>
                      , scored <span className="font-mono">{fmtNumber(best.score, 2)}</span>
                    </>
                  )}
                  .
                </span>
              )}
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className={btnPrimary} onClick={openLoops}>
                {loops.length === 0 ? "Open it and cut one by hand" : "Play them"}
              </button>
              <button type="button" className={btn} onClick={onDismiss}>
                Done with this
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-chalk-dim">
              Next: the finder ranks the sections worth flipping, with the edges on the beat grid, and every candidate
              is something you can play and drag. It costs nothing against the caps.
            </p>
            <div className="mt-2 flex gap-2">
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => void find()}>
                Find the loops
              </button>
              <button type="button" className={btn} onClick={onOpen}>
                Open the waveform
              </button>
            </div>
          </div>
        )}
        {error && <p className="mt-1 text-xs">{error}</p>}
        {!compact && (
          <p className="mt-2 text-xs text-chalk-faint">
            After that, the breakdown: how the record was put together, every number linked to the place in the
            waveform it came from. It wants the drums separated first, which spends one of the{" "}
            <span className="font-mono">{usage?.limits.stem_jobs_per_month ?? PLAN_LIMITS.free.stem_jobs_per_month}</span>{" "}
            separations a month, so it waits on the Breakdown tab until you ask for it.
          </p>
        )}
      </div>

      {!seenConstraint && (
        <div className="mt-3">
          <NotAGenerator short />
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="mt-3 border-t border-rule pt-2">
          {warnings.map((w) => (
            <li key={w} className="text-xs text-chalk-dim">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// coming back
// ---------------------------------------------------------------------------

function Returning({
  step,
  usage,
  files,
  memory,
  onOpen,
  onDismiss,
}: {
  step: Extract<FirstRunStep, { kind: "returning" }>;
  usage: UsageReport | null;
  files: FileRow[];
  memory: OnboardingMemory;
  onOpen: (id: string) => void;
  onDismiss: () => void;
}) {
  const summary = step.summary;
  const lines = crateLines(summary);
  const line = crateLine(summary);
  const back = wayBackIn(files, summary, memory);
  const warnings = usage ? capWarnings(usage) : [];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-md">{step.newSession ? "Where you left off" : "In the crate"}</h2>
        <button type="button" className={btnQuiet} onClick={onDismiss} title="Put this away for good">
          Hide
        </button>
      </div>
      {line && <p className="font-mono text-sm text-chalk-dim">{line}</p>}
      {lines.length > 0 && (
        <ul className="mt-1">
          {lines.map((l) => (
            <li key={l} className="text-sm text-chalk-dim">
              {l}
            </li>
          ))}
        </ul>
      )}
      {summary.records >= 3 && (
        <p className="mt-1 text-sm text-chalk-dim">
          With this much in it the crate answers questions: the search box takes{" "}
          <span className="font-mono text-chalk">f minor 88-94</span> or{" "}
          <span className="font-mono text-chalk">like the open file</span>, and{" "}
          <span className="text-chalk">what fits this</span> on an open record racks up everything that would sit under
          it.
        </p>
      )}
      {(back || warnings.length > 0) && (
        <div className={cx("mt-2 flex flex-wrap items-center gap-2", warnings.length > 0 && "border-t border-rule pt-2")}>
          {back && (
            <button type="button" className={btn} onClick={() => onOpen(back.id)}>
              Open {fileTitle(back)}
            </button>
          )}
          {warnings.map((w) => (
            <span key={w} className="text-xs text-chalk-dim">
              {w}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
