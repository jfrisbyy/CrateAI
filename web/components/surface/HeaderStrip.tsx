"use client";

// The vitals, editable: BPM (type, halve, double, tap), key (primary and
// alternate, conventional spelling, hedge word when unsure), first downbeat
// (set at cursor), meter. Every edit POSTs to /api/files/[id]/edits.

import { useCallback, useEffect, useRef, useState } from "react";
import { btn, btnQuiet, cx, input, label, select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { fmtBpm, fmtClock, fmtDuration, fmtSeconds } from "@/lib/format";
import { displayKey, displayTonic, otherSpelling, PITCH_CLASSES } from "@/lib/music/keys";
import { METERS, type EditRequest } from "@/lib/report/edits";
import { hedgeWord } from "@/lib/report/hedge";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { Mode } from "@/lib/types/report";
import { fileTitle, statusText } from "@/components/library/FileRow";
import { ConfidenceDot } from "./ConfidenceDot";
import { useSurface } from "./surfaceState";

function useEdit() {
  const lib = useLibrary();
  const { file } = useSurface();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commit = useCallback(
    async (edit: EditRequest) => {
      setBusy(edit.field);
      setError(null);
      try {
        const res = await api.files.edit(file.id, edit.field, edit.value);
        lib.upsertFile(res.file);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [file.id, lib],
  );
  return { commit, busy, error, setError };
}

export function HeaderStrip() {
  const { file, jobs, report, cursor, duration } = useSurface();
  const { commit, busy, error, setError } = useEdit();
  const status = statusText(file, jobs);
  const analyzed = report !== null;

  // ---- BPM ----
  const tempo = report?.tempo ?? null;
  const [bpmEditing, setBpmEditing] = useState(false);
  const [bpmText, setBpmText] = useState("");
  const bpmInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (bpmEditing) bpmInput.current?.select();
  }, [bpmEditing]);
  const commitBpm = () => {
    const n = Number(bpmText);
    setBpmEditing(false);
    if (!Number.isFinite(n) || n <= 0) return;
    if (tempo && Math.abs(n - tempo.bpm) < 1e-6) return;
    void commit({ field: "tempo_bpm", value: Math.round(n * 100) / 100 });
  };

  // ---- tap tempo ----
  const taps = useRef<number[]>([]);
  const [tapBpm, setTapBpm] = useState<number | null>(null);
  const tap = () => {
    const now = performance.now();
    const last = taps.current[taps.current.length - 1];
    if (last !== undefined && now - last > 2000) taps.current = [];
    taps.current.push(now);
    if (taps.current.length > 12) taps.current.shift();
    if (taps.current.length >= 3) {
      const intervals = taps.current.slice(1).map((t, i) => t - (taps.current[i] as number));
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] as number;
      setTapBpm(Math.round((60000 / median) * 10) / 10);
    }
  };

  // ---- key ----
  const key = report?.key ?? null;
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyTonic, setKeyTonic] = useState<string>(key?.tonic ?? "C");
  const [keyMode, setKeyMode] = useState<Mode>(key?.mode ?? "minor");
  const openKeyEditor = () => {
    setKeyTonic(key?.tonic ?? "C");
    setKeyMode(key?.mode ?? "minor");
    setKeyEditing(true);
  };

  // ---- downbeat ----
  const beats = report?.beats ?? null;
  const firstDownbeat = beats?.downbeats_s[0] ?? null;
  const setDownbeatAt = useCallback(
    (t: number) => {
      if (!analyzed) return;
      void commit({ field: "first_downbeat_s", value: Math.max(0, Math.round(t * 1000) / 1000) });
    },
    [analyzed, commit],
  );
  useEffect(() => {
    const listener = (e: Event) => setDownbeatAt((e as CustomEvent<number>).detail);
    window.addEventListener("crateai:set-downbeat", listener);
    return () => window.removeEventListener("crateai:set-downbeat", listener);
  }, [setDownbeatAt]);

  const meter = beats?.meter ?? "4/4";

  return (
    <header className="shrink-0 border-b border-rule px-4 pt-2.5 pb-2">
      <div className="flex items-baseline justify-between gap-4 min-w-0">
        <h1 className="text-sm font-medium truncate" title={file.original_filename}>
          {fileTitle(file)}
          {file.title && <span className="ml-2 text-chalk-dim font-normal">{file.original_filename}</span>}
        </h1>
        <div className="flex items-baseline gap-4 text-xs text-chalk-dim whitespace-nowrap">
          <span>{file.kind.replace("_", " ")}</span>
          <span className="font-mono">{fmtDuration(duration)}</span>
          <span className={cx(status.failed && "text-chalk")}>{status.text}</span>
          <span className="font-mono text-chalk">{fmtClock(cursor)}</span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2">
        {/* BPM */}
        <div className="flex flex-col gap-0.5">
          <span className={label}>
            BPM
            {tempo && hedgeWord(tempo.confidence) && <span className="ml-1">({hedgeWord(tempo.confidence)})</span>}
            {tempo?.method === "user" && <span className="ml-1">edited</span>}
          </span>
          <div className="flex items-center gap-1.5">
            {bpmEditing ? (
              <input
                ref={bpmInput}
                type="number"
                step="0.1"
                min="1"
                value={bpmText}
                onChange={(e) => setBpmText(e.target.value)}
                onBlur={commitBpm}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitBpm();
                  if (e.key === "Escape") setBpmEditing(false);
                }}
                className={cx(input, "font-mono text-lg w-[92px] h-8")}
                aria-label="BPM"
              />
            ) : (
              <button
                type="button"
                disabled={!analyzed}
                onClick={() => {
                  setBpmText(tempo ? String(Math.round(tempo.bpm * 10) / 10) : "");
                  setBpmEditing(true);
                }}
                className="font-mono text-lg leading-none h-8 px-1 -mx-1 rounded-sm hover:bg-slate disabled:hover:bg-transparent flex items-center gap-2"
                title={tempo ? `alternates ${tempo.alternates_bpm.map((b) => fmtBpm(b)).join(" / ")} (${tempo.method})` : "not measured yet"}
              >
                {tempo ? fmtBpm(tempo.bpm) : <span className="text-chalk-faint">—</span>}
                {tempo && <ConfidenceDot confidence={tempo.confidence} />}
              </button>
            )}
            <button type="button" className={btn} disabled={!tempo || busy === "tempo_bpm"} onClick={() => tempo && commit({ field: "tempo_bpm", value: tempo.bpm / 2 })} title="Halve">
              ½
            </button>
            <button type="button" className={btn} disabled={!tempo || busy === "tempo_bpm"} onClick={() => tempo && commit({ field: "tempo_bpm", value: tempo.bpm * 2 })} title="Double">
              ×2
            </button>
            <button type="button" className={btn} disabled={!analyzed} onClick={tap} title="Tap the tempo (at least three taps)">
              Tap
            </button>
            {tapBpm !== null && (
              <span className="flex items-center gap-1 text-xs text-chalk-dim">
                <span className="font-mono text-chalk">{fmtBpm(tapBpm)}</span>
                <button
                  type="button"
                  className={btnQuiet}
                  onClick={() => {
                    void commit({ field: "tempo_bpm", value: tapBpm });
                    setTapBpm(null);
                    taps.current = [];
                  }}
                >
                  Set
                </button>
              </span>
            )}
          </div>
        </div>

        {/* Key */}
        <div className="flex flex-col gap-0.5">
          <span className={label}>
            Key
            {key && hedgeWord(key.confidence) && <span className="ml-1">({hedgeWord(key.confidence)})</span>}
            {key?.method === "user" && <span className="ml-1">edited</span>}
          </span>
          {keyEditing ? (
            <div className="flex items-center gap-1.5">
              <select value={keyTonic} onChange={(e) => setKeyTonic(e.target.value)} className={cx(select, "font-mono h-8")} aria-label="Tonic">
                {PITCH_CLASSES.map((pc) => (
                  <option key={pc} value={pc}>
                    {displayTonic(pc, keyMode)}
                  </option>
                ))}
              </select>
              <select value={keyMode} onChange={(e) => setKeyMode(e.target.value as Mode)} className={cx(select, "h-8")} aria-label="Mode">
                <option value="major">major</option>
                <option value="minor">minor</option>
              </select>
              <button
                type="button"
                className={btn}
                onClick={() => {
                  setKeyEditing(false);
                  void commit({ field: "key", value: { tonic: keyTonic as (typeof PITCH_CLASSES)[number], mode: keyMode } });
                }}
              >
                Set
              </button>
              <button type="button" className={btnQuiet} onClick={() => setKeyEditing(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 h-8">
              <button
                type="button"
                disabled={!analyzed}
                onClick={openKeyEditor}
                className="font-mono text-lg leading-none h-8 px-1 -mx-1 rounded-sm hover:bg-slate disabled:hover:bg-transparent flex items-center gap-2"
                title={key ? (otherSpelling(key.tonic, key.mode) ? `also written ${otherSpelling(key.tonic, key.mode)} (${key.method})` : key.method) : "not measured yet"}
              >
                {key ? displayKey(key.tonic, key.mode) : <span className="text-chalk-faint">—</span>}
                {key && <ConfidenceDot confidence={key.confidence} />}
              </button>
              {key?.alternate && (
                <button
                  type="button"
                  className={btnQuiet}
                  title={`alternate, correlation ${key.alternate.correlation.toFixed(2)}; click to use it`}
                  onClick={() => key.alternate && commit({ field: "key", value: { tonic: key.alternate.tonic as (typeof PITCH_CLASSES)[number], mode: key.alternate.mode } })}
                >
                  or <span className="font-mono">{displayKey(key.alternate.tonic, key.alternate.mode)}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* First downbeat */}
        <div className="flex flex-col gap-0.5">
          <span className={label}>
            First downbeat
            {beats && hedgeWord(beats.downbeat_confidence) && <span className="ml-1">({hedgeWord(beats.downbeat_confidence)})</span>}
            {beats?.downbeat_method === "user" && <span className="ml-1">edited</span>}
          </span>
          <div className="flex items-center gap-2 h-8">
            <span className="font-mono text-lg leading-none flex items-center gap-2" title={beats ? `phase ${beats.downbeat_phase} of ${beats.meter} (${beats.downbeat_method})` : undefined}>
              {firstDownbeat !== null ? fmtSeconds(firstDownbeat) : <span className="text-chalk-faint">—</span>}
              {beats && <ConfidenceDot confidence={beats.downbeat_confidence} />}
            </span>
            <button type="button" className={btn} disabled={!beats || busy === "first_downbeat_s"} onClick={() => setDownbeatAt(cursor)} title="D">
              Set at cursor
            </button>
          </div>
        </div>

        {/* Meter */}
        <div className="flex flex-col gap-0.5">
          <label htmlFor="meter" className={label}>
            Meter
          </label>
          <select
            id="meter"
            value={METERS.includes(meter as (typeof METERS)[number]) ? meter : "4/4"}
            disabled={!beats || busy === "meter"}
            onChange={(e) => commit({ field: "meter", value: e.target.value })}
            className={cx(select, "font-mono h-8")}
          >
            {METERS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {!analyzed && (
          <p className="text-xs text-chalk-dim self-center">
            {status.failed ? "Analysis failed; retry from the library row." : "Vitals appear when analysis finishes."}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {error}
          <button type="button" className={btnQuiet} onClick={() => setError(null)}>
            Dismiss
          </button>
        </p>
      )}
    </header>
  );
}
