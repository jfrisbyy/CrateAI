"use client";

// The Re-voice tab (BUILD_PACKET section 10): the same part in another
// instrument. Symbolic path: transcribe, render through a sampled
// instrument, return the MIDI as the editable object. Each result is a
// render (play, open) plus a piano roll; re-render posts the edited notes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { isActive, jobText, OpenButton, PlayButton, RetryButton, useJobDone } from "@/components/layers/shared";
import { NotesEditor } from "@/components/revoice/NotesEditor";
import { btn, btnPrimary, btnQuiet, cx, label, select } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import {
  ACCURACY_NOTE,
  DEFAULT_INSTRUMENT,
  INSTRUMENTS,
  instrumentLabel,
  isRevoiceJobFor,
  midiNotesOf,
  NEURAL_REASON,
  revoiceApi,
  revoiceKeepGroove,
  revoiceNotesOf,
  type RevoiceDetail,
} from "@/lib/api/revoice";
import { fmtDuration } from "@/lib/format";
import type { NoteJson } from "@/lib/pianoroll/model";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow } from "@/lib/types/db";
import { useSurface } from "./surfaceState";

const NOTE_KEY = "crateai:revoice-note-dismissed";

export function RevoiceTab() {
  const { file, report, jobs } = useSurface();
  const lib = useLibrary();
  const ready = file.status === "ready" && report !== null;
  const fileBpm = report?.tempo?.bpm ?? 120;

  const [items, setItems] = useState<RevoiceDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [instrument, setInstrument] = useState(DEFAULT_INSTRUMENT);
  const [keepGroove, setKeepGroove] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    try {
      setNoteDismissed(window.localStorage.getItem(NOTE_KEY) === "1");
    } catch {
      setNoteDismissed(false);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await revoiceApi.list(file.id);
      setItems(res.revoices);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [file.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isMine = useCallback((j: JobRow) => isRevoiceJobFor(j, file.id), [file.id]);
  useJobDone(lib.jobs, isMine, () => void load());

  const revoiceJobs = useMemo(() => jobs.filter((j) => j.kind === "revoice"), [jobs]);
  const active = revoiceJobs.filter(isActive);
  const latest = revoiceJobs[0];
  const failed = latest?.status === "failed" ? latest : undefined;

  const submit = async (notes?: NoteJson[], inst = instrument, kg = keepGroove) => {
    try {
      const res = await revoiceApi.create({ file_id: file.id, instrument: inst, path: "symbolic", keep_groove: kg, notes });
      lib.upsertJob(res.job);
      setActionError(res.dispatch && !res.dispatch.ok ? `Re-voice queued, but ${res.dispatch.reason}.` : null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const dismissNote = () => {
    setNoteDismissed(true);
    try {
      window.localStorage.setItem(NOTE_KEY, "1");
    } catch {
      // per-viewer convenience only
    }
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-1.5">
          <span className={label}>instrument</span>
          <select className={select} value={instrument} onChange={(e) => setInstrument(e.target.value)} aria-label="Instrument">
            {INSTRUMENTS.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </span>
        <span className="flex items-center gap-3" role="radiogroup" aria-label="Path">
          <label className="flex items-center gap-1.5 text-xs">
            <input type="radio" name="revoice-path" className="accent-[#f0a63a]" checked readOnly />
            symbolic
            <span className="text-chalk-dim">(MIDI you can fix)</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-chalk-dim" title={NEURAL_REASON}>
            <input type="radio" name="revoice-path" disabled />
            neural
            <span>(evaluated in Phase 7, not shipped)</span>
          </label>
        </span>
        <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
          <input type="checkbox" className="accent-[#f0a63a]" checked={keepGroove} onChange={(e) => setKeepGroove(e.target.checked)} />
          keep groove
          <span title="Applies the source's measured swing to the rendered notes">(measured swing)</span>
        </label>
        <button type="button" className={btnPrimary} disabled={!ready} onClick={() => void submit()} title={ready ? "Transcribe and render in the chosen instrument" : "Available once the file is analyzed"}>
          Re-voice
        </button>
        {active.map((j) => (
          <span key={j.id} className="text-xs text-chalk-dim">
            re-voice {jobText(j)}
          </span>
        ))}
        {failed && active.length === 0 && (
          <span className="text-xs flex items-center gap-2">
            re-voice {jobText(failed)} <RetryButton job={failed} onRetried={lib.upsertJob} />
          </span>
        )}
      </div>

      {!noteDismissed && (
        <p className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-start gap-2 max-w-[720px]">
          <span>{ACCURACY_NOTE}</span>
          <button type="button" className={cx(btnQuiet, "shrink-0")} onClick={dismissNote}>
            Got it
          </button>
        </p>
      )}

      {actionError && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {actionError}
          <button type="button" className={btnQuiet} onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </p>
      )}

      {items === null && !error ? (
        <p className="px-4 py-3 text-sm text-chalk-dim">Loading re-voices.</p>
      ) : error ? (
        <p className="px-4 py-3 text-sm">
          Could not load re-voices: {error}{" "}
          <button type="button" className={btnQuiet} onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : items!.length === 0 ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
          No re-voices yet. {ready ? "Pick an instrument and press Re-voice: the part comes back as MIDI you can edit, plus a render." : "Re-voice needs the file's tempo; it becomes available when analysis finishes."} Best on an isolated part (a stem or a chop).
        </p>
      ) : (
        <ul>
          {items!.map((d, i) => (
            <RevoiceRow
              key={d.revoice.id}
              detail={d}
              fileBpm={fileBpm}
              busy={active.length > 0}
              expanded={expanded === null ? i === 0 : expanded === d.revoice.id}
              onToggle={() => setExpanded(expanded === d.revoice.id || (expanded === null && i === 0) ? "" : d.revoice.id)}
              onRerender={(notes, inst, kg) => submit(notes, inst, kg)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RevoiceRow({
  detail,
  fileBpm,
  busy,
  expanded,
  onToggle,
  onRerender,
}: {
  detail: RevoiceDetail;
  fileBpm: number;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRerender: (notes: NoteJson[], instrument: string, keepGroove: boolean) => Promise<void>;
}) {
  const lib = useLibrary();
  const { revoice, midi } = detail;
  const render = detail.render ? (lib.fileById(detail.render.id) ?? detail.render) : null;
  const { notes, bpm } = midiNotesOf(midi);
  const computeNotes = revoiceNotesOf(revoice);
  const when = new Date(revoice.created_at);

  return (
    <li className="border-b border-rule">
      <div className="px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <PlayButton fileId={render?.id ?? null} disabled={!render} />
        <span className="text-sm">{instrumentLabel(revoice.instrument)}</span>
        <span className="text-chalk-dim">{revoice.path}</span>
        {render ? (
          <>
            <span className="truncate max-w-[280px]" title={render.original_filename}>
              {render.original_filename}
            </span>
            <span className="font-mono text-chalk-dim">{fmtDuration(render.duration_s)}</span>
            {render.status !== "ready" && <span className="text-chalk-dim">({render.status})</span>}
            <OpenButton fileId={render.id} />
          </>
        ) : (
          <span className="text-chalk-dim">no render</span>
        )}
        <span className="font-mono text-chalk-dim">
          {notes.length} notes{bpm ? ` at ${Math.round(bpm * 10) / 10} BPM` : ""}
        </span>
        <span className="font-mono text-chalk-dim">{when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <button type="button" className={cx(btn, "h-6 ml-auto")} onClick={onToggle} aria-expanded={expanded}>
          {expanded ? "Hide notes" : "Edit notes"}
        </button>
      </div>
      {computeNotes.length > 0 && (
        <ul className="px-4 pb-1 text-2xs text-chalk-dim">
          {computeNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {expanded &&
        (midi ? (
          <NotesEditor
            key={midi.id}
            initialNotes={notes}
            bpm={bpm ?? fileBpm}
            instrument={revoice.instrument}
            keepGroove={revoiceKeepGroove(revoice)}
            busy={busy}
            onRerender={onRerender}
          />
        ) : (
          <p className="px-4 pb-2 text-xs text-chalk-dim">This re-voice has no MIDI row to edit.</p>
        ))}
    </li>
  );
}
