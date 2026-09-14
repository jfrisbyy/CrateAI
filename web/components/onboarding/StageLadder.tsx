// The wait, shown as what the job is doing rather than as a spinner.
//
// Each row is one step of the analysis with what it produces. The step running
// now is in chalk with the amber tick that means live; finished steps are dim;
// the rest are faint. The one thing this must not do is imply a value has
// arrived early.
//
// `partial` says whether the report is being published stage by stage
// (`report.pending`; the compute side is `jobs/analyze.py`'s `on_partial`). It
// changes one line: with partial reports the numbers above the ladder are
// already real and the ladder is what is still to come; without them the report
// arrives in one pass at the end and there is nothing half-measured to show.
// Both sentences are true of the pipeline that produced them, which is why this
// is a flag rather than a rewrite — the component never guesses which it is.

import { cx } from "@/components/ui";
import { fmtElapsed, type LadderPosition, type PastRuns } from "@/lib/onboarding/stages";

export function StageLadder({
  position,
  progress,
  elapsedS,
  past,
  partial = false,
}: {
  position: LadderPosition;
  progress: number | null;
  elapsedS: number | null;
  past: PastRuns | null;
  partial?: boolean;
}) {
  const runningId = position.running?.id ?? null;
  return (
    <div>
      <div className="h-px w-full bg-rule" aria-hidden>
        <div
          className="h-px bg-pad transition-[width] duration-500"
          style={{ width: `${Math.round(Math.max(0.02, progress ?? 0.02) * 100)}%` }}
        />
      </div>
      <ul className="mt-2">
        {[...position.done, ...(position.running ? [position.running] : []), ...position.waiting].map((stage) => {
          const done = position.done.includes(stage);
          const running = stage.id === runningId;
          return (
            <li
              key={stage.id}
              className="grid grid-cols-[10px_92px_minmax(0,1fr)] items-baseline gap-x-2 py-0.5"
              aria-current={running ? "step" : undefined}
            >
              <span aria-hidden className={cx("font-mono text-xs", running ? "text-pad" : done ? "text-chalk-dim" : "text-chalk-faint")}>
                {running ? "▸" : done ? "·" : ""}
              </span>
              <span className={cx("text-sm", running ? "text-chalk" : done ? "text-chalk-dim" : "text-chalk-faint")}>{stage.label}</span>
              <span className={cx("text-xs truncate", running ? "text-chalk-dim" : "text-chalk-faint")}>{stage.gives}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-chalk-dim">
        {elapsedS === null ? "Waiting for a machine to pick it up." : `${fmtElapsed(elapsedS)} so far.`}{" "}
        {past
          ? `Analyses on this account have taken about ${fmtElapsed(past.medianS)} (${past.runs} of them).`
          : "No estimate yet: this is the first one on this account."}
      </p>
      <p className="mt-1 text-xs text-chalk-faint">
        {partial
          ? "Each measurement is written down the moment it is made, so what is above the ladder is final and what is below it has not been measured yet."
          : "The report is written in one pass at the end, so there are no half-measured numbers to show you. This is where the job actually is."}
      </p>
    </div>
  );
}
