"""``beatbox_transcribe``: a recorded pattern -> classified hits on a grid -> MIDI with real offsets.

params: ``{ recording_path, grid_file_id?, bpm?, min_gap_ms?: 60 }``
writes: ``derived/{user}/beatbox/{job_id}.mid`` and a ``midi`` row (``kind='beatbox'``) whose ``notes``
carry the notes, the classified hits, and the editable step view.
"""

from __future__ import annotations

import os

from ..beatbox.transcribe import step_view, transcribe
from ..chops.midi import Grid
from ..db import Database
from ..ingest import load_audio
from ..storage import Storage, content_type_for
from .common import JobContext, JobError, params_of
from .derived import effective_report_of, owner_path_ok
from .midi import grid_for


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    user = job.get("user_id")
    path = params.get("recording_path")
    if not user or not owner_path_ok(path or "", user):
        raise JobError("beatbox_transcribe needs params.recording_path under your library")
    profiles = db.select("beatbox_profiles", {"user_id": user}, limit=1)
    if not profiles:
        raise JobError("no beatbox profile yet; enroll your kick, snare and hat first")
    profile = profiles[0]
    if not profile.get("enabled"):
        raise JobError("your beatbox profile is under 85% accuracy; record more examples before transcribing")
    ctx.progress(0.1, "download")
    with open(ctx.download(profile["model_path"]), "rb") as f:
        model_bytes = f.read()
    y, sr = load_audio(ctx.download(path), mono=True)

    grid: Grid | None = None
    bpm = params.get("bpm")
    source_file_id = params.get("grid_file_id")
    if source_file_id:
        file = db.get_file(source_file_id)
        if file is None or file.get("user_id") != user:
            raise JobError("grid_file_id was not found in your library")
        report = effective_report_of(file)
        if report is None or (report.beats is None and report.tempo is None):
            raise JobError("that file has no beat grid yet; analyze it first")
        bpm = float(report.tempo.bpm) if report.tempo else float(bpm or 90.0)
        grid = grid_for(report, len(y) / sr, bpm)
    ctx.progress(0.4, "transcribe")
    hits, midi = transcribe(y, sr, model_bytes, grid=grid, bpm=float(bpm) if bpm else None,
                            min_gap_ms=float(params.get("min_gap_ms", 60.0)))
    if not hits:
        raise JobError("no hits were found in the recording")
    ctx.progress(0.8, "write")
    local = os.path.join(ctx.workdir, "beatbox.mid")
    with open(local, "wb") as f:
        f.write(midi.to_bytes())
    storage_path = f"derived/{user}/beatbox/{job['id']}.mid"
    storage.upload(storage_path, local, content_type_for(storage_path))
    notes = {"notes": midi.notes_json(), "hits": [h.to_json() for h in hits], "step_view": step_view(hits),
             "bpm": midi.meta.get("bpm"), "grid_file_id": source_file_id}
    row = db.insert_rows("midi", [{"user_id": user, "source_file_id": source_file_id, "kind": "beatbox",
                                   "storage_path": storage_path, "notes": notes}])[0]
    return {"midi_id": row["id"], "hit_count": len(hits), "storage_path": storage_path,
            "classes": sorted({h.cls for h in hits}), "bpm": midi.meta.get("bpm")}


__all__ = ["run"]
