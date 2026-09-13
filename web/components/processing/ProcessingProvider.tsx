"use client";

// Corrective processing, as React sees it.
//
// Everything hard is in lib/processing: the filter arithmetic, the plan the
// graph is driven from, the complaint vocabulary and the model seam. This file
// is the thin part — it holds the state, pushes it at whichever audio graph is
// current, and carries the chat's sentences to the same controls the mouse
// moves.
//
// Two shapes worth knowing:
//
//   It does not go through the engine. A filter changes nothing about when a
//   piece starts, so the scheduler has no reason to know about one; the
//   backend registers itself as a processing host (lib/processing/host.ts) and
//   the state is pushed at it. That is why nothing in lib/session/engine.ts
//   changed for any of this.
//
//   The sentence and the pointer are one path. `apply` below runs the same
//   pure functions the panel's controls run, and emits one line back in the
//   same words, so the chat and the dock can never disagree about what the
//   chain is.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSession } from "@/components/shell/SessionProvider";
import { emitCommandResult, onSessionCommand } from "@/components/shell/sessionCommands";
import { useLibrary } from "@/lib/state/LibraryProvider";
import {
  activeBands,
  bandOf,
  defaultState,
  describeProcessing,
  editTrack,
  processingFor,
  pruneProcessing,
  removeProcessing as removeProcessingFrom,
  resetProcessing,
  setBand,
  setBypass,
  setLimiter,
  setMaster,
  setMasterBypass,
  setTrim,
  setTune,
} from "@/lib/processing/chain";
import { COMPLAINT_WORDS, proposeForComplaint, proposeForPhrase } from "@/lib/processing/complaints";
import { onProcessingHost, processingHost } from "@/lib/processing/host";
import { applyProposal, summarise, type AppliedProposal, type ProcessingProposal } from "@/lib/processing/moves";
import type { BandId, EqBand, MasterProcessing, ProcessingState, TrackProcessing } from "@/lib/processing/types";
import { ALL_TRACKS, resolveTarget, SELECTION, type SessionCommand } from "@/lib/session/commands";
import type { ProposalNote } from "./ProcessingPanel";

export interface ProcessingContext {
  state: ProcessingState;
  /** the lane the dock is on, and the one a sentence with no lane named means */
  focusTrackId: string | null;
  focus: (trackId: string | null) => void;
  processing: TrackProcessing;
  sampleRate: number;
  /** is the dock showing */
  open: boolean;
  setOpen: (open: boolean) => void;

  selectedBand: BandId | null;
  selectBand: (id: BandId) => void;

  setBandOn: (trackId: string, id: BandId, patch: Partial<Pick<EqBand, "frequency" | "gainDb" | "q" | "enabled">>) => void;
  toggleBandOn: (trackId: string, id: BandId) => void;
  setTrimOn: (trackId: string, db: number) => void;
  setTuneOn: (trackId: string, cents: number) => void;
  setBypassOn: (trackId: string, bypassed: boolean) => void;
  resetOn: (trackId: string) => void;
  removeFrom: (trackId: string) => void;

  master: MasterProcessing;
  setLimiterSettings: (patch: { enabled?: boolean; ceilingDb?: number; releaseMs?: number }) => void;
  setMasterBypassed: (bypassed: boolean) => void;
  /** how much the limiter is holding back right now, dB; read off the node, never estimated */
  reductionDb: number;

  /**
   * A complaint in the producer's words. The curve is decided in lib/processing
   * and comes back through the same `setBand` a drag runs; the line returned is
   * what the chat echoes, so the dock and the chat always say the same thing.
   */
  fix: (trackId: string, complaint: string) => { ok: boolean; line: string };
  /**
   * True while an answer is being waited for. The vocabulary in complaints.ts
   * answers straight away, so this is only ever true once the model seam in
   * lib/processing/propose.ts has a route behind it (outside this seam).
   */
  busy: boolean;
  proposal: ProposalNote | null;
  undoProposal: () => void;
  note: string | null;
}

const Context = createContext<ProcessingContext | null>(null);

export function useProcessing(): ProcessingContext {
  const ctx = useContext(Context);
  if (!ctx) throw new Error("useProcessing must be used inside the ProcessingProvider");
  return ctx;
}

