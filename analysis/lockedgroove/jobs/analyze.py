"""``analyze``: the primary analysis of a library file, plus the ``find_loops`` task.

params: ``{ analysis_version?: int, stages?: string[], force?: bool, task?: "analyze" | "find_loops",
            bars?: int[], top_k?: int }``

writes (task ``analyze``): ``files.report``, ``files.peaks``,
``files.duration_s/sample_rate/channels/format``, ``files.analysis_version``,
``files.status = 'ready'``, ``tags`` rows (source ``model``).

Idempotency (CONTRACTS section 4): a no-op when ``files.analysis_version >=
requested`` and ``files.report`` is present; ``params.force`` overrides.

Files longer than 20 minutes (OPEN_QUESTIONS B.9) are analyzed on their first
20 minutes; peaks and ``duration_s`` still describe the whole file and the
job result carries ``{"truncated_to_s": 1200}``.

writes (task ``find_loops``): replaces the file's ``loops`` rows of origin
``finder`` with the new candidates and returns their ids. When the file has
stems, they are loaded and each candidate carries what is and is not playing
in it per stem (``components.sample_ready``: vocal-free, drums-free,
drums-only, fullness, each with a confidence). ``params.use_stems = false``
skips that; without stems the finder behaves exactly as it did.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import os
from typing import Any

import numpy as np

from .. import ANALYSIS_VERSION
from ..db import Database, jsonable
from ..ingest import compute_peaks, file_info_for, load_audio
from ..pipeline import DEFAULT_STAGES, analyze_array, to_mono
from ..report import AnalysisReport, effective
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import STEM_AWARE_STAGES, load_stem_arrays, stem_rows

log = logging.getLogger(__name__)

MAX_ANALYSIS_S = 20 * 60.0
DEFAULT_LOOP_BARS = [1, 2, 4, 8]
DEFAULT_LOOP_TOP_K = 12


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    file_id = job.get("file_id")
    if not file_id:
        raise JobError("analyze job has no file_id")
    file = db.get_file(file_id)
    if file is None:
        raise JobError(f"file {file_id} not found")

    task = params.get("task") or "analyze"
    if task == "find_loops":
        return find_loops_task(job, db, storage, ctx, file, params)
    if task != "analyze":
        raise JobError(f"unknown analyze task {task!r} (expected 'analyze' or 'find_loops')")
    return analyze_task(job, db, storage, ctx, file, params)


# ---------------------------------------------------------------------------
# task: analyze
# ---------------------------------------------------------------------------


def _format_of(file: dict, local_path: str) -> str | None:
    for candidate in (file.get("storage_path"), file.get("original_filename"), local_path):
        ext = os.path.splitext(candidate or "")[1].lower().lstrip(".")
        if ext:
            return ext
    return file.get("format")


def _prior_report(file: dict) -> AnalysisReport | None:
    prior = file.get("report")
    if not prior:
        return None
    try:
        return AnalysisReport.model_validate(prior)
    except Exception:
        log.warning("file %s has a report that no longer validates; starting fresh", file.get("id"))
        return None


def analyze_task(job: dict, db: Database, storage: Storage, ctx: JobContext, file: dict, params: dict) -> dict:
    file_id = file["id"]
    requested = int(params.get("analysis_version") or ANALYSIS_VERSION)
    force = bool(params.get("force", False))
    stages = params.get("stages")
    if stages is not None and not isinstance(stages, list):
        raise JobError("params.stages must be a list of stage names")

    current_version = int(file.get("analysis_version") or 0)
    if not force and file.get("report") and current_version >= requested:
        return {
            "file_id": file_id, "skipped": True, "analysis_version": current_version,
            "reason": f"already analyzed at version {current_version} (requested {requested})",
        }

    db.update_file(file_id, {"status": "analyzing"})
    ctx.progress(0.02, "download")
    local = ctx.download(file["storage_path"])

    ctx.progress(0.05, "decode")
    y, sr = load_audio(local)  # stereo kept as (2, n)
    n_total = int(y.shape[-1])
    if n_total == 0 or not sr:
        raise JobError("the file decoded to no audio")
    full_duration_s = float(n_total / sr)

    peaks = compute_peaks(y)  # whole file: the waveform must show all of it

    truncated_to_s: float | None = None
    max_samples = int(MAX_ANALYSIS_S * sr)
    if n_total > max_samples:
        y = np.ascontiguousarray(y[..., :max_samples])
        truncated_to_s = float(MAX_ANALYSIS_S)

    info = file_info_for(
        local, y, sr,
        id=file_id, sha256=file.get("sha256"), original_filename=file.get("original_filename"),
        kind=file.get("kind") or "original", parent_file_id=file.get("parent_file_id"),
        duration_s=full_duration_s, format=_format_of(file, local),
    )

    prior = _prior_report(file)
    # An explicit stage list adds to what is already there; a default run starts fresh.
    base_report = prior if (prior is not None and stages is not None) else None

    # Stem-aware stages (drums, chords, sample use, instrumentation, effects) read the file's stems
    # when separation has run; without stems they measure the mix and say so in ``method``.
    stems_arrays = None
    wanted_now = list(stages) if stages is not None else list(DEFAULT_STAGES)
    if any(s in wanted_now for s in STEM_AWARE_STAGES):
        ctx.progress(0.08, "stems")
        stems_arrays = load_stem_arrays(db, ctx, file, sr_target=int(sr))

    def on_progress(stage: str, fraction: float) -> None:
        ctx.progress(0.1 + 0.8 * fraction, stage)

    report, actx = analyze_array(
        y, sr, file_info=info, stages=stages, analysis_version=requested,
        on_progress=on_progress, return_context=True, base_report=base_report, stems=stems_arrays,
    )
    if prior is not None:
        report.user_edits = prior.user_edits  # corrections survive re-analysis (principle 7)

    ctx.progress(0.95, "write")
    patch = {
        "report": report.to_json_dict(),
        "peaks": peaks,
        "duration_s": full_duration_s,
        "sample_rate": int(sr),
        "channels": int(info.channels),
        "format": info.format,
        "analysis_version": requested,
        "status": "ready",
    }
    if not file.get("size_bytes"):
        try:
            patch["size_bytes"] = os.path.getsize(local)
        except OSError:
            pass
    db.update_file(file_id, patch)

    wanted = list(stages) if stages is not None else list(DEFAULT_STAGES)
    tag_ids = _write_tags(db, file, report, tags_ran=("tags" in wanted and "tags" not in actx.errors))

    result: dict[str, Any] = {
        "file_id": file_id,
        "analysis_version": requested,
        "code_analysis_version": ANALYSIS_VERSION,
        "stages": wanted,
        "stage_errors": dict(actx.errors),
        "timings_s": {k: round(v, 3) for k, v in actx.timings_s.items()},
        "tag_ids": tag_ids,
        "duration_s": full_duration_s,
        "skipped": False,
        "stems_used": sorted(stems_arrays) if stems_arrays else [],
    }
    if truncated_to_s is not None:
        result["truncated_to_s"] = truncated_to_s
        result["note"] = (f"analysis covers the first {int(truncated_to_s // 60)} minutes of a "
                          f"{full_duration_s / 60:.1f}-minute file")
    return result


def _write_tags(db: Database, file: dict, report: AnalysisReport, *, tags_ran: bool) -> list[str]:
    rows = [
        {"user_id": file["user_id"], "file_id": file["id"], "tag": t.tag, "source": "model",
         "confidence": float(t.confidence)}
        for t in report.tags
    ]
    if tags_ran:
        keep = {r["tag"] for r in rows}
        stale = [r for r in db.select("tags", {"file_id": file["id"], "source": "model"}) if r["tag"] not in keep]
        for r in stale:
            db.delete_rows("tags", {"id": r["id"]})
    if not rows:
        return []
    written = db.upsert_rows("tags", rows, on_conflict="file_id,tag,source")
    return [r["id"] for r in written if r.get("id")]


# ---------------------------------------------------------------------------
# task: find_loops
# ---------------------------------------------------------------------------


def _candidate_field(candidate: Any, name: str, default: Any = None) -> Any:
    if isinstance(candidate, dict):
        return candidate.get(name, default)
    return getattr(candidate, name, default)


def loop_name(bars: int | None, start_s: float) -> str:
    if bars:
        return f"{bars} bar{'s' if bars != 1 else ''} @ {start_s:.1f}s"
    return f"loop @ {start_s:.1f}s"


def _loop_row(candidate: Any, file: dict) -> dict:
    start_s = float(_candidate_field(candidate, "start_s"))
    end_s = float(_candidate_field(candidate, "end_s"))
    bars = _candidate_field(candidate, "bars")
    bars = int(bars) if bars is not None else None
    score = _candidate_field(candidate, "score")
    components = _candidate_field(candidate, "components")
    name = _candidate_field(candidate, "name")
    return {
        "user_id": file["user_id"],
        "file_id": file["id"],
        "start_s": start_s,
        "end_s": end_s,
        "bars": bars,
        "score": float(score) if score is not None else None,
        "origin": "finder",
        "components": jsonable(components) if components is not None else None,
        "name": str(name) if name else loop_name(bars, start_s),
    }


def loop_stems(db: Database, ctx: JobContext, file: dict, sr: int) -> tuple[dict[str, Any] | None, Any]:
    """The file's stems for the loop finder, plus where they came from.

    Best effort: a missing or unreadable stem must never fail a loop search,
    it only costs the sample-ready claims. Returns ``(arrays, source)`` with
    ``arrays`` ``None`` when the file has no stems.
    """
    try:
        rows = stem_rows(db, file["id"])
        if not rows:
            return None, None
        arrays = load_stem_arrays(db, ctx, file, sr_target=int(sr))
        if not arrays:
            return None, None
        from ..loops.sample_ready import StemSource  # imported late, like the finder itself

        labels = sorted({str(r.get("model")) for r in rows.values() if r.get("model")})
        if not labels:
            source = StemSource()
        elif len(labels) == 1:
            source = StemSource.from_model(labels[0])
        else:
            parts = [StemSource.from_model(label) for label in labels]
            source = StemSource(model=", ".join(labels), trusted=all(p.trusted for p in parts),
                                note=next((p.note for p in parts if p.note), None))
        return arrays, source
    except Exception:  # pragma: no cover - stems are an enrichment, never a failure
        log.warning("could not load stems for the loop finder on file %s", file.get("id"), exc_info=True)
        return None, None


def _accepts_stems(find_loops: Any) -> bool:
    try:
        return "stems" in inspect.signature(find_loops).parameters
    except (TypeError, ValueError):  # pragma: no cover - builtins and C callables
        return False


def _claim_counts(rows: list[dict]) -> dict[str, int]:
    """How many of the written loops carry each claim, for the job result."""
    from ..loops.sample_ready import FLAG_CLAIM_NAMES, holds

    return {name: sum(1 for r in rows if holds(r, name, True)) for name in FLAG_CLAIM_NAMES}


def find_loops_task(job: dict, db: Database, storage: Storage, ctx: JobContext, file: dict, params: dict) -> dict:
    try:
        finder = importlib.import_module("lockedgroove.loops.finder")  # Phase 1
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.startswith("lockedgroove.loops"):
            raise JobError("the loop finder is not available yet (lockedgroove.loops.finder arrives in Phase 1)") from exc
        raise
    find_loops = getattr(finder, "find_loops", None)
    if find_loops is None:
        raise JobError("lockedgroove.loops.finder has no find_loops()")

    if not file.get("report"):
        raise JobError("the file has no analysis report yet; run analyze before find_loops")
    report = effective(AnalysisReport.model_validate(file["report"]))

    bars = params.get("bars") or DEFAULT_LOOP_BARS
    if not isinstance(bars, list) or not all(isinstance(b, int) and b > 0 for b in bars):
        raise JobError("params.bars must be a list of positive integers")
    top_k = int(params.get("top_k") or DEFAULT_LOOP_TOP_K)

    ctx.progress(0.05, "download")
    local = ctx.download(file["storage_path"])
    y, sr = load_audio(local)
    y = to_mono(y)
    stems_arrays: dict[str, Any] | None = None
    stem_source = None
    if params.get("use_stems", True) and _accepts_stems(find_loops):
        ctx.progress(0.15, "stems")
        stems_arrays, stem_source = loop_stems(db, ctx, file, int(sr))

    ctx.progress(0.2, "find_loops")
    kwargs: dict[str, Any] = {"bars": bars, "top_k": top_k}
    if stems_arrays:
        kwargs["stems"] = stems_arrays
        kwargs["stem_source"] = stem_source
    candidates = list(find_loops(y, sr, report, **kwargs) or [])

    rows = [_loop_row(c, file) for c in candidates]
    ctx.progress(0.9, "write")
    deleted = db.delete_rows("loops", {"file_id": file["id"], "origin": "finder"})
    inserted = db.insert_rows("loops", rows) if rows else []
    result: dict[str, Any] = {
        "file_id": file["id"],
        "loop_ids": [r["id"] for r in inserted],
        "count": len(inserted),
        "replaced": deleted,
        "bars": bars,
        "top_k": top_k,
        "stems_used": sorted(stems_arrays) if stems_arrays else [],
    }
    if stems_arrays:
        result["stem_model"] = getattr(stem_source, "model", None)
        result["stems_trusted"] = bool(getattr(stem_source, "trusted", False))
        result["sample_ready_counts"] = _claim_counts(inserted)
    return result


__all__ = ["DEFAULT_LOOP_BARS", "DEFAULT_LOOP_TOP_K", "MAX_ANALYSIS_S", "analyze_task", "find_loops_task",
           "loop_name", "loop_stems", "run"]
