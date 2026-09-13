"use client";

// Record from the microphone with a level meter (amber = live) and a hit
// counter driven by the onset counter on the analyser, so the user sees
// 1…20 while enrolling. Hands the blob up when stopped.

import { useCallback, useEffect, useRef, useState } from "react";
import { btn, cx } from "@/components/ui";
import { dbOf, OnsetCounter } from "@/lib/beatbox/onsets";
import { canRecord, describeMicError, levelOf, startRecording, type RecordingResult, type RecordingSession } from "@/lib/beatbox/recorder";
import { fmtDuration } from "@/lib/format";

export interface Recorded extends RecordingResult {
  hits: number;
}

export function Recorder({
  targetHits,
  disabled,
  onRecorded,
  label = "Record",
}: {
  targetHits?: number;
  disabled?: boolean;
  onRecorded: (recorded: Recorded) => void;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "starting" | "recording" | "stopping">("idle");
  const [level, setLevel] = useState(0);
  const [hits, setHits] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<RecordingSession | null>(null);
  const raf = useRef(0);
  const [supported, setSupported] = useState(true);

  useEffect(() => setSupported(canRecord()), []);

  const stopLoop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  useEffect(
    () => () => {
      stopLoop();
      session.current?.cancel();
      session.current = null;
    },
    [stopLoop],
  );

  const start = async () => {
    setError(null);
    setState("starting");
    try {
      const s = await startRecording();
      session.current = s;
      const counter = new OnsetCounter();
      const scratch = new Float32Array(s.analyser.fftSize);
      setHits(0);
      setElapsed(0);
      setState("recording");
      const tick = () => {
        const rms = levelOf(s.analyser, scratch);
        const db = dbOf(rms);
        const now = performance.now();
        counter.feedDb(db, now);
        setLevel(Math.max(0, Math.min(1, (db + 60) / 60)));
        setHits(counter.count);
        setElapsed((now - s.startedAt) / 1000);
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch (err) {
      setError(describeMicError(err));
      setState("idle");
    }
  };

  const stop = async () => {
    const s = session.current;
    if (!s) return;
    setState("stopping");
    stopLoop();
    try {
      const result = await s.stop();
      onRecorded({ ...result, hits });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      session.current = null;
      setLevel(0);
      setState("idle");
    }
  };

  const recording = state === "recording";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <button
        type="button"
        className={cx(btn, recording && "border-pad text-pad")}
        disabled={disabled || !supported || state === "starting" || state === "stopping"}
        onClick={() => void (recording ? stop() : start())}
        aria-pressed={recording}
      >
        {state === "starting" ? "Starting" : state === "stopping" ? "Stopping" : recording ? "Stop" : label}
      </button>
      <span className="inline-flex items-center gap-2" aria-hidden={!recording}>
        <span className="relative inline-block w-[120px] h-1 bg-rule rounded-sm overflow-hidden" title="Input level">
          <span className="absolute left-0 top-0 bottom-0 bg-pad" style={{ width: `${Math.round(level * 100)}%` }} />
        </span>
        <span className="font-mono text-chalk-dim w-[40px]">{fmtDuration(elapsed)}</span>
      </span>
      <span className="font-mono" aria-live="polite">
        hits <span className="text-chalk">{hits}</span>
        {targetHits ? <span className="text-chalk-dim"> / {targetHits}</span> : null}
      </span>
      {!supported && <span>This browser cannot record audio.</span>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
