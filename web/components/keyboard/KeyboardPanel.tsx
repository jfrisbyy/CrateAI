"use client";

// The keyboard as the instrument (PRODUCT_DIRECTION, Surface 4): the layout,
// the trigger mode, chop or note, the pads themselves, the recorder, and the
// four places the AI helps — where the cuts go, which key gets what, cleaning
// up a take, and suggesting patterns from what was played.
//
// Every control here is also a sentence (lib/pads/commands.ts). A command from
// the bus moves the same state the mouse moves and sends one line back, so the
// panel and the chat can never disagree about what happened.

import { useCallback, useEffect, useMemo, useState } from "react";
import { PadGrid } from "@/components/chops/PadGrid";
import { RecordPanel } from "@/components/chops/RecordPanel";
import type { PadsState } from "@/components/chops/usePads";
import { useSession } from "@/components/shell/SessionProvider";
import { btnQuiet, label } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import type { ChopRequest, ChopWithFile } from "@/lib/api/chops";
import { midiApi, type MidiWithUrl, type PadHitInput } from "@/lib/api/midi";
import type { PadBindings } from "@/lib/pads/bindings";
import { CLEANUP_DEFAULTS, cleanTake, type CleanedTake } from "@/lib/pads/cleanup";
import { describeKeyboardCommand, emitKeyboardResult, onKeyboardCommand, type KeyboardCommand } from "@/lib/pads/commands";
import { padCountOfKit } from "@/lib/pads/kit";
import { keyForPadIn, layoutOr, padForKeyIn } from "@/lib/pads/layouts";
import {
  classifySlices,
  orderCorrections,
  orderKit,
  slicesFromBindings,
  type KitOrdering,
  type OrderStrategy,
} from "@/lib/pads/kitOrder";
import { suggestPatterns, type PatternVariation } from "@/lib/pads/patterns";
import type { RecordingSettings, Take } from "@/lib/pads/recording";
import {
  addSlicePoint,
  moveSlicePoint,
  proposeSlicePoints,
  removeSlicePoint,
  sliceCorrections,
  suggestMaterial,
  type SliceMaterial,
  type SliceProposal,
} from "@/lib/pads/slices";
import { describeTakeLanding, regionsForTake, takeStartFor, trackForTake, type TakeSlice } from "@/lib/pads/takeToSession";
import { addTrack } from "@/lib/session/arrangement";
import type { AnalysisReport } from "@/lib/types/report";
import { KeyboardCommandLine } from "./KeyboardCommandLine";
import { KitControls } from "./KitControls";
import { KitOrderPanel } from "./KitOrderPanel";
import { SlicePanel } from "./SlicePanel";
import { TakePanel, type TakeChoice } from "./TakePanel";
import type { KitState } from "./useKit";

