"use client";

// The session, as React sees it.
//
// Everything hard lives in lib/session (a pure scheduler, a decode cache with a
// budget, an engine over an injected backend). This file is the thin part: it
// builds the browser backend the first time a producer asks for sound, mirrors
// the engine's snapshot into React state, and gives the panels one object to
// talk to. Nothing here decides when a sound starts.
//
// The engine is built lazily, on the first play or the first audition, because
// an AudioContext created before a gesture starts suspended and because the
// server render has no Web Audio at all.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { fetchAndDecode } from "@/lib/audio/decode";
import { DecodeCache, DEFAULT_BUDGET_BYTES, decodedBytes, type DecodedSource } from "@/lib/session/decodeCache";
import { SessionEngine, type EngineSnapshot } from "@/lib/session/engine";
import { clampGain, dbFromGain, gainFromDb } from "@/lib/session/mix";
import {
  AUDITION_TRACK_ID,
  auditionTrack,
  candidateLength,
  correctionFor,
  sourceIdOf,
  tileCandidate,
  trackFromCandidate,
  trackIdFor,
  type RackCandidate,
  type RankCorrection,
} from "@/lib/session/rack";
import { WebAudioBackend } from "@/lib/session/webAudio";
import type { SessionTempo } from "@/lib/session/time";
import type { SessionRegion, SessionTrack, TransportLoop } from "@/lib/session/types";

export interface SessionState {
  /** the engine's last snapshot; re-rendered whenever the session changes */
  tracks: SessionTrack[];
  regions: SessionRegion[];
  playing: boolean;
  loop: TransportLoop | null;
  masterGain: number;
  /** sources a lane needs and has not decoded yet */
  waiting: string[];
  /** the playhead, read on demand (an animation frame, not a re-render) */
  position: () => number;
  /** the end of the material, session seconds */
  contentEndS: number;
  /**
   * The session's own grid: bar 1 is second zero. Adopted from the first rack
   * or candidate that has a measured tempo, and never guessed — a command that
   * needs bars says so when there is none.
   */
  tempo: SessionTempo | null;
  setTempo: (tempo: SessionTempo | null) => void;
  /** take this tempo if the session has none yet; ignore it if it has one */
  adoptTempo: (bpm: number | null, beatsPerBar?: number) => void;

  play: () => void;
  pause: () => void;
  toggle: () => void;
  stop: () => void;
  seek: (sessionS: number) => void;
  setLoop: (loop: TransportLoop | null) => void;

  setMute: (trackId: string, muted: boolean) => void;
  setSolo: (trackId: string, soloed: boolean) => void;
  setGain: (trackId: string, gain: number) => void;
  nudgeGain: (trackId: string, db: number) => void;
  removeTrack: (trackId: string) => void;
  setMasterGain: (gain: number) => void;

  /** the candidate sounding on the audition lane, or null */
  auditioning: RackCandidate | null;
  /** play a candidate under the session, looped; null clears the lane */
  audition: (candidate: RackCandidate | null) => Promise<void>;
  /** commit a candidate to the session as a track of its own */
  commit: (candidate: RackCandidate) => Promise<void>;
  /** picks the ranking should learn from; nothing writes them yet */
  corrections: RankCorrection[];

  /** decode this file now (a hover, a first play) */
  warm: (fileId: string) => void;
  decodeStateOf: (fileId: string) => DecodeState;
  decodeErrorOf: (fileId: string) => string | null;
  /** decoded bytes held, and the budget */
  memory: { bytes: number; maxBytes: number; overBudget: boolean };
  error: string | null;
  clearError: () => void;
}

export type DecodeState = "idle" | "decoding" | "ready" | "error";

