"""``revoice``: the same part in a different instrument (symbolic path; neural deferred).

params: ``{ instrument, path: "symbolic" | "neural", keep_groove?: false, notes?: [...edited notes...], bpm? }``
writes: a ``midi`` row (the editable object), the render at
``derived/{user}/{file_id}/revoice/{revoice_id}.wav`` as a ``files`` row (``kind='revoice_render'``),
a ``revoices`` row, and an ``analyze`` job for the render.
"""

from __future__ import annotations

import os
import uuid

from ..chops.midi import Grid
from ..db import Database
from ..revoice import neural
from ..revoice.symbolic import INSTRUMENTS, midi_result_from_notes, revoice
from ..storage import Storage, content_type_for
from .common import JobContext, JobError, params_of
from .derived import base_name, effective_report_of, load_file_audio, queue_analyze, write_wav_file
from .midi import grid_for


def swing_template(swing_pct: float, bpm: float, steps_per_bar: int = 16) -> dict:
    """A groove template carrying only the measured swing: off-beat 8ths move by (swing-50)% of a beat."""
    beat_ms = 60000.0 / bpm
    off = (swing_pct - 50.0) / 100.0 * beat_ms
    return {"bpm": bpm, "steps_per_bar": steps_per_bar, "swing_pct": swing_pct,
            "steps": [{"step": s, "offset_ms": off if s % 4 == 2 else 0.0, "velocity": 0.8, "count": 1}
                      for s in range(steps_per_bar)]}


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    instrument = params.get("instrument")
    path = params.get("path") or "symbolic"
    if instrument not in INSTRUMENTS:
        raise JobError(f"unknown instrument {instrument!r}; choose one of {sorted(INSTRUMENTS)}")
    if path == "neural":
        raise JobError(neural.REASON)
    if path != "symbolic":
        raise JobError("params.path must be symbolic or neural")
    if not job.get("file_id"):
        raise JobError("revoice job has no file_id")

    ctx.progress(0.05, "download")
    file, y, sr = load_file_audio(db, ctx, job["file_id"], job.get("user_id"))
    report = effective_report_of(file)
    bpm = float(params.get("bpm") or (report.tempo.bpm if report and report.tempo else 120.0))
    duration_s = y.shape[1] / sr
    grid: Grid = grid_for(report, duration_s, bpm)
    midi = midi_result_from_notes(params["notes"], bpm) if isinstance(params.get("notes"), list) else None
    keep_groove = bool(params.get("keep_groove", False))
    template = None
    if keep_groove and report is not None and report.groove is not None:
        template = swing_template(report.groove.swing_pct, bpm, grid.beats_per_bar * 4)

    ctx.progress(0.2, "transcribe" if midi is None else "render")
    try:
        res = revoice(y.mean(axis=0), sr, instrument, bpm, keep_groove=keep_groove and template is not None,
                      groove_template=template, grid=grid, midi=midi, out_sr=max(sr, 44100))
    except ImportError as exc:
        raise JobError("transcription needs Basic Pitch (pip install basic-pitch); run this job on the compute "
                       "image, or send edited notes in params.notes") from exc

    ctx.progress(0.7, "write")
    revoice_id = str(uuid.uuid4())
    midi_local = os.path.join(ctx.workdir, "revoice.mid")
    with open(midi_local, "wb") as f:
        f.write(res.midi.to_bytes())
    midi_path = f"derived/{file['user_id']}/{file['id']}/midi/revoice-{revoice_id}.mid"
    storage.upload(midi_path, midi_local, content_type_for(midi_path))
    midi_row = db.insert_rows("midi", [{"user_id": file["user_id"], "source_file_id": file["id"], "kind": "melody",
                                        "storage_path": midi_path,
                                        "notes": {"notes": res.midi.notes_json(), "meta": res.midi.meta, "bpm": bpm}}])[0]
    render_row = write_wav_file(db, storage, ctx, user_id=file["user_id"], parent=file, y=res.audio, sr=res.sr,
                                storage_path=f"derived/{file['user_id']}/{file['id']}/revoice/{revoice_id}.wav",
                                filename=f"{base_name(file)}_{instrument}.wav", kind="revoice_render")
    revoice_row = db.insert_rows("revoices", [{"id": revoice_id, "user_id": file["user_id"], "source_file_id": file["id"],
                                               "instrument": instrument, "path": "symbolic", "midi_id": midi_row["id"],
                                               "render_file_id": render_row["id"],
                                               "params": {"keep_groove": keep_groove, "renderer": res.renderer,
                                                          "notes": res.notes}}])[0]
    analyze = queue_analyze(db, ctx, file["user_id"], render_row["id"])
    return {"revoice_id": revoice_row["id"], "midi_id": midi_row["id"], "render_file_id": render_row["id"],
            "analyze_job_id": analyze["id"], "instrument": instrument, "renderer": res.renderer, "notes": res.notes,
            "note_count": len(res.midi.notes)}


__all__ = ["run", "swing_template"]