export function KeyboardPanel({
  fileId,
  fileName,
  report,
  bpm,
  bpmMeasured,
  beatsPerBar,
  cursor,
  chops,
  bindings,
  baseBindings,
  kitState,
  pads,
  canChop,
  onChop,
  onSavedMidi,
}: {
  fileId: string;
  fileName: string;
  report: AnalysisReport | null;
  bpm: number;
  bpmMeasured: boolean;
  beatsPerBar: number;
  cursor: number;
  chops: readonly ChopWithFile[];
  /** the pads as they are played: the file-order bindings under the kit's own order */
  bindings: PadBindings;
  /** the same material in file order; an ordering is always computed against these indices */
  baseBindings: PadBindings;
  kitState: KitState;
  pads: PadsState;
  canChop: boolean;
  onChop: (body: ChopRequest) => void;
  onSavedMidi: (row: MidiWithUrl) => void;
}) {
  const session = useSession();
  const kit = kitState.kit;
  const hasPads = bindings.some((b) => b !== null);
  const settings: RecordingSettings = useMemo(() => ({ bpm, beatsPerBar, bars: null }), [bpm, beatsPerBar]);

  // --- where the cuts go ---
  const materialGuess = useMemo(() => suggestMaterial(report, report?.file?.duration_s ?? null), [report]);
  const [proposal, setProposal] = useState<SliceProposal | null>(null);
  const [proposedBaseline, setProposedBaseline] = useState<SliceProposal | null>(null);

  // --- which key gets what ---
  const [ordering, setOrdering] = useState<KitOrdering | null>(null);
  const [orderCorrectionCount, setOrderCorrectionCount] = useState(0);

  // --- the take ---
  const [tighten, setTighten] = useState(CLEANUP_DEFAULTS.tighten);
  const [collapseFlams, setCollapseFlams] = useState(CLEANUP_DEFAULTS.collapseFlamsMs !== null);
  const [cleaned, setCleaned] = useState<CleanedTake | null>(null);
  const [variations, setVariations] = useState<PatternVariation[]>([]);
  const [chosen, setChosen] = useState<TakeChoice>("played");
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const [echo, setEcho] = useState<{ text: string; ok: boolean } | null>(null);

  // The recorder's own controls live here, so "record four bars" and the 4
  // button are the same control rather than two that agree by accident.
  const [bars, setBars] = useState<number | null>(2);
  const [click, setClick] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMidi, setSavedMidi] = useState<MidiWithUrl | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const take = pads.recording.take;

  // A new take drops whatever was worked out about the old one.
  useEffect(() => {
    setCleaned(null);
    setVariations([]);
    setChosen("played");
    setSessionNote(null);
  }, [take]);

  const spans = useMemo(() => new Map(chops.map((c) => [c.id, { startS: c.start_s, endS: c.end_s }])), [chops]);

  const propose = useCallback(
    (material: SliceMaterial | null) => {
      const next = proposeSlicePoints(report, { material: material ?? undefined, maxPoints: padCountOfKit(kit) });
      setProposal(next);
      setProposedBaseline(next);
      return next;
    },
    [report, kit],
  );

  const order = useCallback(
    (strategy: OrderStrategy) => {
      const slices = slicesFromBindings(baseBindings, spans);
      const next = orderKit(slices, strategy, { report, padCount: padCountOfKit(kit) });
      setOrdering(next);
      setOrderCorrectionCount(0);
      kitState.setOrder(next.order);
      return next;
    },
    [baseBindings, spans, report, kit, kitState],
  );

  const swap = useCallback(
    (a: number, b: number) => {
      kitState.swap(a, b);
      if (!ordering) return;
      const next = [...ordering.order];
      const tmp = next[a - 1] as number;
      next[a - 1] = next[b - 1] as number;
      next[b - 1] = tmp;
      setOrderCorrectionCount((n) => n + orderCorrections(ordering, next).length);
      setOrdering({ ...ordering, order: next });
    },
    [kitState, ordering],
  );

  const clean = useCallback(
    (amount?: number) => {
      if (!take) return null;
      const next = cleanTake(take, { ...settings, bars: take.bars }, {
        tighten: amount ?? tighten,
        collapseFlamsMs: collapseFlams ? CLEANUP_DEFAULTS.collapseFlamsMs : null,
      });
      setCleaned(next);
      setChosen("cleaned");
      return next;
    },
    [take, settings, tighten, collapseFlams],
  );

  const suggest = useCallback(() => {
    if (!take) return [];
    const source = chosen === "cleaned" && cleaned ? { bars: cleaned.bars, hits: cleaned.hits } : take;
    const next = suggestPatterns(source, { ...settings, bars: source.bars });
    setVariations(next);
    return next;
  }, [take, chosen, cleaned, settings]);

  const takeFor = useCallback(
    (choice: TakeChoice): Take | null => {
      if (!take) return null;
      if (choice === "played") return take;
      if (choice === "cleaned") return cleaned ? { bars: cleaned.bars, hits: cleaned.hits } : take;
      const variation = variations.find((v) => v.id === choice);
      return variation ? { bars: variation.bars, hits: variation.hits } : take;
    },
    [take, cleaned, variations],
  );

  const arm = useCallback(
    (length: number | null = bars) => {
      setSavedMidi(null);
      setSaveError(null);
      pads.recorder.arm({ bpm, beatsPerBar, bars: length, clickWhileRecording: click });
    },
    [pads.recorder, bpm, beatsPerBar, bars, click],
  );

  /** The played take as MIDI, at its measured times. The route takes hits, so the gate lengths stay here. */
  const saveMidi = useCallback(async (): Promise<string> => {
    const chosenTake = takeFor(chosen);
    if (!chosenTake || chosenTake.hits.length === 0) return "there is no take to save yet.";
    setSaving(true);
    setSaveError(null);
    try {
      const hits: PadHitInput[] = chosenTake.hits.map((h) => ({ time_s: h.time_s, pad: h.pad, chop_file_id: h.chop_file_id, velocity: h.velocity }));
      const res = await midiApi.savePads({ file_id: fileId, bpm, bars: chosenTake.bars, beats_per_bar: beatsPerBar, hits });
      setSavedMidi(res.midi);
      onSavedMidi(res.midi);
      return `saved as ${res.midi.filename}.`;
    } catch (err) {
      const message = errorMessage(err);
      setSaveError(message);
      return message;
    } finally {
      setSaving(false);
    }
  }, [takeFor, chosen, fileId, bpm, beatsPerBar, onSavedMidi]);

  /** The take goes on a lane of its own, on the next bar line of the session's own clock. */
  const keep = useCallback((): string => {
    const chosenTake = takeFor(chosen);
    if (!chosenTake || chosenTake.hits.length === 0) return "there is no take to keep yet.";
    // In note mode every key plays the root pad's slice, so what a pad played
    // is the instrument's answer, not the pad's own binding.
    const slices = new Map<number, TakeSlice>();
    for (let pad = 1; pad <= bindings.length; pad++) {
      const sliceFileId = pads.instrument.fileFor(pad);
      if (!sliceFileId) continue;
      const binding = bindings.find((b) => b?.file_id === sliceFileId) ?? null;
      const chop = binding?.chop_id ? chops.find((c) => c.id === binding.chop_id) : undefined;
      slices.set(pad - 1, {
        fileId: sliceFileId,
        label: binding?.label ?? "slice",
        durationS: pads.durationOf(sliceFileId),
        parentFileId: chop?.source_file_id ?? fileId,
        startS: chop?.start_s ?? 0,
        endS: chop?.end_s ?? 0,
      });
    }
    session.adoptTempo(bpm, beatsPerBar);
    const tempo = session.tempo;
    const where = takeStartFor(session.position(), tempo?.bpm ?? bpm, tempo?.beatsPerBar ?? beatsPerBar);
    const trackId = `take-${fileId}-${Date.now()}`;
    const placement = { trackId, startS: where.startS, settings: { ...settings, bars: chosenTake.bars }, slices, sourceName: fileName, sourceFileId: fileId };
    const { regions, note } = regionsForTake(chosenTake, placement);
    if (regions.length === 0) return `${note} Nothing was added to the session.`;
    const name = `${fileName} take`;
    const provenance = `${chosenTake.hits.length} hits, ${chosenTake.bars} ${chosenTake.bars === 1 ? "bar" : "bars"} at ${bpm.toFixed(1)} BPM, ${kit.trigger}, ${kit.play} mode`;
    session.edit(addTrack(session.arrangement, trackForTake(trackId, name, { fileId, provenance }), regions), `keep the ${chosen} take`);
    for (const sourceId of new Set(regions.map((r) => r.sourceId))) session.warm(sourceId);
    const line = `${describeTakeLanding(chosenTake, placement, tempo?.bpm ?? null)} ${where.note} ${note}`;
    setSessionNote(line);
    return line;
  }, [takeFor, chosen, bindings, chops, pads, fileId, fileName, session, bpm, beatsPerBar, settings, kit]);

  // --- a sentence moves the same controls ---
  const apply = useCallback(
    (command: KeyboardCommand): { text: string; ok: boolean } => {
      const said = describeKeyboardCommand(command);
      switch (command.kind) {
        case "set-trigger":
          kitState.setTrigger(command.mode);
          return { text: said, ok: true };
        case "set-play":
          kitState.setPlay(command.mode);
          return { text: said, ok: true };
        case "set-layout":
          kitState.setLayout(command.layout);
          return { text: said, ok: true };
        case "set-root": {
          const moved = kitState.setRootKey(command.key);
          return moved ? { text: said, ok: true } : { text: `${command.key.toUpperCase()} is not a key in this layout.`, ok: false };
        }
        case "play-pad": {
          const pad = padForKeyIn(layoutOr(kit.layoutId), command.key);
          if (pad === null) return { text: `${command.key.toUpperCase()} is not a key in this layout.`, ok: false };
          pads.trigger(pad);
          return { text: said, ok: true };
        }
        case "propose-cuts": {
          const next = propose(command.material);
          return { text: next.points.length === 0 ? next.notes[0] ?? "nothing to cut on." : `${next.points.length} cuts proposed: ${next.why}`, ok: next.points.length > 0 };
        }
        case "cut": {
          if (!proposal || proposal.points.length === 0) return { text: "there are no proposed cuts to take.", ok: false };
          if (!canChop) return { text: "this file cannot be chopped yet.", ok: false };
          onChop({ mode: "manual", markers_s: proposal.points.map((point) => point.timeS) });
          return { text: `${proposal.points.length} cuts sent to the chopper.`, ok: true };
        }
        case "add-cut": {
          if (!proposal) return { text: "propose some cuts first.", ok: false };
          setProposal(addSlicePoint(proposal, cursor));
          return { text: said, ok: true };
        }
        case "remove-cut": {
          const point = proposal?.points[command.index - 1];
          if (!proposal || !point) return { text: `there is no cut ${command.index}.`, ok: false };
          setProposal(removeSlicePoint(proposal, point.id));
          return { text: said, ok: true };
        }
        case "move-cut": {
          const point = proposal?.points[command.index - 1];
          if (!proposal || !point) return { text: `there is no cut ${command.index}.`, ok: false };
          setProposal(moveSlicePoint(proposal, point.id, cursor));
          return { text: said, ok: true };
        }
        case "order-kit": {
          const next = order(command.strategy);
          return { text: next.notes[0] ?? said, ok: next.method !== "none" || command.strategy === "file" };
        }
        case "swap-pads": {
          const count = padCountOfKit(kit);
          if (command.a < 1 || command.b < 1 || command.a > count || command.b > count) return { text: `this layout has ${count} pads.`, ok: false };
          swap(command.a, command.b);
          const layout = layoutOr(kit.layoutId);
          return { text: `${keyForPadIn(layout, command.a).toUpperCase()} and ${keyForPadIn(layout, command.b).toUpperCase()} swapped.`, ok: true };
        }
        case "record":
          if (!hasPads) return { text: "the pads are empty, so there is nothing to record.", ok: false };
          setBars(command.bars);
          arm(command.bars);
          return { text: said, ok: true };
        case "click":
          setClick(command.on);
          return { text: said, ok: true };
        case "save-midi": {
          if (!take) return { text: "there is no take to save yet.", ok: false };
          void saveMidi().then((line) => setEcho({ text: line, ok: !line.startsWith("there is no") }));
          return { text: said, ok: true };
        }
        case "stop-record":
          pads.recorder.stop();
          return { text: said, ok: true };
        case "clear-take":
          pads.recorder.clear();
          return { text: said, ok: true };
        case "clean-take": {
          if (!take) return { text: "there is no take to clean up yet.", ok: false };
          if (command.tighten !== null) setTighten(command.tighten);
          const next = clean(command.tighten ?? undefined);
          return { text: next ? next.changes.length === 0 ? "nothing to clean up: every hit is already on a step." : said : said, ok: true };
        }
        case "collapse-flams":
          setCollapseFlams(command.on);
          return { text: said, ok: true };
        case "use-cleaned":
          if (!cleaned) return { text: "nothing has been cleaned up yet.", ok: false };
          setChosen("cleaned");
          return { text: said, ok: true };
        case "use-played":
          setChosen("played");
          return { text: said, ok: true };
        case "suggest-patterns": {
          if (!take) return { text: "there is no take to vary yet.", ok: false };
          const next = suggest();
          return { text: next.length === 0 ? "there is not enough in that take to rearrange." : `${next.length} variations of your own take.`, ok: next.length > 0 };
        }
        case "use-pattern": {
          const variation = variations[command.index - 1];
          if (!variation) return { text: `there is no variation ${command.index}.`, ok: false };
          setChosen(variation.id);
          return { text: `${variation.name}: ${variation.derivation[0] ?? ""}`, ok: true };
        }
        case "keep-take": {
          const line = keep();
          return { text: line, ok: !line.startsWith("there is no take") };
        }
        case "all-off":
          pads.allOff();
          return { text: said, ok: true };
      }
    },
    [kitState, kit, propose, order, swap, pads, hasPads, take, clean, cleaned, suggest, variations, keep, proposal, canChop, onChop, cursor, arm, saveMidi],
  );

  useEffect(
    () =>
      onKeyboardCommand((command) => {
        const result = apply(command);
        setEcho(result);
        emitKeyboardResult(result);
      }),
    [apply],
  );

  const sliceCorrectionCount = proposal && proposedBaseline ? sliceCorrections(proposedBaseline, proposal).length : 0;
  const classes = useMemo(() => classifySlices(slicesFromBindings(baseBindings, spans), report), [baseBindings, spans, report]);
  const rootNote = report?.key?.tonic ?? null;

  return (
    <div className="flex flex-col">
      <KitControls kit={kit} kitState={kitState} latency={pads.latency} held={pads.held} hitCeiling={pads.hitCeiling} onAllOff={pads.allOff} />

      <div className="mt-2">
        <PadGrid
          bindings={bindings}
          kit={kit}
          lit={pads.lit}
          held={pads.held}
          statuses={pads.statuses}
          rootNote={rootNote}
          onPress={pads.press}
          onRelease={pads.release}
          onPickRoot={kit.play === "note" ? kitState.setRootPad : undefined}
        />
        <p className="mt-1.5 text-xs text-chalk-dim">
          {hasPads
            ? bindings.find((b) => b !== null)?.source === "chop"
              ? "Pads play the file's chops in the kit's order."
              : "No chops yet, so the pads play the stems."
            : "Pads fill with the file's chops, or its stems until there are chops."}{" "}
          {kit.play === "note" && `Every key plays ${bindings[(kit.notePad ?? kit.rootPad) - 1]?.label ?? "the root pad's slice"}, transposed.`}
        </p>
      </div>

      <RecordPanel
        bpm={bpm}
        bpmMeasured={bpmMeasured}
        beatsPerBar={beatsPerBar}
        recorder={pads.recorder}
        recording={pads.recording}
        bindings={bindings}
        hasPads={hasPads}
        bars={bars}
        onBars={setBars}
        click={click}
        onClick={setClick}
        onArm={() => arm()}
        onSave={() => void saveMidi().then((line) => setEcho({ text: line, ok: !line.startsWith("there is no") }))}
        saving={saving}
        saved={savedMidi}
        error={saveError}
      />

      <TakePanel
        take={take}
        cleaned={cleaned}
        tighten={tighten}
        collapseFlams={collapseFlams}
        variations={variations}
        chosen={chosen}
        sessionNote={sessionNote}
        canKeep={(takeFor(chosen)?.hits.length ?? 0) > 0}
        onTighten={setTighten}
        onCollapseFlams={setCollapseFlams}
        onClean={() => clean()}
        onSuggest={suggest}
        onChoose={setChosen}
        onKeep={() => setEcho({ text: keep(), ok: true })}
      />

      <SlicePanel
        proposal={proposal}
        material={proposal?.material ?? null}
        guessWhy={materialGuess.why}
        canChop={canChop}
        cursor={cursor}
        corrections={sliceCorrectionCount}
        onPropose={propose}
        onMove={(id, toS) => setProposal((p) => (p ? moveSlicePoint(p, id, toS) : p))}
        onRemove={(id) => setProposal((p) => (p ? removeSlicePoint(p, id) : p))}
        onAdd={(timeS) => setProposal((p) => (p ? addSlicePoint(p, timeS) : p))}
        onCut={(markers) => onChop({ mode: "manual", markers_s: markers })}
      />

      <KitOrderPanel kit={kit} bindings={bindings} ordering={ordering} corrections={orderCorrectionCount} onOrder={order} onSwap={swap} />

      {hasPads && (
        <p className="mt-2 text-xs text-chalk-faint">
          <span className={label}>Measured</span>{" "}
          {[...classes.values()].filter((c) => c.hitClass).length} of {bindings.filter((b) => b !== null).length} slices have a measured hit class.
          {ordering === null && (
            <>
              {" "}
              <button type="button" className={btnQuiet} onClick={() => order("hit-class")}>
                Sort by it
              </button>
            </>
          )}
        </p>
      )}

      <KeyboardCommandLine echo={echo} />
    </div>
  );
}
