// What the record came back knowing about itself: a table of numbers with a
// rule between rows, each with the confidence it was measured with and the
// hedge word its band calls for. No decoration; the numbers are the interface.

import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import type { Finding } from "@/lib/onboarding/findings";
import { hedgeWord } from "@/lib/report/hedge";

export function FindingsTable({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul>
      {findings.map((f) => {
        const hedge = f.confidence === null ? "" : hedgeWord(f.confidence);
        return (
          <li key={f.id} className="border-t border-rule py-1.5 first:border-t-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-chalk-dim">
                {f.label}
                {hedge && hedge !== "not measured" && <span className="text-chalk-faint"> {hedge}</span>}
              </span>
              <span className="flex items-baseline gap-1.5 shrink-0">
                <span className="font-mono text-md">{f.value}</span>
                <ConfidenceDot confidence={f.confidence} className="translate-y-[-1px]" />
              </span>
            </div>
            {f.note && <p className="text-xs text-chalk-faint">{f.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}