const DEFAULT_SAMPLE_RATE = 48000;

export function ProcessingProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const library = useLibrary();
  const [state, setState] = useState<ProcessingState>(defaultState);
  const [focusTrackId, setFocusTrackId] = useState<string | null>(null);
  const [selectedBand, selectBand] = useState<BandId | null>(null);
  const [sampleRate, setSampleRate] = useState(DEFAULT_SAMPLE_RATE);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalNote | null>(null);
  const [reductionDb, setReductionDb] = useState(0);
  const undoRef = useRef<{ trackId: string; processing: TrackProcessing } | null>(null);

  const tracks = session.tracks;
  const regions = session.regions;

  // --- the bridge to the audio graph ---------------------------------------
  // The backend is built lazily, on the first sound, so the state is pushed
  // whenever either side changes: a producer can set up a curve before
  // anything has ever played and it has to be there when the graph appears.
  const stateRef = useRef(state);
  stateRef.current = state;

  const push = useCallback((host: ReturnType<typeof processingHost>, current: ProcessingState) => {
    if (!host) return;
    setSampleRate(host.sampleRate());
    for (const [trackId, processing] of Object.entries(current.tracks)) host.setTrackProcessing(trackId, processing);
    host.setMasterProcessing(current.master);
  }, []);

  useEffect(() => onProcessingHost((host) => push(host, stateRef.current)), [push]);

  useEffect(() => {
    push(processingHost(), state);
  }, [state, push]);

  // A lane that has left the session takes its chain with it.
  useEffect(() => {
    const ids = tracks.map((t) => t.id);
    setState((prev) => pruneProcessing(prev, ids));
  }, [tracks]);

  // The dock follows the session: the first lane, or the lane of the region
  // the producer has selected on the timeline.
  const selectedRegionId = session.selectedRegionId;
  useEffect(() => {
    setFocusTrackId((prev) => {
      if (prev && tracks.some((t) => t.id === prev)) return prev;
      const fromSelection = selectedRegionId ? (regions.find((r) => r.id === selectedRegionId)?.trackId ?? null) : null;
      return fromSelection ?? tracks[0]?.id ?? null;
    });
  }, [tracks, regions, selectedRegionId]);

  // The limiter's own readout, at a readable rate and only while it is on.
  const limiterOn = state.master.limiter.enabled && !state.master.bypassed;
  useEffect(() => {
    if (!limiterOn) {
      setReductionDb(0);
      return;
    }
    const handle = window.setInterval(() => setReductionDb(processingHost()?.limiterReduction() ?? 0), 250);
    return () => window.clearInterval(handle);
  }, [limiterOn]);

  // --- edits ----------------------------------------------------------------

  const edit = useCallback((trackId: string, change: (processing: TrackProcessing) => TrackProcessing) => {
    setState((prev) => editTrack(prev, trackId, change));
  }, []);

  const setBandOn = useCallback<ProcessingContext["setBandOn"]>((trackId, id, patch) => edit(trackId, (p) => setBand(p, id, patch)), [edit]);
  const toggleBandOn = useCallback<ProcessingContext["toggleBandOn"]>(
    (trackId, id) => edit(trackId, (p) => setBand(p, id, { enabled: !bandOf(p, id).enabled })),
    [edit],
  );
  const setTrimOn = useCallback<ProcessingContext["setTrimOn"]>((trackId, db) => edit(trackId, (p) => setTrim(p, db)), [edit]);
  const setTuneOn = useCallback<ProcessingContext["setTuneOn"]>((trackId, cents) => edit(trackId, (p) => setTune(p, cents)), [edit]);
  const setBypassOn = useCallback<ProcessingContext["setBypassOn"]>((trackId, bypassed) => edit(trackId, (p) => setBypass(p, bypassed)), [edit]);
  const resetOn = useCallback<ProcessingContext["resetOn"]>(
    (trackId) => {
      setProposal(null);
      edit(trackId, () => resetProcessing());
    },
    [edit],
  );
  const removeFrom = useCallback<ProcessingContext["removeFrom"]>((trackId) => {
    setProposal(null);
    setState((prev) => removeProcessingFrom(prev, trackId));
    // Nothing is left behind on the graph: a lane with no chain is told so.
    processingHost()?.setTrackProcessing(trackId, null);
  }, []);

  const setLimiterSettings = useCallback<ProcessingContext["setLimiterSettings"]>((patch) => {
    setState((prev) => setMaster(prev, setLimiter(prev.master, patch)));
  }, []);
  const setMasterBypassed = useCallback<ProcessingContext["setMasterBypassed"]>((bypassed) => {
    setState((prev) => setMaster(prev, setMasterBypass(prev.master, bypassed)));
  }, []);

  // --- the complaint --------------------------------------------------------

  /**
   * Where this lane's audio actually stops, as measured. The lane's own file
   * first (a stem has its own report and a separator can only ever have taken
   * air away), then the record it was cut out of. Null when nothing measured
   * it — and null means nothing is assumed, not that there is air up there.
   */
  const ceilingFor = useCallback(
    (trackId: string): number | null => {
      const region = regions.find((r) => r.trackId === trackId);
      const candidates = [region?.lineage?.fileId, region?.lineage?.parentFileId, tracks.find((t) => t.id === trackId)?.fileId];
      for (const fileId of candidates) {
        if (!fileId) continue;
        const measured = library.fileById(fileId)?.report?.spectral?.bandwidth?.value;
        if (typeof measured === "number" && measured > 0) return measured;
      }
      return null;
    },
    [regions, tracks, library],
  );

  const recordProposal = useCallback((trackId: string, before: TrackProcessing, proposed: ProcessingProposal, out: AppliedProposal) => {
    undoRef.current = { trackId, processing: before };
    const why: Partial<Record<BandId, string>> = {};
    const bands: BandId[] = [];
    for (const move of proposed.moves) {
      if (move.op !== "band") continue;
      why[move.band] = move.why;
      bands.push(move.band);
    }
    setProposal({ summary: proposed.summary, confidence: proposed.confidence, lines: out.applied.map((a) => a.line), notes: out.notes, bands, why });
    setNote(summarise(proposed, out.processing));
  }, []);

  /**
   * A complaint, answered. The decision is made against the chain as it reads
   * now (`stateRef`) rather than inside a state updater, so nothing here
   * happens twice: the note, the undo point and the proposal banner are all
   * written once, outside the reducer.
   */
  const fix = useCallback<ProcessingContext["fix"]>(
    (trackId, complaint) => {
      const sourceCeilingHz = ceilingFor(trackId);
      const proposed = proposeForComplaint(complaint, { sourceCeilingHz });
      if (!proposed) {
        setProposal(null);
        const line = `I don't know what that means as a curve. Say which of these it is — ${COMPLAINT_WORDS} — or ask it as a question and it goes to the model.`;
        setNote(line);
        return { ok: false, line };
      }
      const before = processingFor(stateRef.current, trackId);
      const out = applyProposal(before, proposed, { sourceCeilingHz });
      if (out.empty) {
        const line = "that is already what the chain is doing.";
        setNote(line);
        return { ok: false, line };
      }
      recordProposal(trackId, before, proposed, out);
      // A chain nobody can hear is not an answer: a fix engages it.
      setState((prev) => editTrack(prev, trackId, () => setBypass(out.processing, false)));
      setFocusTrackId(trackId);
      setOpen(true);
      const moved = proposed.moves.find((move) => move.op === "band");
      if (moved && moved.op === "band") selectBand(moved.band);
      return { ok: true, line: summarise(proposed, out.processing) };
    },
    [ceilingFor, recordProposal],
  );

  const undoProposal = useCallback(() => {
    const last = undoRef.current;
    if (!last) return;
    undoRef.current = null;
    setProposal(null);
    setNote("put back where it was");
    setState((prev) => editTrack(prev, last.trackId, () => last.processing));
  }, []);

  // --- the chat's command line ----------------------------------------------

  const focusRef = useRef<string | null>(focusTrackId);
  focusRef.current = focusTrackId;

  const apply = useCallback(
    (command: SessionCommand) => {
      const say = (text: string, ok = true) => emitCommandResult({ text, ok });
      const lanesFor = (target: string): string[] | null => {
        if (target === SELECTION) return focusRef.current ? [focusRef.current] : null;
        if (target === ALL_TRACKS) return tracks.map((t) => t.id);
        return resolveTarget(target, tracks);
      };
      const named = (target: string) => (target === SELECTION ? "the lane you are on" : target === ALL_TRACKS ? "everything" : target);
      const nameOf = (id: string) => tracks.find((t) => t.id === id)?.name ?? "that lane";

      switch (command.kind) {
        case "processing": {
          const ids = lanesFor(command.target);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${named(command.target)}.`, false);
          setFocusTrackId(ids[0] ?? null);
          setOpen(true);
          return say(`the chain on ${nameOf(ids[0] ?? "")}: ${describeProcessing(processingFor(stateRef.current, ids[0] ?? ""))}`);
        }
        case "processing-bypass": {
          const ids = lanesFor(command.target);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${named(command.target)}.`, false);
          const first = ids[0] as string;
          const current = processingFor(stateRef.current, first);
          const bypassed = command.on === null ? !current.bypassed : command.on;
          for (const id of ids) setBypassOn(id, bypassed);
          setOpen(true);
          return say(`${bypassed ? "bypassed" : "engaged"} the chain on ${nameOf(first)}${activeBands(current).length === 0 ? " (there is nothing on it yet)" : ""}`);
        }
        case "processing-reset": {
          const ids = lanesFor(command.target);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${named(command.target)}.`, false);
          for (const id of ids) resetOn(id);
          return say(`cleared the chain on ${nameOf(ids[0] ?? "")}`);
        }
        case "fix": {
          const ids = lanesFor(command.target);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${named(command.target)}.`, false);
          const trackId = ids[0] as string;
          const outcome = fix(trackId, command.complaint);
          return say(outcome.ok ? `${nameOf(trackId)}: ${outcome.line}` : outcome.line, outcome.ok);
        }
        case "eq": {
          const ids = lanesFor(command.target);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${named(command.target)}.`, false);
          const trackId = ids[0] as string;
          const sourceCeilingHz = ceilingFor(trackId);
          const proposed = proposeForPhrase(command.phrase);
          const out = applyProposal(processingFor(stateRef.current, trackId), proposed, { sourceCeilingHz });
          if (out.empty) return say("that is already what the chain is doing.", false);
          setState((prev) => editTrack(prev, trackId, () => setBypass(out.processing, false)));
          setFocusTrackId(trackId);
          setOpen(true);
          const moved = proposed.moves[0];
          if (moved && moved.op === "band") selectBand(moved.band);
          return say(`${nameOf(trackId)}: ${out.applied.map((a) => a.line).join(", ")}${out.notes.length > 0 ? ` — ${out.notes[0]}` : ""}`);
        }
        case "tune": {
          const ids = lanesFor(command.target);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${named(command.target)}.`, false);
          for (const id of ids) setTuneOn(id, processingFor(stateRef.current, id).tuneCents + command.cents);
          setOpen(true);
          return say(`tuned ${nameOf(ids[0] ?? "")} ${command.cents > 0 ? "up" : "down"} ${Math.abs(Math.round(command.cents))} cents — this resamples, so time moves with it`);
        }
        case "limiter": {
          setLimiterSettings({ enabled: command.on });
          if (command.on) setMasterBypassed(false);
          setOpen(true);
          return say(command.on ? "limiter on the master, holding peaks back gently" : "limiter off");
        }
        default:
          return;
      }
    },
    [tracks, ceilingFor, fix, resetOn, setBypassOn, setTuneOn, setLimiterSettings, setMasterBypassed],
  );

  useEffect(() => onSessionCommand(apply), [apply]);

  const processing = useMemo(() => processingFor(state, focusTrackId ?? ""), [state, focusTrackId]);

  const value: ProcessingContext = {
    state,
    focusTrackId,
    focus: setFocusTrackId,
    processing,
    sampleRate,
    open,
    setOpen,
    selectedBand,
    selectBand,
    setBandOn,
    toggleBandOn,
    setTrimOn,
    setTuneOn,
    setBypassOn,
    resetOn,
    removeFrom,
    master: state.master,
    setLimiterSettings,
    setMasterBypassed,
    reductionDb,
    fix,
    busy: false,
    proposal,
    undoProposal,
    note,
  };

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
