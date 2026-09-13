"use client";

// The pad engine and recorder as React state: which pads are lit, whether
// each bound file has decoded, the recorder snapshot, and the keyboard.
//
// Keyboard: lib/keys/commands.ts owns the window keydown listener and emits
// `crateai:pad` events carrying the 1-based pad number, so pads subscribe to
// those (onPad). Those events do not say whether the keydown was a key
// repeat, so a capture-phase keydown listener here notes `e.repeat` first
// (capture runs before the shell's bubble listener) and repeats are dropped:
// holding a key plays a pad once. Velocity is always 1.0; a keyboard has none.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import { onPad } from "@/lib/keys/commands";
import type { PadBindings } from "@/lib/pads/bindings";
import { PadEngine, type BufferStatus } from "@/lib/pads/engine";
import { padForKey } from "@/lib/pads/keymap";
import { PadRecorder, type RecorderSnapshot } from "@/lib/pads/recorder";

export interface PadsState {
  engine: PadEngine;
  recorder: PadRecorder;
  lit: ReadonlySet<number>;
  statuses: Readonly<Record<string, BufferStatus | null>>;
  recording: RecorderSnapshot;
  /** tap a pad (1-based); no-op when it is empty or still decoding */
  trigger: (pad: number) => void;
  /** play any library file through the engine (chops past pad 16); decodes on first play */
  playFile: (fileId: string) => Promise<void>;
  /** true when that file was the last thing the engine started and is still sounding */
  isFilePlaying: (fileId: string) => boolean;
}

const UNBOUND_PAD = 0;

export function usePads(bindings: PadBindings): PadsState {
  const engine = useMemo(() => new PadEngine(), []);
  const recorder = useMemo(() => new PadRecorder(() => engine.context), [engine]);
  const [lit, setLit] = useState<ReadonlySet<number>>(() => new Set());
  const [statuses, setStatuses] = useState<Record<string, BufferStatus | null>>({});
  const [recording, setRecording] = useState<RecorderSnapshot>(() => recorder.snapshot());
  const playingFiles = useRef<Map<string, number>>(new Map());
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

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

  const trigger = useCallback(
    (pad: number) => {
      const binding = bindingsRef.current[pad - 1];
      if (!binding) return;
      const at = engine.trigger(pad, binding.file_id, 1);
      if (at === null) return;
      playingFiles.current.set(binding.file_id, at);
      recorder.hit(pad - 1, binding.file_id, at, 1);
    },
    [engine, recorder],
  );

  const playFile = useCallback(
    async (fileId: string) => {
      const bound = bindingsRef.current.find((b) => b?.file_id === fileId);
      if (bound) {
        trigger(bound.pad);
        return;
      }
      await load(fileId);
      const at = engine.trigger(UNBOUND_PAD, fileId, 1);
      if (at !== null) playingFiles.current.set(fileId, at);
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

  // Keyboard: the shell's pad events, with key repeats filtered out.
  useEffect(() => {
    let repeat = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (padForKey(e.key) !== null) repeat = e.repeat;
    };
    window.addEventListener("keydown", onKeyDown, true);
    const off = onPad(({ pad }) => {
      if (repeat) return;
      trigger(pad);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      off();
    };
  }, [trigger]);

  return { engine, recorder, lit, statuses, recording, trigger, playFile, isFilePlaying };
}
