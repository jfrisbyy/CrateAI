"""``render_loop``: render one ``loops`` row to a 24-bit WAV library entry.

params: ``{ loop_id, crossfade_ms?: 12, snap_zero_crossing?: true }``

writes: the WAV at ``derived/{user_id}/{file_id}/loops/{loop_id}.wav``, a
``files`` row (``kind='loop_render'``, ``parent_file_id`` = the source,
``status='queued'``), ``loops.render_file_id``, and an ``analyze`` job for the
render so the library entry gets its own report (principle 5). The new job's
id is returned in ``result.analyze_job_id`` and in ``result.queued_job_ids``
for the host to dispatch.

The DSP lives in ``lockedgroove.loops.render`` (Phase 1):
``render_loop(y_stereo, sr, start_s, end_s, crossfade_ms, snap_zero_crossing)
-> (y_out, meta)`` and ``export_wav(path, y, sr, bit_depth=24)``.
"""

from __future__ import annotations

import importlib
import logging
import os
import re
from typing import Any

import numpy as np

from .. import ANALYSIS_VERSION
from ..db import Database, jsonable
from ..ingest import load_audio, sha256_file
from ..report import AnalysisReport, effective
from ..storage import Storage, content_type_for
from .common import JobContext, JobError, params_of

log = logging.getLogger(__name__)

DEFAULT_CROSSFADE_MS = 12.0
DEFAULT_SNAP_ZERO_CROSSING = True


def _import_render():
    try:
        render = importlib.import_module("lockedgroove.loops.render")  # Phase 1
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.startswith("lockedgroove.loops"):
            raise JobError("the loop renderer is not available yet (lockedgroove.loops.render arrives in Phase 1)") from exc
        raise
    for name in ("render_loop", "export_wav"):
        if not hasattr(render, name):
            raise JobError(f"lockedgroove.loops.render has no {name}()")
    return render


def _import_naming():
    try:
        naming = importlib.import_module("lockedgroove.loops.naming")  # Phase 1
    except ModuleNotFoundError:
        return None
    return naming if hasattr(naming, "loop_filename") else None


def _sanitize(name: str) -> str:
    """Fallback for when ``lockedgroove.loops.naming`` is absent; mirrors its rules loosely."""
    name = re.sub(r"\s+", "-", os.path.basename(name).strip())
    name = re.sub(r"[^A-Za-z0-9._#-]", "", name)
    return name.strip("-._") or "loop"


def _format_bpm(bpm: float) -> str:
    return str(int(round(bpm))) if abs(bpm - round(bpm)) < 0.05 else f"{bpm:.1f}"


