"use client";

// Record mode: length, a one-bar count-in, hits on the effective 16th grid
// with their offsets, and Save as MIDI. The step view is one row per pad
// that was hit, sixteen columns per bar; each hit shows its offset in ms,
// positive when late.

import { useEffect, useMemo, useState } from "react";
import { btn, btnPrimary, btnQuiet, cx, label, segment, segmentItem } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { midiApi, type MidiWithUrl, type PadHitInput } from "@/lib/api/midi";
import { fmtBpm } from "@/lib/format";
import type { PadBindings } from "@/lib/pads/bindings";
import { stepsPerBar } from "@/lib/pads/grid";
import { keyForPad } from "@/lib/pads/keymap";
import type { PadRecorder, RecorderSnapshot } from "@/lib/pads/recorder";
import { placeTake, type RecordedHit } from "@/lib/pads/recording";

const LENGTHS: ReadonlyArray<{ bars: number | null; label: string }> = [
  { bars: 1, label: "1" },
  { bars: 2, label: "2" },
  { bars: 4, label: "4" },
  { bars: 8, label: "8" },
  { bars: null, label: "until stop" },
];

export function RecordPanel({
  fileId,
  bpm,
  bpmMeasured,
  beatsPerBar,
  recorder,
  recording,
  bindings,
  hasPads,
  onSaved,
}: {
  fileId: string;
  bpm: number;
  /** false when the file has no tempo yet and the default is in use */
  bpmMeasured: boolean;
  beatsPerBar: number;
  recorder: PadRecorder;
  recording: RecorderSnapshot;
  bindings: PadBindings;
  hasPads: boolean;
  onSaved: (row: MidiWithUrl) => void;
}) {
  const [bars, setBars] = useState<number | null>(2);
  const [click, setClick] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<MidiWithUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const armed = recording.state === "count-in" || recording.state === "recording";

  // A moving readout while armed.
  const [position, setPosition] = useState<{ bar: number; step: number; countIn: boolean } | null>(null);
  useEffect(() => {
    if (!armed) {
      setPosition(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      setPosition(recorder.position());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [armed, recorder]);

  // Hits placed live while recording; the finished take afterwards.
  const view = useMemo(() => {
    if (recording.take) return recording.take;
    if (!recording.settings) return null;
    const barsNow = recording.settings.bars ?? Math.max(1, (position?.bar ?? 0) + 1);
    return { bars: barsNow, hits: placeTake(recording.hits, recording.settings, barsNow) };
  }, [recording, position?.bar]);

  const arm = () => {
    setSaved(null);
    setError(null);
    recorder.arm({ bpm, beatsPerBar, bars, clickWhileRecording: click });
  };

  const save = async () => {
    const take = recording.take;
    if (!take || take.hits.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const hits: PadHitInput[] = take.hits.map((h) => ({ time_s: h.time_s, pad: h.pad, chop_file_id: h.chop_file_id, velocity: h.velocity }));
      const res = await midiApi.savePads({ file_id: fileId, bpm, bars: take.bars, beats_per_bar: beatsPerBar, hits });
      setSaved(res.midi);
      onSaved(res.midi);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Record" className="mt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={label}>Record</span>
        <div className={segment} role="group" aria-label="Length in bars">
          {LENGTHS.map((l) => (
            <button key={l.label} type="button" data-active={bars === l.bars} disabled={armed} onClick={() => setBars(l.bars)} className={cx(segmentItem, l.bars !== null && "font-mono")}>
              {l.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
          <input type="checkbox" checked={click} disabled={armed} onChange={(e) => setClick(e.target.checked)} className="accent-[#f0a63a]" />
          click while recording
        </label>
        {armed ? (
          <button type="button" className={btnPrimary} onClick={() => recorder.stop()}>
            Stop
          </button>
        ) : (
          <button type="button" className={btnPrimary} disabled={!hasPads} onClick={arm} title={hasPads ? "One bar of count-in, then tap the pads" : "Bind some chops or stems to the pads first"}>
            Record
          </button>
        )}
        {recording.state === "done" && (
          <>
            <button type="button" className={btn} disabled={saving || recording.hits.length === 0} onClick={() => void save()} title="One note per hit at its measured time, pitch 36 + pad">
              {saving ? "Saving" : "Save as MIDI"}
            </button>
            <button type="button" className={btnQuiet} onClick={() => recorder.clear()}>
              Clear
            </button>
          </>
        )}
      </div>

      <p className="mt-1.5 text-xs text-chalk-dim">
        {recording.state === "idle" && (
          <>
            One bar of count-in at <span className="font-mono text-chalk">{fmtBpm(bpm)}</span> BPM{bpmMeasured ? "" : " (no tempo measured; the default)"}, then every tap lands on the 16th grid with its offset. Velocity is always <span className="font-mono">1.00</span>; a keyboard has none.
          </>
        )}
        {recording.state === "count-in" && position && (
          <>
            count-in <span className="font-mono text-pad">{Math.floor(position.step / 4) + 1}</span>
          </>
        )}
        {recording.state === "recording" && position && (
          <>
            recording bar <span className="font-mono text-pad">{position.bar + 1}</span> beat <span className="font-mono text-pad">{Math.floor(position.step / 4) + 1}</span>, <span className="font-mono">{recording.hits.length}</span> hits
          </>
        )}
        {recording.state === "done" && recording.take && (
          <>
            <span className="font-mono text-chalk">{recording.take.bars}</span> {recording.take.bars === 1 ? "bar" : "bars"}, <span className="font-mono text-chalk">{recording.take.hits.length}</span> hits
            {recording.take.hits.length === 0 && "; nothing to save"}
            {saved && (
              <>
                , saved as <span className="font-mono text-chalk">{saved.filename}</span>
                {saved.download_url && (
                  <>
                    {" "}
                    <a href={saved.download_url} className="underline underline-offset-2 text-chalk" download={saved.filename}>
                      Download
                    </a>
                  </>
                )}
              </>
            )}
          </>
        )}
      </p>
      {error && (
        <p role="alert" className="mt-1.5 text-xs border-l-2 border-pad pl-2">
          {error}
        </p>
      )}

      {view && (view.hits.length > 0 || armed) && (
        <StepView bars={view.bars} beatsPerBar={beatsPerBar} hits={view.hits} bindings={bindings} position={position && !position.countIn ? position : null} />
      )}
    </section>
  );
}

function StepView({
  bars,
  beatsPerBar,
  hits,
  bindings,
  position,
}: {
  bars: number;
  beatsPerBar: number;
  hits: RecordedHit[];
  bindings: PadBindings;
  position: { bar: number; step: number } | null;
}) {
  const perBar = stepsPerBar(beatsPerBar);
  const total = bars * perBar;
  const pads = [...new Set(hits.map((h) => h.pad))].sort((a, b) => a - b);
  const byCell = new Map<string, RecordedHit[]>();
  for (const h of hits) {
    const key = `${h.pad}:${h.placement.global_step}`;
    const list = byCell.get(key);
    if (list) list.push(h);
    else byCell.set(key, [h]);
  }
  const current = position ? position.bar * perBar + position.step : null;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="border-collapse font-mono text-2xs" aria-label="Recorded hits on the 16th grid; offsets in milliseconds, positive late">
        <thead>
          <tr>
            <th className="text-left font-normal text-chalk-dim pr-2 py-0.5">pad</th>
            {Array.from({ length: total }, (_, i) => (
              <th
                key={i}
                className={cx("font-normal text-chalk-dim w-[26px] min-w-[26px] py-0.5 text-center", i % perBar === 0 && "border-l border-rule-strong", i % 4 === 0 && i % perBar !== 0 && "border-l border-rule", current === i && "text-pad")}
                aria-label={`bar ${Math.floor(i / perBar) + 1} step ${(i % perBar) + 1}`}
              >
                {i % 4 === 0 ? `${Math.floor(i / perBar) + 1}.${Math.floor((i % perBar) / 4) + 1}` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(pads.length > 0 ? pads : [null]).map((pad) => (
            <tr key={pad ?? "none"} className="border-t border-rule">
              <td className="pr-2 py-0.5 whitespace-nowrap text-chalk-dim">
                {pad === null ? "—" : `${keyForPad(pad + 1)} ${bindings[pad]?.label ?? ""}`.trim()}
              </td>
              {Array.from({ length: total }, (_, i) => {
                const cell = pad === null ? undefined : byCell.get(`${pad}:${i}`);
                return (
                  <td
                    key={i}
                    className={cx("h-6 text-center align-middle", i % perBar === 0 && "border-l border-rule-strong", i % 4 === 0 && i % perBar !== 0 && "border-l border-rule", current === i && "bg-pad/10")}
                    title={cell ? cell.map((h) => `${fmtOffset(h.placement.offset_ms)} ms${h.wrapped ? " (folded)" : ""}`).join(", ") : undefined}
                  >
                    {cell ? <span className={cx("text-chalk", cell.length > 1 && "underline")}>{fmtOffset(cell[0]!.placement.offset_ms)}</span> : <span className="text-chalk-faint">·</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtOffset(ms: number): string {
  const r = Math.round(ms);
  return r > 0 ? `+${r}` : String(r);
}
