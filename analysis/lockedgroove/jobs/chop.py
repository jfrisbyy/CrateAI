"""``chop``: transients, grid, or manual; each chop is a library file (``kind='chop'``).

params: ``{ mode: "transients" | "grid" | "manual", count?, min_gap_ms?, start_bar?, end_bar?,
            divisions?, markers_s?: number[], replace?: true }``
writes: WAVs at ``derived/{user}/{file_id}/chops/{index:03d}.wav``, ``files`` rows, ``chops`` rows,
and a light ``analyze`` job per chop (tempo, key, onsets, loudness, spectral).
"""

from __future__ import annotations

from ..analysis._beatgrid import bar_times
from ..chops.chop import chop_filename, chop_grid, chop_manual, chop_transients, extract
from ..db import Database
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import base_name, effective_report_of, load_file_audio, queue_analyze, write_wav_file

CHOP_STAGES = ["tempo", "key", "onsets", "loudness", "spectral"]


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    mode = params.get("mode") or "transients"
    if mode not in ("transients", "grid", "manual"):
        raise JobError("params.mode must be transients, grid, or manual")
    if not job.get("file_id"):
        raise JobError("chop job has no file_id")
    ctx.progress(0.05, "download")
    file, y, sr = load_file_audio(db, ctx, job["file_id"], job.get("user_id"))
    duration_s = y.shape[1] / sr
    report = effective_report_of(file)

    ctx.progress(0.2, "slice")
    if mode == "transients":
        onsets = report.onsets.times_s if (report and report.onsets) else None
        segs = chop_transients(y.mean(axis=0), sr, count=params.get("count"),
                               min_gap_ms=float(params.get("min_gap_ms", 40.0)), onsets_s=onsets)
    elif mode == "grid":
        if report is None or (report.beats is None and report.tempo is None):
            raise JobError("grid chops need the file's beat grid; analyze it first")
        bars = bar_times(report, duration_s)
        start_bar = int(params.get("start_bar", 0))
        end_bar = int(params.get("end_bar", min(start_bar + 3, len(bars) - 1)))
        divisions = int(params.get("divisions") or params.get("count") or 4)
        segs = chop_grid(bars, start_bar, end_bar, divisions, end_s=duration_s)
    else:
        markers = params.get("markers_s")
        if not isinstance(markers, list) or not markers:
            raise JobError("manual chops need params.markers_s")
        segs = chop_manual([float(m) for m in markers], duration_s)
    if not segs:
        raise JobError("no chops found with those settings")

    if params.get("replace", True):
        for old in db.select("chops", {"source_file_id": file["id"]}):
            if old.get("chop_file_id"):
                old_file = db.get_file(old["chop_file_id"])
                if old_file:
                    try:
                        storage.delete(old_file["storage_path"])
                    except Exception:
                        pass
                    db.delete_rows("files", {"id": old_file["id"]})
        db.delete_rows("chops", {"source_file_id": file["id"]})

    ctx.progress(0.4, "write")
    chop_ids: list[str] = []
    file_ids: list[str] = []
    base = base_name(file)
    for i, seg in enumerate(segs):
        y_seg = extract(y, sr, seg)
        storage_path = f"derived/{file['user_id']}/{file['id']}/chops/{seg.index:03d}.wav"
        row = write_wav_file(db, storage, ctx, user_id=file["user_id"], parent=file, y=y_seg, sr=sr,
                             storage_path=storage_path, filename=chop_filename(base, seg), kind="chop")
        chop = db.insert_rows("chops", [{
            "user_id": file["user_id"], "source_file_id": file["id"], "start_s": seg.start_s, "end_s": seg.end_s,
            "index": seg.index, "name": seg.name, "chop_file_id": row["id"],
        }])[0]
        queue_analyze(db, ctx, file["user_id"], row["id"], stages=CHOP_STAGES)
        chop_ids.append(chop["id"])
        file_ids.append(row["id"])
        ctx.progress(0.4 + 0.55 * (i + 1) / len(segs), "write")
    return {"file_id": file["id"], "mode": mode, "count": len(segs), "chop_ids": chop_ids, "file_ids": file_ids}


__all__ = ["CHOP_STAGES", "run"]