def _beats_per_bar(meter: str | None) -> int:
    try:
        num, den = str(meter or "4/4").split("/")
        n, d = int(num), int(den)
    except ValueError:
        return 4
    if d == 8 and n % 3 == 0:
        return max(1, n // 3)
    return max(1, n)


def _bars_of(loop: dict, report: AnalysisReport | None) -> int | None:
    """``loops.bars`` when set, else the nearest whole number of bars at the effective tempo."""
    if loop.get("bars"):
        return int(loop["bars"])
    if report is None or report.tempo is None or not report.tempo.bpm:
        return None
    bar_s = 60.0 / float(report.tempo.bpm) * _beats_per_bar(report.beats.meter if report.beats else "4/4")
    bars = int(round((float(loop["end_s"]) - float(loop["start_s"])) / bar_s))
    return bars if bars >= 1 else None


def loop_filename(src: dict, loop: dict, parent: dict | None = None) -> str:
    """``{base}[_{stem}]_{bpm}bpm_{key}_{bars}bar.wav`` (OPEN_QUESTIONS D.18).

    Uses ``lockedgroove.loops.naming.loop_filename`` (conventional key
    spelling) when it is importable, else a plain fallback. Values the report
    lacks are omitted rather than invented.
    """
    base = os.path.splitext(src.get("original_filename") or "loop")[0]
    stem: str | None = None
    if src.get("kind") == "stem" and parent is not None:
        stem = base
        base = os.path.splitext(parent.get("original_filename") or "file")[0]

    report: AnalysisReport | None = None
    if src.get("report"):
        try:
            report = effective(AnalysisReport.model_validate(src["report"]))
        except Exception:
            log.debug("source report unusable for naming", exc_info=True)
    bpm = float(report.tempo.bpm) if report is not None and report.tempo is not None else None
    tonic = report.key.tonic if report is not None and report.key is not None else None
    mode = report.key.mode if report is not None and report.key is not None else None
    bars = _bars_of(loop, report)

    naming = _import_naming()
    if naming is not None and bars is not None:
        try:
            name = naming.loop_filename(base, bpm, tonic, mode, bars, stem=stem)
            if isinstance(name, str) and name:
                return name
        except (TypeError, ValueError):
            log.debug("loops.naming.loop_filename rejected the inputs; using the fallback", exc_info=True)

    parts = [_sanitize(base)]
    if stem:
        parts.append(_sanitize(stem))
    if bpm:
        parts.append(f"{_format_bpm(bpm)}bpm")
    if tonic and mode:
        parts.append(f"{tonic}{'m' if mode == 'minor' else ''}")
    if bars:
        parts.append(f"{int(bars)}bar")
    return "_".join(parts) + ".wav"


def _as_stereo(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        return np.stack([y, y])
    if y.ndim == 2 and y.shape[0] > y.shape[1]:
        y = y.T
    if y.shape[0] == 1:
        return np.concatenate([y, y], axis=0)
    return y


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    loop_id = params.get("loop_id")
    if not loop_id:
        raise JobError("render_loop needs params.loop_id")
    rows = db.select("loops", {"id": loop_id}, limit=1)
    if not rows:
        raise JobError(f"loop {loop_id} not found")
    loop = rows[0]
    src = db.get_file(loop["file_id"])
    if src is None:
        raise JobError(f"source file {loop['file_id']} of loop {loop_id} not found")
    if job.get("user_id") and src.get("user_id") != job["user_id"]:
        raise JobError("loop does not belong to the job's user")

    render = _import_render()
    crossfade_ms = float(params.get("crossfade_ms", DEFAULT_CROSSFADE_MS))
    snap = bool(params.get("snap_zero_crossing", DEFAULT_SNAP_ZERO_CROSSING))
    start_s, end_s = float(loop["start_s"]), float(loop["end_s"])

    ctx.progress(0.05, "download")
    local = ctx.download(src["storage_path"])
    y, sr = load_audio(local)
    y = _as_stereo(y)

    ctx.progress(0.3, "render")
    y_out, meta = render.render_loop(y, sr, start_s, end_s, crossfade_ms=crossfade_ms, snap_zero_crossing=snap)
    y_out = _as_stereo(y_out)
    meta = dict(meta or {})

    parent = db.get_file(src["parent_file_id"]) if src.get("kind") == "stem" and src.get("parent_file_id") else None
    filename = loop_filename(src, loop, parent)
    out_path = os.path.join(ctx.workdir, filename)
    render.export_wav(out_path, y_out, sr, bit_depth=24)

    ctx.progress(0.7, "upload")
    sha = sha256_file(out_path)
    storage_path = f"derived/{src['user_id']}/{src['id']}/loops/{loop_id}.wav"
    storage.upload(storage_path, out_path, content_type_for(storage_path))

    ctx.progress(0.9, "write")
    duration_s = float(y_out.shape[-1] / sr)
    file_row = db.insert_file({
        "user_id": src["user_id"],
        "sha256": sha,
        "original_filename": filename,
        "storage_path": storage_path,
        "size_bytes": os.path.getsize(out_path),
        "duration_s": duration_s,
        "sample_rate": int(sr),
        "channels": int(y_out.shape[0]),
        "format": "wav",
        "kind": "loop_render",
        "parent_file_id": src["id"],
        "status": "queued",
    })
    db.update_rows("loops", {"id": loop_id}, {"render_file_id": file_row["id"]})
    analyze_job = db.insert_job({
        "user_id": src["user_id"],
        "file_id": file_row["id"],
        "kind": "analyze",
        "status": "queued",
        "params": {"analysis_version": ANALYSIS_VERSION},
    })
    ctx.queued_job_ids.append(analyze_job["id"])

    result: dict[str, Any] = {
        "loop_id": loop_id,
        "render_file_id": file_row["id"],
        "analyze_job_id": analyze_job["id"],
        "storage_path": storage_path,
        "filename": filename,
        "duration_s": duration_s,
        "sample_rate": int(sr),
        "render": jsonable({
            "start_s": meta.get("start_s", start_s),
            "end_s": meta.get("end_s", end_s),
            "crossfade_ms": meta.get("crossfade_ms", crossfade_ms),
            **{k: v for k, v in meta.items() if k not in ("start_s", "end_s", "crossfade_ms")},
        }),
    }
    return result


__all__ = ["DEFAULT_CROSSFADE_MS", "DEFAULT_SNAP_ZERO_CROSSING", "loop_filename", "run"]
