// The comparison as the same document, side by side: sections in producer
// order, each delta as a statement with the two values in the mono face and
// the unit, the source on hover, and the prerequisites that were missing.

import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { hedgeWord } from "@/lib/report/hedge";
import type { ComparisonContent, ComparisonDelta } from "@/lib/types/db";
import { COMPARE_SECTIONS, explainMissing, formatDelta, formatValue } from "./format";

export interface ComparisonViewProps {
  content: ComparisonContent;
  /** the two files' names, shown under "mine" and "the reference" */
  aTitle: string;
  bTitle: string;
}

function deltaTitle(delta: ComparisonDelta): string {
  const parts = [`from ${delta.source}`];
  if (delta.confidence !== null && delta.confidence !== undefined) {
    const word = hedgeWord(delta.confidence);
    parts.push(`confidence ${delta.confidence.toFixed(2)}${word ? ` (${word})` : ""}`);
  }
  return parts.join(", ");
}

export function ComparisonView({ content, aTitle, bTitle }: ComparisonViewProps) {
  const sections = COMPARE_SECTIONS.map((s) => ({ ...s, deltas: content.deltas.filter((d) => d.section === s.key) })).filter((s) => s.deltas.length > 0);
  const th = "text-right font-normal text-xs text-chalk-dim pb-1 whitespace-nowrap";
  const td = "font-mono text-right align-baseline whitespace-nowrap pl-4";
  return (
    <div className="max-w-[860px]">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-x-4 text-xs border-b border-rule pb-1.5">
        <span className="text-chalk-dim">
          generated <span className="font-mono text-chalk">{content.generated_at.slice(0, 16).replace("T", " ")}</span>
        </span>
        <span className="text-right">
          <span className="text-chalk-dim">{content.a_name}</span>{" "}
          <span className="text-chalk truncate max-w-[200px] inline-block align-bottom" title={aTitle}>
            {aTitle}
          </span>
        </span>
        <span className="text-right">
          <span className="text-chalk-dim">{content.b_name}</span>{" "}
          <span className="text-chalk truncate max-w-[200px] inline-block align-bottom" title={bTitle}>
            {bTitle}
          </span>
        </span>
        <span className="text-right text-chalk-dim">delta</span>
      </div>

      {sections.length === 0 && <p className="mt-2 text-sm text-chalk-dim">Nothing could be compared yet.</p>}

      {sections.map((section) => (
        <section key={section.key} className="border-b border-rule py-2.5" aria-label={section.title}>
          <h2 className="text-sm font-medium">{section.title}</h2>
          <table className="mt-1 w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th className={th}>statement</th>
                <th className={th}>{content.a_name}</th>
                <th className={th}>{content.b_name}</th>
                <th className={th}>delta</th>
              </tr>
            </thead>
            <tbody>
              {section.deltas.map((delta, i) => (
                <tr key={`${delta.metric}:${i}`} className="border-t border-rule/50 first:border-t-0" title={deltaTitle(delta)} data-source={delta.source}>
                  <td className="py-1 pr-2 align-baseline">
                    <span className="inline-flex items-baseline gap-2">
                      <span className="self-center inline-flex items-center h-3">
                        <ConfidenceDot confidence={delta.confidence} />
                      </span>
                      <span>{delta.text}</span>
                      {delta.hedge && delta.hedge !== "not measured" && <span className="text-xs text-chalk-dim">{delta.hedge}</span>}
                    </span>
                  </td>
                  <td className={td}>{formatValue(delta.a, delta.unit)}</td>
                  <td className={td}>{formatValue(delta.b, delta.unit)}</td>
                  <td className={`${td} text-chalk-dim`}>{formatDelta(delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {content.missing.length > 0 && (
        <section className="py-2.5" aria-label="Not compared">
          <h2 className="text-sm font-medium text-chalk-dim">Not compared yet</h2>
          <ul className="mt-1 text-sm text-chalk-dim">
            {content.missing.map((key) => (
              <li key={key} className="py-0.5">
                <span className="text-chalk-faint">needs</span> {explainMissing(key)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
