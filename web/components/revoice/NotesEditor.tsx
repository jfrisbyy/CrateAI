"use client";

// The editable MIDI of one re-voice: the roll, the selected note's readouts
// (pitch, position in bars.beats.16ths, length, velocity), snap, and
// "Re-render with these notes", which posts a new revoice whose params.notes
// are the edited notes so the compute renders without re-transcribing.

import { useMemo, useState } from "react";
import { NumberField } from "@/components/layers/fields";
import { btn, btnPrimary, btnQuiet, cx, label, segment, segmentItem, select } from "@/components/ui";
import { INSTRUMENTS } from "@/lib/api/revoice";
import { deleteNotes, fromNotesJson, noteName, setVelocity, toNotesJson, type EditOptions, type NoteJson, type RollNote } from "@/lib/pianoroll/model";
import { formatBarsBeats } from "@/lib/pianoroll/time";
import { PianoRoll } from "./PianoRoll";

export function NotesEditor({
  initialNotes,
  bpm,
  instrument: initialInstrument,
  keepGroove: initialKeepGroove,
  busy,
  onRerender,
}: {
  initialNotes: unknown[];
  bpm: number;
  instrument: string;
  keepGroove: boolean;
  busy: boolean;
  onRerender: (notes: NoteJson[], instrument: string, keepGroove: boolean) => Promise<void>;
}) {
  const initial = useMemo(() => fromNotesJson(initialNotes), [initialNotes]);
  const [notes, setNotes] = useState<RollNote[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snap, setSnap] = useState(true);
  const [instrument, setInstrument] = useState(initialInstrument);
  const [keepGroove, setKeepGroove] = useState(initialKeepGroove);
  const opts: EditOptions = { bpm, snap };
  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const dirty = useMemo(() => JSON.stringify(toNotesJson(notes)) !== JSON.stringify(toNotesJson(initial)), [notes, initial]);

  const remove = () => {
    if (!selectedId) return;
    setNotes((prev) => deleteNotes(prev, [selectedId]));
    setSelectedId(null);
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5">
          <span className={label}>snap</span>
          <div className={segment} role="group" aria-label="Note snap">
            <button type="button" className={cx(segmentItem, "h-6")} data-active={snap} onClick={() => setSnap(true)}>
              16th
            </button>
            <button type="button" className={cx(segmentItem, "h-6")} data-active={!snap} onClick={() => setSnap(false)}>
              Free
            </button>
          </div>
        </span>
        <span className="font-mono text-chalk-dim">
          <span className="text-chalk">{notes.length}</span> notes at <span className="text-chalk">{Math.round(bpm * 10) / 10}</span> BPM
        </span>
        {selected ? (
          <span className="flex items-center gap-2 font-mono">
            <span className="text-chalk">{noteName(selected.pitch)}</span>
            <span title="Position in bars.beats.16ths">{formatBarsBeats(selected.start_s, bpm)}</span>
            <span title="Length in bars.beats.16ths">len {formatBarsBeats(selected.end_s - selected.start_s, bpm)}</span>
            <span className="flex items-center gap-1">
              <span className={label}>vel</span>
              <NumberField value={selected.velocity} min={1} max={127} step={1} digits={0} ariaLabel="Velocity of the selected note" widthClass="w-[48px]" onCommit={(v) => setNotes((prev) => setVelocity(prev, selected.id, v ?? 100))} />
            </span>
            <button type="button" className={btnQuiet} onClick={remove} title="Delete">
              Delete
            </button>
          </span>
        ) : (
          <span className="text-chalk-dim">Click a note to select it; click empty space to add one.</span>
        )}
        {dirty && (
          <button type="button" className={btnQuiet} onClick={() => (setNotes(initial), setSelectedId(null))}>
            Revert
          </button>
        )}
      </div>
      <PianoRoll notes={notes} onChange={setNotes} selectedId={selectedId} onSelect={setSelectedId} opts={opts} onDeleteSelected={remove} />
      <div className="px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <select className={cx(select, "h-6 text-xs")} value={instrument} onChange={(e) => setInstrument(e.target.value)} aria-label="Instrument for the re-render">
          {INSTRUMENTS.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-chalk-dim">
          <input type="checkbox" className="accent-[#f0a63a]" checked={keepGroove} onChange={(e) => setKeepGroove(e.target.checked)} />
          keep the source groove
        </label>
        <button type="button" className={dirty ? btnPrimary : btn} disabled={busy || notes.length === 0} onClick={() => void onRerender(toNotesJson(notes), instrument, keepGroove)} title="A new render from these notes, without re-transcribing">
          Re-render with these notes
        </button>
        <span className="text-chalk-dim">Drag to move, right edge for length, arrows nudge (Shift: octave / bar), Delete removes.</span>
      </div>
    </div>
  );
}
