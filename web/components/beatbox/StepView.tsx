"use client";

// The editable step view of one transcription: bars × 16 steps with class
// labels and the measured offset in ms per hit. Click a hit to change its
// class; Save corrections stores { hit_index, corrected_class } rows into
// the midi row's notes JSON for the next enrollment.

import { useMemo, useState } from "react";
import { btn, btnPrimary, btnQuiet, cx, label, select } from "@/components/ui";
import { beatboxApi } from "@/lib/api/beatbox";
import { errorMessage } from "@/lib/api/client";
import { classLabel, correctionsOf, effectiveClass, hitsOf, setCorrection, stepViewFromHits, type BeatboxCorrection, type StepHit } from "@/lib/beatbox/stepview";
import type { MidiRow } from "@/lib/types/db";

export function StepView({ midi, classes, onSaved }: { midi: MidiRow; classes: string[]; onSaved: (midi: MidiRow) => void }) {
  const hits = useMemo(() => hitsOf(midi.notes), [midi.notes]);
  const saved = useMemo(() => correctionsOf(midi.notes), [midi.notes]);
  const [corrections, setCorrections] = useState<BeatboxCorrection[]>(saved);
  const [selected, setSelected] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => stepViewFromHits(hits, corrections), [hits, corrections]);
  const dirty = JSON.stringify(corrections) !== JSON.stringify(saved);
  const options = useMemo(() => Array.from(new Set([...classes, ...hits.map((h) => h.cls), "other"])), [classes, hits]);
  const selectedHit: StepHit | null = useMemo(() => {
    if (selected === null) return null;
    for (const r of rows) for (const c of r.steps) for (const h of c.hits) if (h.hit_index === selected) return h;
    return null;
  }, [rows, selected]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await beatboxApi.saveCorrections(midi.id, corrections);
      onSaved(res.midi);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (hits.length === 0) return <p className="px-4 py-2 text-xs text-chalk-dim">No hits in this transcription.</p>;

  return (
    <div className="px-4 py-2 flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="border-collapse font-mono text-2xs" role="grid" aria-label="Step view">
          <thead>
            <tr>
              <th className="text-left text-chalk-dim font-normal pr-2">bar</th>
              {Array.from({ length: 16 }, (_, s) => (
                <th key={s} className={cx("font-normal text-chalk-dim w-[30px] text-center", s % 4 === 0 && "border-l border-rule-strong")}>
                  {s % 4 === 0 ? s / 4 + 1 : "·"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.bar} className="border-t border-rule">
                <td className="text-chalk-dim pr-2 align-top py-0.5">{row.bar + 1}</td>
                {row.steps.map((cell) => (
                  <td key={cell.step} className={cx("align-top p-0 w-[30px] h-[28px]", cell.step % 4 === 0 && "border-l border-rule-strong", cell.step % 4 !== 0 && "border-l border-rule")}>
                    {cell.hits.map((h) => {
                      const cls = effectiveClass(h);
                      const isSel = h.hit_index === selected;
                      return (
                        <button
                          key={h.hit_index}
                          type="button"
                          className={cx("block w-full text-center leading-tight py-0.5 hover:bg-slate", isSel && "bg-slate outline outline-1 outline-pad")}
                          onClick={() => setSelected(isSel ? null : h.hit_index)}
                          title={`hit ${h.hit_index + 1}: ${cls}${h.corrected_class ? ` (was ${h.cls})` : ""}, ${h.offset_ms >= 0 ? "+" : ""}${h.offset_ms.toFixed(1)} ms, confidence ${h.confidence.toFixed(2)}`}
                          aria-pressed={isSel}
                        >
                          <span className={cx("text-xs", h.corrected_class && "underline decoration-dotted")}>{classLabel(cls)}</span>
                          <span className="block text-chalk-dim">{Math.round(h.offset_ms) >= 0 ? "+" : ""}{Math.round(h.offset_ms)}</span>
                        </button>
                      );
                    })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {selectedHit ? (
          <>
            <span className="font-mono">
              hit <span className="text-chalk">{selectedHit.hit_index + 1}</span> bar {rows.find((r) => r.steps.some((c) => c.hits.includes(selectedHit)))!.bar + 1} step{" "}
              {rows.flatMap((r) => r.steps).find((c) => c.hits.includes(selectedHit))!.step + 1}, {selectedHit.offset_ms >= 0 ? "+" : ""}
              {selectedHit.offset_ms.toFixed(1)} ms, predicted {selectedHit.cls} ({selectedHit.confidence.toFixed(2)})
            </span>
            <span className="flex items-center gap-1.5">
              <span className={label}>class</span>
              <select
                className={cx(select, "h-6 text-xs")}
                value={effectiveClass(selectedHit)}
                aria-label="Corrected class"
                onChange={(e) => setCorrections((prev) => setCorrection(prev, selectedHit.hit_index, e.target.value, selectedHit.cls))}
              >
                {options.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </span>
          </>
        ) : (
          <span className="text-chalk-dim">Click a hit to correct its class; offsets are the measured ms from the 16th.</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {corrections.length > 0 && (
            <span className="font-mono text-chalk-dim">
              {corrections.length} corrected{saved.length === corrections.length && !dirty ? ", saved" : ""}
            </span>
          )}
          {dirty && (
            <button type="button" className={btnQuiet} onClick={() => (setCorrections(saved), setSelected(null))}>
              Discard
            </button>
          )}
          <button type="button" className={dirty ? btnPrimary : btn} disabled={!dirty || saving} onClick={() => void save()} title="Stored on the transcription; the next enrollment learns from them">
            Save corrections
          </button>
        </span>
        {error && <span role="alert">{error}</span>}
      </div>
    </div>
  );
}
