"use client";

// The instrument as React state: which pads are lit, whether each bound file
// has decoded, the recorder snapshot, what is held right now, and how long the
// keyboard is taking to make a sound.
//
// The decisions all live in lib/pads (PadInstrument, PadEngine); this hook is
// wiring, and deliberately thin:
//
//   - **Key down** arrives as the shell's `crateai:pad` event, which now
//     carries `repeat` and the event's own timestamp. The layout is registered
//     with `setPadKeyResolver` while this hook is mounted, so a 24- or 32-key
//     layout claims its letters before the single-key shortcuts see them.
//   - **Key up** is this hook's own window listener (`handleKeyup`), because
//     the shell only listens for keydown. Gate mode is nothing without it.
//   - **Blur and a hidden tab** release everything. Alt-tabbing mid-hold must
//     not leave a note sounding into a tab nobody is looking at.
//
// Velocity is always 1.0; a computer keyboard has none, and pretending
// otherwise would be a measurement we did not take.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import { handleKeyup, onPad, onPadUp, setPadKeyResolver } from "@/lib/keys/commands";
import type { PadBindings } from "@/lib/pads/bindings";
import { PadEngine, type BufferStatus } from "@/lib/pads/engine";
import { PadInstrument } from "@/lib/pads/instrument";
import { defaultKit, padCountOfKit, type PadKit } from "@/lib/pads/kit";
import { layoutOr, padForKeyIn } from "@/lib/pads/layouts";
import { LatencyStats, latencySample, type LatencySummary } from "@/lib/pads/latency";
import { PadRecorder, type RecorderSnapshot } from "@/lib/pads/recorder";

export interface PadsState {
  engine: PadEngine;
  recorder: PadRecorder;
  instrument: PadInstrument;
  lit: ReadonlySet<number>;
  /** pads whose key is down right now */
  held: ReadonlySet<number>;
  /** true once as many keys were held at once as a laptop keyboard will report */
  hitCeiling: boolean;
  statuses: Readonly<Record<string, BufferStatus | null>>;
  recording: RecorderSnapshot;
  latency: LatencySummary;
  /** press a pad (1-based): a key down, or a pointer down on the grid */
  press: (pad: number, options?: { repeat?: boolean }) => void;
  /** release a pad: the key came up, or the pointer did */
  release: (pad: number) => void;
  /** tap: press and release together, for anything that has no up event */
  trigger: (pad: number) => void;
  /** release everything sounding, whatever mode it is in */
  allOff: () => void;
  /** play any library file through the engine (chops past the last pad); decodes on first play */
  playFile: (fileId: string) => Promise<void>;
  /** true when that file was the last thing the engine started and is still sounding */
  isFilePlaying: (fileId: string) => boolean;
  /** the decoded length of a bound file, when it has decoded */
  durationOf: (fileId: string) => number | null;
}

const UNBOUND_PAD = 0;
/**
 * A tap has no length of its own — a click, a sentence, the chop list's play
 * button — so in gate mode it is given a short one. Without this, "play Q" in
 * gate mode would press and release in the same millisecond and be silent.
 */
const TAP_HOLD_MS = 300;

