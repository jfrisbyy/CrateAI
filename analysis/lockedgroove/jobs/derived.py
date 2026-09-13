"""Helpers shared by the handlers that write derived library entries."""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import numpy as np
import soundfile as sf

from .. import ANALYSIS_VERSION
from ..db import Database
from ..ingest import load_audio, sha256_file
from ..report import AnalysisReport, effective
from ..storage import Storage, content_type_for
from .common import JobContext, JobError

log = logging.getLogger(__name__)

STEM_AWARE_STAGES = ("chords", "drums", "sample_use", "instrumentation", "effects_estimates")
PHASE4_STAGES = list(STEM_AWARE_STAGES)
PENDING = ("queued", "running")


def report_of(file: dict | None) -> Optional[AnalysisReport]:
    if not file or not file.get("report"):
        return None
    try:
        return AnalysisReport.model_validate(file["report"])
    except Exception:
        log.warning("file %s has a report that does not validate", file.get("id"))
        return None


def effective_report_of(file: dict | None) -> Optional[AnalysisReport]:
    r = report_of(file)
    return effective(r) if r is not None else None


def as_2d(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        return y[None, :]
    if y.shape[0] > y.shape[1]:
        y = y.T
    return y


def load_file_audio(db: Database, ctx: JobContext, file_id: str, user_id: Optional[str] = None
                    ) -> tuple[dict, np.ndarray, int]:
    file = db.get_file(file_id)
    if file is None:
        raise JobError(f"file {file_id} not found")
    if user_id and file.get("user_id") != user_id:
        raise JobError("file does not belong to the job's user")
    local = ctx.download(file["storage_path"])
    y, sr = load_audio(local)
    return file, as_2d(y), int(sr)


def stem_rows(db: Database, file_id: str, model: Optional[str] = None) -> dict[str, dict]:
    rows = db.select("stems", {"file_id": file_id})
    if model:
        rows = [r for r in rows if r.get("model") == model]
    out: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: str(r.get("created_at") or "")):
        out[r["stem"]] = r  # the latest model wins when several exist
    return out


def load_stem_arrays(db: Database, ctx: JobContext, file: dict, sr_target: int, model: Optional[str] = None
                     ) -> Optional[dict[str, np.ndarray]]:
    rows = stem_rows(db, file["id"], model)
    if not rows:
        return None
    import librosa

    out: dict[str, np.ndarray] = {}
    for name, row in rows.items():
        stem_file = db.get_file(row["stem_file_id"])
        if stem_file is None:
            continue
        local = ctx.download(stem_file["storage_path"])
        y, sr = load_audio(local, mono=True)
        if sr != sr_target:
            y = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=sr_target)
        out[name] = np.asarray(y, dtype=np.float32)
    return out or None


def stem_reports(db: Database, file_id: str, model: Optional[str] = None) -> dict[str, Optional[AnalysisReport]]:
    out: dict[str, Optional[AnalysisReport]] = {}
    for name, row in stem_rows(db, file_id, model).items():
        out[name] = report_of(db.get_file(row["stem_file_id"]))
    return out


def owner_path_ok(path: str, user_id: str) -> bool:
    return isinstance(path, str) and (path.startswith(f"library/{user_id}/") or path.startswith(f"derived/{user_id}/"))


def write_wav_file(db: Database, storage: Storage, ctx: JobContext, *, user_id: str, parent: Optional[dict],
                   y: np.ndarray, sr: int, storage_path: str, filename: str, kind: str, bit_depth: int = 24,
                   extra: Optional[dict[str, Any]] = None) -> dict:
    """Export a WAV, upload it, insert the ``files`` row (status queued) and return the row."""
    y2 = as_2d(y)
    local = os.path.join(ctx.workdir, os.path.basename(filename))
    subtype = {16: "PCM_16", 24: "PCM_24", 32: "FLOAT"}.get(bit_depth, "PCM_24")
    sf.write(local, np.clip(y2.T, -1.0, 1.0), sr, subtype=subtype)
    sha = sha256_file(local)
    storage.upload(storage_path, local, content_type_for(storage_path))
    row = {
        "user_id": user_id,
        "sha256": sha,
        "original_filename": filename,
        "storage_path": storage_path,
        "size_bytes": os.path.getsize(local),
        "duration_s": float(y2.shape[1] / sr),
        "sample_rate": int(sr),
        "channels": int(y2.shape[0]),
        "format": "wav",
        "kind": kind,
        "parent_file_id": parent["id"] if parent else None,
        "status": "queued",
    }
    if extra:
        row.update(extra)
    return db.insert_file(row)


def queue_analyze(db: Database, ctx: JobContext, user_id: str, file_id: str, stages: Optional[list[str]] = None,
                  extra_params: Optional[dict] = None) -> dict:
    params: dict[str, Any] = {"analysis_version": ANALYSIS_VERSION}
    if stages is not None:
        params["stages"] = list(stages)
    if extra_params:
        params.update(extra_params)
    job = db.insert_job({"user_id": user_id, "file_id": file_id, "kind": "analyze", "status": "queued", "params": params})
    ctx.queued_job_ids.append(job["id"])
    return job


def pending_job(db: Database, file_id: str, kind: str) -> Optional[dict]:
    for row in db.select("jobs", {"file_id": file_id, "kind": kind}):
        if row.get("status") in PENDING:
            return row
    return None


def base_name(file: dict) -> str:
    return os.path.splitext(file.get("original_filename") or "file")[0]


__all__ = ["PENDING", "PHASE4_STAGES", "STEM_AWARE_STAGES", "as_2d", "base_name", "effective_report_of",
           "load_file_audio", "load_stem_arrays", "owner_path_ok", "pending_job", "queue_analyze", "report_of",
           "stem_reports", "stem_rows", "write_wav_file"]
