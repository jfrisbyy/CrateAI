// The caps, as a table of numbers with a rule between rows. Shown before
// anything has been spent (so the shape is known in advance) and again when a
// count gets close (so the wall is visible before it is hit).

import { cx } from "@/components/ui";
import type { CapLine } from "@/lib/onboarding/limits";
import { WARN_AT } from "@/lib/onboarding/limits";

export function CapShape({ lines, note }: { lines: CapLine[]; note?: string | null }) {
  return (
    <div>
      <ul>
        {lines.map((line) => (
          <li key={line.id} className="border-t border-rule py-1 first:border-t-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-chalk-dim">{line.label}</span>
              <span className="font-mono text-sm">{line.value}</span>
            </div>
            {(line.detail || line.fraction !== null) && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-chalk-faint">{line.detail}</span>
                {line.fraction !== null && (
                  <span
                    className={cx("font-mono text-xs", line.fraction >= WARN_AT ? "text-chalk" : "text-chalk-faint")}
                    title={`${Math.round(line.fraction * 100)}% of the cap`}
                  >
                    {Math.round(line.fraction * 100)}%
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {note && <p className="mt-2 text-xs text-chalk-dim">{note}</p>}
    </div>
  );
}
