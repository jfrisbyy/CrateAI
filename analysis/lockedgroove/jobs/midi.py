"""``midi``: melody (Basic Pitch), drums (measured hits with offsets), chords, groove template.

params: ``{ kind: "melody" | "drums" | "chords" | "groove", quantize?: false, bpm?, source_stem?: "other" }``
writes: ``derived/{user}/{file_id}/midi/{kind}.mid`` and a ``midi`` row whose ``notes`` carry the
editable note list (``{"notes": [...], "meta": {...}}``).
"""

from __future__ import annotations

import math
import os

import numpy as np

from ..analysis import drums as drums_stage
from ..analysis._beatgrid import beats_per_bar
from ..analysis.chords import estimate_chords
from ..chops.midi import Grid, Hit, MidiResult, chords_midi, drum_midi, groove_midi, groove_template
from ..db import Database
from ..storage import Storage, content_type_for
from .common import JobContext, JobError, params_of
from .derived import effective_report_of, load_file_audio, stem_rows


def grid_for(report, duration_s: float, bpm: float) -> Grid:
    if report is not None and report.beats is not None and len(report.beats.times_s) >= 2:
        bpb = beats_per_bar(report.beats.meter)
        times = list(report.beats.times_s)
        step = float(np.median(np.diff(times)))
        while times[-1] + step < duration_s:
            times.append(times[-1] + step)
        return Grid(beats_s=times, beats_per_bar=bpb)
    bars = max(1, int(math.ceil(duration_s * bpm / 60.0 / 4)) + 1)
    return Grid.free(bpm, bars=bars)


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    kind = params.get("kind")
    if kind not in ("melody", "drums", "chords", "groove"):
        raise JobError("params.kind must be melody, drums, chords, or groove")
    if not job.get("file_id"):
        raise JobError("midi job has no file_id")
    ctx.progress(0.05, "download")
    file, y, sr = load_file_audio(db, ctx, job["file_id"], job.get("user_id"))
    report = effective_report_of(file)
    duration_s = y.shape[1] / sr
    bpm = float(params.get("bpm") or (report.tempo.bpm if report and report.tempo else 120.0))
    grid = grid_for(report, duration_s, bpm)

    # prefer a stem when one exists for the part
    source = file
    src_y = y
    wanted_stem = params.get("source_stem") or {"drums": "drums", "groove": "drums", "melody": None, "chords": "other"}[kind]
    if wanted_stem:
        rows = stem_rows(db, file["id"])
        if wanted_stem in rows:
            source, src_y, _ = load_file_audio(db, ctx, rows[wanted_stem]["stem_file_id"])
    mono = src_y.mean(axis=0)

    ctx.progress(0.3, kind)
    if kind in ("drums", "groove"):
        events = drums_stage.detect_hits(mono, sr)
        hits = [Hit(h.time_s, h.cls, h.velocity) for h in events]
        if not hits:
            raise JobError("no drum hits found")
        if kind == "drums":
            result: MidiResult = drum_midi(hits, grid, quantize=bool(params.get("quantize", False)))
        else:
            template = groove_template(hits, grid)
            result = groove_midi(template, bars=1)
            result.meta["template"] = template
    elif kind == "melody":
        from ..revoice.symbolic import transcribe

        try:
            result = transcribe(mono, sr, bpm)
        except ImportError as exc:
            raise JobError("melody extraction needs Basic Pitch (pip install basic-pitch); run this job on the "
                           "compute image") from exc
    else:
        segments = [s.model_dump() for s in report.chords.segments] if (report and report.chords) else \
            [s.model_dump() for s in estimate_chords(mono, sr, report.beats.times_s if report and report.beats else None)]
        result = chords_midi(segments, bpm)

    ctx.progress(0.8, "write")
    local = os.path.join(ctx.workdir, f"{kind}.mid")
    with open(local, "wb") as f:
        f.write(result.to_bytes())
    storage_path = f"derived/{file['user_id']}/{file['id']}/midi/{kind}.mid"
    storage.upload(storage_path, local, content_type_for(storage_path))
    notes = {"notes": result.notes_json(), "meta": result.meta, "source_file_id": source["id"], "bpm": bpm,
             "beats_per_bar": grid.beats_per_bar}
    row = db.insert_rows("midi", [{"user_id": file["user_id"], "source_file_id": file["id"], "kind": kind,
                                   "storage_path": storage_path, "notes": notes}])[0]
    return {"midi_id": row["id"], "kind": kind, "note_count": len(result.notes), "storage_path": storage_path,
            "source_file_id": source["id"]}


__all__ = ["grid_for", "run"]