const EMPTY: EngineSnapshot = { tracks: [], regions: [], transport: { playing: false, anchorS: 0, anchorWall: 0, loop: null }, masterGain: 1, waiting: [] };

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside the SessionProvider");
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<SessionEngine | null>(null);
  const cacheRef = useRef<DecodeCache<AudioBuffer> | null>(null);
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(EMPTY);
  const [auditioning, setAuditioning] = useState<RackCandidate | null>(null);
  const [corrections, setCorrections] = useState<RankCorrection[]>([]);
  const [decodeErrors, setDecodeErrors] = useState<Record<string, string>>({});
  const [decodeStates, setDecodeStates] = useState<Record<string, DecodeState>>({});
  const [memory, setMemory] = useState({ bytes: 0, maxBytes: DEFAULT_BUDGET_BYTES, overBudget: false });
  const [tempo, setTempo] = useState<SessionTempo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readMemory = useCallback(() => {
    const cache = cacheRef.current;
    if (cache) setMemory({ bytes: cache.bytes, maxBytes: cache.maxBytes, overBudget: cache.overBudget });
  }, []);

  // --- the engine, built on the first sound -------------------------------
  const ensure = useCallback((): { engine: SessionEngine; cache: DecodeCache<AudioBuffer> } | null => {
    if (engineRef.current && cacheRef.current) return { engine: engineRef.current, cache: cacheRef.current };
    try {
      const cache = new DecodeCache<AudioBuffer>({
        maxBytes: DEFAULT_BUDGET_BYTES,
        load: async (fileId) => {
          const { url } = await api.files.url(fileId);
          const buffer = await fetchAndDecode(url);
          return {
            buffer,
            bytes: decodedBytes(buffer.numberOfChannels, buffer.length),
            durationS: buffer.duration,
            sampleRate: buffer.sampleRate,
            channels: buffer.numberOfChannels,
          } satisfies DecodedSource<AudioBuffer>;
        },
        onReady: (fileId) => {
          engineRef.current?.sourceReady(fileId);
          setDecodeStates((prev) => ({ ...prev, [fileId]: "ready" }));
          readMemory();
        },
        onEvict: (fileId) => {
          setDecodeStates((prev) => {
            const next = { ...prev };
            delete next[fileId];
            return next;
          });
          readMemory();
        },
      });
      const engine = new SessionEngine({ backend: new WebAudioBackend(cache) });
      engine.subscribe(setSnapshot);
      cacheRef.current = cache;
      engineRef.current = engine;
      return { engine, cache };
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [readMemory]);

  /** Begin a decode if one is not already in hand. Never called by arrival, only by asking. */
  const start = useCallback(
    (cache: DecodeCache<AudioBuffer>, fileId: string) => {
      if (cache.has(fileId) || cache.isPending(fileId)) return;
      setDecodeStates((prev) => ({ ...prev, [fileId]: "decoding" }));
      void cache
        .request(fileId)
        .then(() => readMemory())
        .catch((err: unknown) => {
          setDecodeErrors((prev) => ({ ...prev, [fileId]: errorMessage(err) }));
          setDecodeStates((prev) => ({ ...prev, [fileId]: "error" }));
        });
    },
    [readMemory],
  );

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      cacheRef.current?.clear();
      cacheRef.current = null;
    };
  }, []);

  /** Decode what the session needs and hold exactly that against eviction. */
  const sync = useCallback(
    (extra: string[] = []) => {
      const parts = ensure();
      if (!parts) return;
      const { engine, cache } = parts;
      const needed = [...new Set([...engine.sources(), ...extra])];
      cache.setPins(needed);
      readMemory();
      for (const fileId of needed) start(cache, fileId);
    },
    [ensure, start, readMemory],
  );

  const warm = useCallback(
    (fileId: string) => {
      const parts = ensure();
      if (parts) start(parts.cache, fileId);
    },
    [ensure, start],
  );

  // --- transport ----------------------------------------------------------
  const play = useCallback(() => ensure()?.engine.play(), [ensure]);
  const pause = useCallback(() => engineRef.current?.pause(), []);
  const toggle = useCallback(() => ensure()?.engine.toggle(), [ensure]);
  const stop = useCallback(() => engineRef.current?.stop(), []);
  const seek = useCallback((sessionS: number) => ensure()?.engine.seek(sessionS), [ensure]);
  const setLoop = useCallback((loop: TransportLoop | null) => ensure()?.engine.setLoop(loop), [ensure]);
  const position = useCallback(() => engineRef.current?.position() ?? 0, []);

  // --- the mix ------------------------------------------------------------
  const setMute = useCallback((trackId: string, muted: boolean) => engineRef.current?.setMute(trackId, muted), []);
  const setSolo = useCallback((trackId: string, soloed: boolean) => engineRef.current?.setSolo(trackId, soloed), []);
  const setGain = useCallback((trackId: string, gain: number) => engineRef.current?.setGain(trackId, clampGain(gain)), []);
  const nudgeGain = useCallback((trackId: string, db: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const track = engine.snapshot().tracks.find((t) => t.id === trackId);
    if (!track) return;
    engine.setGain(trackId, clampGain(gainFromDb(dbFromGain(track.gain) + db)));
  }, []);
  const setMasterGain = useCallback((gain: number) => ensure()?.engine.setMasterGain(clampGain(gain)), [ensure]);
  const removeTrack = useCallback(
    (trackId: string) => {
      engineRef.current?.removeTrack(trackId);
      if (trackId === AUDITION_TRACK_ID) setAuditioning(null);
      sync();
    },
    [sync],
  );

  // --- the rack -----------------------------------------------------------

  /** The span an audition fills: the locators if there are any, else the candidate's own length. */
  const auditionSpan = useCallback((engine: SessionEngine, candidate: RackCandidate): TransportLoop => {
    const loop = engine.loop;
    if (loop && loop.endS - loop.startS > 0.02) return loop;
    const length = Math.max(0.25, candidateLength(candidate));
    return { startS: 0, endS: length };
  }, []);

  const audition = useCallback(
    async (candidate: RackCandidate | null) => {
      const parts = ensure();
      if (!parts) return;
      const { engine } = parts;
      if (!candidate) {
        engine.removeTrack(AUDITION_TRACK_ID);
        setAuditioning(null);
        sync();
        return;
      }
      const span = auditionSpan(engine, candidate);
      if (!engine.loop) engine.setLoop(span);
      const { regions } = tileCandidate({ candidate, trackId: AUDITION_TRACK_ID, span });
      const existing = engine.snapshot().tracks.find((t) => t.id === AUDITION_TRACK_ID);
      if (existing) engine.patchTrack(AUDITION_TRACK_ID, { name: `Auditioning ${candidate.title}`, fileId: candidate.audio.fileId });
      else engine.addTrack(auditionTrack(candidate));
      // One call, and only this lane stops: the session keeps playing and the
      // new candidate joins on the bar it is already on.
      engine.setTrackRegions(AUDITION_TRACK_ID, regions);
      setAuditioning(candidate);
      setCorrections((prev) => [...prev, correctionFor(candidate, "audition")]);
      sync([sourceIdOf(candidate)]);
      if (!engine.isPlaying) engine.play();
    },
    [ensure, auditionSpan, sync],
  );

  const commit = useCallback(
    async (candidate: RackCandidate) => {
      const parts = ensure();
      if (!parts) return;
      const { engine } = parts;
      const span = auditionSpan(engine, candidate);
      if (!engine.loop) engine.setLoop(span);
      const trackId = trackIdFor(candidate);
      const { regions } = tileCandidate({ candidate, trackId, span });
      engine.addTrack(trackFromCandidate(candidate, trackId));
      engine.setTrackRegions(trackId, regions);
      if (auditioning && auditioning.id === candidate.id) {
        engine.removeTrack(AUDITION_TRACK_ID);
        setAuditioning(null);
      }
      setCorrections((prev) => [...prev, correctionFor(candidate, "commit")]);
      sync();
      if (!engine.isPlaying) engine.play();
    },
    [ensure, auditionSpan, sync, auditioning],
  );

  // --- readouts -----------------------------------------------------------
  const decodeStateOf = useCallback((fileId: string): DecodeState => decodeStates[fileId] ?? "idle", [decodeStates]);
  const decodeErrorOf = useCallback((fileId: string) => decodeErrors[fileId] ?? null, [decodeErrors]);

  const adoptTempo = useCallback((bpm: number | null, beatsPerBar = 4) => {
    if (bpm === null || !(bpm > 0)) return;
    setTempo((prev) => prev ?? { bpm, beatsPerBar });
  }, []);

  const contentEndS = useMemo(() => snapshot.regions.reduce((end, r) => Math.max(end, r.startS + r.durationS), 0), [snapshot.regions]);

  const value: SessionState = {
    tracks: snapshot.tracks,
    regions: snapshot.regions,
    playing: snapshot.transport.playing,
    loop: snapshot.transport.loop,
    masterGain: snapshot.masterGain,
    waiting: snapshot.waiting,
    position,
    contentEndS,
    tempo,
    setTempo,
    adoptTempo,
    play,
    pause,
    toggle,
    stop,
    seek,
    setLoop,
    setMute,
    setSolo,
    setGain,
    nudgeGain,
    removeTrack,
    setMasterGain,
    auditioning,
    audition,
    commit,
    corrections,
    warm,
    decodeStateOf,
    decodeErrorOf,
    memory,
    error,
    clearError: () => setError(null),
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
