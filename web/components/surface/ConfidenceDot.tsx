// The confidence dot: three fill levels in pad amber, aligned with the hedge
// bands (full >= 0.8, half 0.6–0.8, ring below), and nothing for unmeasured.

import { confidenceLevel, hedgeWord } from "@/lib/report/hedge";

export function ConfidenceDot({ confidence, className = "" }: { confidence: number | null | undefined; className?: string }) {
  const level = confidenceLevel(confidence);
  if (level === "none") return null;
  const word = hedgeWord(confidence);
  const title = `confidence ${(confidence as number).toFixed(2)}${word ? ` (${word})` : ""}`;
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-level={level}
      className={`inline-block w-2 h-2 rounded-full align-middle shrink-0 ${className}`}
      style={
        level === "full"
          ? { background: "var(--color-pad)" }
          : level === "half"
            ? { background: "linear-gradient(90deg, var(--color-pad) 50%, transparent 50%)", boxShadow: "inset 0 0 0 1px var(--color-pad)" }
            : { boxShadow: "inset 0 0 0 1px var(--color-pad-dim)" }
      }
    />
  );
}