export function usePads(bindings: PadBindings, kit: PadKit = defaultKit()): PadsState {
  const engine = useMemo(() => new PadEngine(), []);
  const recorder = useMemo(() => new PadRecorder(() => engine.context), [engine]);
  const [lit, setLit] = useState<ReadonlySet<number>>(() => new Set());
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  const [hitCeiling, setHitCeiling] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, BufferStatus | null>>({});
  const [recording, setRecording] = useState<RecorderSnapshot>(() => recorder.snapshot());
  const [latency, setLatency] = useState<LatencySummary>({ count: 0, medianMs: null, p95Ms: null, worstMs: null });
  const playingFiles = useRef<Map<string, number>>(new Map());
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const kitRef = useRef(kit);
  kitRef.current = kit;
  const stats = useMemo(() => new LatencyStats(), []);

  const instrument = useMemo(
    () =>
      new PadInstrument({
        engine,
        kit: () => kitRef.current,
        fileForPad: (pad) => bindingsRef.current[pad - 1]?.file_id ?? null,
        now: () => engine.now(),
        onHit: (hit) => {
          playingFiles.current.set(hit.fileId, hit.at);
          recorder.hit(hit.pad - 1, hit.fileId, hit.at, hit.velocity, { semitones: hit.semitones });
        },
        // Only a gate release is a note length; a one-shot plays out whatever
        // the key does, and recording a hold time there would make every
        // region as long as the producer's finger.
        onRelease: (release) => {
          if (release.gate) recorder.release(release.pad - 1, release.at);
        },
      }),
    [engine, recorder],
  );

  const syncHeld = useCallback(() => {
    setHeld(new Set(instrument.heldPads()));
    setHitCeiling(instrument.atPolyphonyCeiling() || instrument.peakHeld >= 3);
  }, [instrument]);

  useEffect(() => {
    const refresh = () => {
      setLit(new Set(engine.litPads()));
      const next: Record<string, BufferStatus | null> = {};
      for (const b of bindingsRef.current) if (b) next[b.file_id] = engine.status(b.file_id);
      setStatuses(next);
    };
    const offEngine = engine.onChange(refresh);
    const offRecorder = recorder.onChange(() => setRecording(recorder.snapshot()));
    return () => {
      offEngine();
      offRecorder();
    };
  }, [engine, recorder]);

  useEffect(
    () => () => {
      recorder.dispose();
      engine.dispose();
    },
    [engine, recorder],
  );

  const load = useCallback((fileId: string) => engine.load(fileId, () => api.files.url(fileId).then((r) => r.url)), [engine]);

  // Decode every bound file once the bindings are known.
  useEffect(() => {
    for (const b of bindings) if (b && engine.status(b.file_id) === null) void load(b.file_id).catch(() => undefined);
    const next: Record<string, BufferStatus | null> = {};
    for (const b of bindings) if (b) next[b.file_id] = engine.status(b.file_id);
    setStatuses(next);
  }, [bindings, engine, load]);

  const press = useCallback(
    (pad: number, options: { repeat?: boolean; atMs?: number } = {}) => {
      const result = instrument.press(pad, { repeat: options.repeat });
      syncHeld();
      if (result !== "started") return;
      if (options.atMs !== undefined) {
        stats.add(latencySample({ eventTimeStampMs: options.atMs, handledAtMs: performance.now(), scheduleAheadS: 0, outputLatencyS: engine.outputLatencyS() }));
        setLatency(stats.summary());
      }
    },
    [engine, instrument, stats, syncHeld],
  );

  const release = useCallback(
    (pad: number) => {
      instrument.release(pad);
      syncHeld();
    },
    [instrument, syncHeld],
  );

  const taps = useRef<Set<number>>(new Set());
  const trigger = useCallback(
    (pad: number) => {
      press(pad);
      if (kitRef.current.trigger !== "gate") {
        release(pad);
        return;
      }
      const timer = window.setTimeout(() => {
        taps.current.delete(timer);
        release(pad);
      }, TAP_HOLD_MS);
      taps.current.add(timer);
    },
    [press, release],
  );

  useEffect(() => {
    const timers = taps.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const allOff = useCallback(() => {
    instrument.releaseAll({ engineToo: true });
    syncHeld();
  }, [instrument, syncHeld]);

  const playFile = useCallback(
    async (fileId: string) => {
      const bound = bindingsRef.current.find((b) => b?.file_id === fileId);
      if (bound) {
        trigger(bound.pad);
        return;
      }
      await load(fileId);
      const voice = engine.noteOn(UNBOUND_PAD, fileId, { trigger: "one-shot" });
      if (voice) playingFiles.current.set(fileId, voice.at);
    },
    [engine, load, trigger],
  );

  const isFilePlaying = useCallback(
    (fileId: string) => {
      const bound = bindingsRef.current.find((b) => b?.file_id === fileId);
      return bound ? lit.has(bound.pad) : lit.has(UNBOUND_PAD) && playingFiles.current.has(fileId);
    },
    [lit],
  );

  // The keyboard. The layout is registered so the shell's keydown listener
  // sends every key this layout claims here, ahead of the letter shortcuts.
  useEffect(() => {
    const layout = layoutOr(kitRef.current.layoutId);
    const unregister = setPadKeyResolver((key) => padForKeyIn(layout, key));
    const offPad = onPad(({ pad, repeat, atMs }) => press(pad, { repeat, atMs }));
    const offPadUp = onPadUp(({ pad }) => release(pad));
    const onKeyUp = (e: KeyboardEvent) => {
      handleKeyup(e);
    };
    const releaseEverything = () => {
      instrument.releaseAll();
      syncHeld();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseEverything();
    };
    // Clicking into a text box does not blur the window, so a key held at that
    // moment would never get its key-up (the typing guard swallows it). Release
    // on the way in instead.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) releaseEverything();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseEverything);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      unregister();
      offPad();
      offPadUp();
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseEverything);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusin", onFocusIn);
      releaseEverything();
    };
  }, [instrument, press, release, syncHeld, kit.layoutId]);

  // A layout or mode change while a key is down would otherwise hang that note.
  const padCount = padCountOfKit(kit);
  useEffect(() => {
    instrument.releaseAll();
    syncHeld();
  }, [instrument, syncHeld, kit.layoutId, kit.play, kit.trigger, padCount]);

  const durationOf = useCallback((fileId: string) => engine.durationOf(fileId), [engine]);

  return { engine, recorder, instrument, lit, held, hitCeiling, statuses, recording, latency, press, release, trigger, allOff, playFile, isFilePlaying, durationOf };
}
