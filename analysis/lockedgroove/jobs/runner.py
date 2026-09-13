"""The job lifecycle (docs/CONTRACTS.md section 4), the same on Modal and locally.

    run_job(job_id, db, storage) -> final jobs row (dict)

1. ``jobs.status = 'running'``, ``started_at = now()``.
2. The handler for ``jobs.kind`` downloads what it needs with the service role.
3. Progress goes to ``jobs.progress`` (throttled to one write per 2 s).
4. ``jobs.status = 'done'``, ``result`` (ids of rows written), ``finished_at``.
5. On exception: ``jobs.status = 'failed'``, ``jobs.error = str(exc)``; a file
   whose primary analysis failed gets ``files.status = 'failed'``.

Handlers live in ``lockedgroove.jobs.<kind>`` and are imported on demand. A
kind whose module has not landed yet fails with "job kind X is not
implemented yet (arrives in Phase N)" so the web UI can say so.

Principle 3 is enforced here for every kind: params never carry a URL.
"""

from __future__ import annotations

import importlib
import logging
import time
from collections.abc import Callable, Mapping
from typing import Any

from ..db import Database, jsonable, now_iso
from ..storage import Storage
from .common import JobContext, JobError, ProgressWriter, params_of

log = logging.getLogger(__name__)

# Which phase of BUILD_PACKET section 18 delivers each job kind.
KIND_PHASE: dict[str, int] = {
    "analyze": 0,            # Foundation: Modal `analyze` with the Phase 0 stages
    "render_loop": 1,        # Loops: finder, renderer, export
    "stems": 2,              # Stems and better beats: GPU separation
    "chop": 3,               # Chops and MIDI
    "midi": 3,               # Chops and MIDI
    "breakdown": 4,          # Breakdown
    "compare": 4,            # Breakdown: compare
    "embed": 6,              # Search: CLAP embeddings
    "layer": 7,              # Combine and re-voice
    "revoice": 7,            # Combine and re-voice
    "beatbox_train": 9,      # Beatbox
    "beatbox_transcribe": 9,  # Beatbox
    "export": 13,            # Export: the song out, as stems + a tempo map + a readme
}

# Job kinds metered as GPU time (BUILD_PACKET section 19); everything else is CPU time.
GPU_METERED_KINDS = {"stems", "embed", "beatbox_train"}


def _record_usage(db: Database, job: Mapping[str, Any], seconds: float) -> None:
    """One usage_events row per finished job (best effort; never fails the job)."""
    kind = str(job.get("kind"))
    rows = [{"user_id": job.get("user_id"), "kind": "gpu_seconds" if kind in GPU_METERED_KINDS else "cpu_seconds",
             "amount": round(max(seconds, 0.0), 3), "job_id": job.get("id")}]
    if kind == "stems":
        rows.append({"user_id": job.get("user_id"), "kind": "stem_job", "amount": 1, "job_id": job.get("id")})
    try:
        db.insert_rows("usage_events", rows)
    except Exception:
        log.debug("usage_events write skipped", exc_info=True)


# Param names that would carry a location instead of user material. Checked
# recursively and case-insensitively; suffix forms (``source_url``) count too.
FORBIDDEN_PARAM_KEYS = ("url", "href", "link", "uri")

Handler = Callable[[dict, Database, Storage, JobContext], dict | None]


def assert_no_url_params(params: Any, path: str = "params") -> None:
    """Raise ``JobError`` if any key in ``params`` (nested) is named like a URL."""
    if isinstance(params, Mapping):
        for key, value in params.items():
            name = str(key).lower()
            if name in FORBIDDEN_PARAM_KEYS or any(name.endswith("_" + k) for k in FORBIDDEN_PARAM_KEYS):
                raise JobError(
                    f"{path}.{key} is not allowed: jobs take user files from the library, never a URL "
                    "(principle 3: read the internet, never download audio from it)"
                )
            assert_no_url_params(value, f"{path}.{key}")
    elif isinstance(params, (list, tuple)):
        for i, item in enumerate(params):
            assert_no_url_params(item, f"{path}[{i}]")


def is_primary_analysis(job: Mapping[str, Any]) -> bool:
    """An ``analyze`` job for the file itself (not a secondary task such as ``find_loops``)."""
    if job.get("kind") != "analyze" or not job.get("file_id"):
        return False
    task = params_of(dict(job)).get("task")
    return task in (None, "", "analyze")


def resolve_handler(kind: str) -> Handler:
    if kind not in KIND_PHASE:
        raise JobError(f"unknown job kind {kind!r} (known: {', '.join(KIND_PHASE)})")
    module_name = f"lockedgroove.jobs.{kind}"
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name == module_name:
            raise JobError(f"job kind {kind} is not implemented yet (arrives in Phase {KIND_PHASE[kind]})") from exc
        raise  # the handler exists but one of its dependencies is missing: show the real error
    fn = getattr(module, "run", None)
    if fn is None or not callable(fn):
        raise JobError(f"{module_name} has no run(job, db, storage, ctx)")
    return fn


def _mark_file_after_failure(db: Database, job: Mapping[str, Any]) -> None:
    """A file whose primary analysis failed is ``failed``; one that already has a report stays ``ready``."""
    if not is_primary_analysis(job):
        return
    file_id = job["file_id"]
    try:
        file = db.get_file(file_id)
        if file is None:
            return
        db.update_file(file_id, {"status": "ready" if file.get("report") else "failed"})
    except Exception:
        log.exception("could not update files.status after job %s failed", job.get("id"))


def run_job(
    job_id: str,
    db: Database,
    storage: Storage,
    *,
    on_queued: Callable[[str], Any] | None = None,
    clock: Callable[[], float] = time.monotonic,
    progress_interval_s: float = 2.0,
) -> dict:
    """Run one job to completion and return the final ``jobs`` row.

    Never raises for a failing job (the failure is recorded on the row); it
    raises only when the job row itself cannot be found. ``on_queued`` is
    called with the id of every follow-up job a handler created, so the host
    (thread pool locally, ``.spawn()`` on Modal) can dispatch it.
    """
    job = db.get_job(job_id)
    if job is None:
        raise JobError(f"job {job_id} not found")
    if job.get("status") == "done":
        log.info("job %s is already done; not running it again", job_id)
        return job

    job = db.update_job(job_id, {"status": "running", "started_at": now_iso(), "error": None, "progress": 0.0})
    progress = ProgressWriter(db, job_id, min_interval_s=progress_interval_s, clock=clock)
    ctx = JobContext(job_id=job_id, db=db, storage=storage, progress=progress)
    kind = str(job.get("kind"))
    log.info("job %s (%s) running", job_id, kind)
    t_start = clock()

    try:
        assert_no_url_params(params_of(job))
        handler = resolve_handler(kind)
        result = handler(job, db, storage, ctx)
        result = dict(jsonable(result or {}))
        if ctx.queued_job_ids:
            result["queued_job_ids"] = list(ctx.queued_job_ids)
        final = db.update_job(job_id, {"status": "done", "result": result, "finished_at": now_iso(), "progress": 1.0})
        log.info("job %s (%s) done", job_id, kind)
        _record_usage(db, job, clock() - t_start)
    except Exception as exc:  # the row carries the failure; the host does not need the traceback
        message = str(exc).strip() or type(exc).__name__
        log.exception("job %s (%s) failed: %s", job_id, kind, message)
        final = db.update_job(job_id, {"status": "failed", "error": message, "finished_at": now_iso()})
        _mark_file_after_failure(db, job)
        _record_usage(db, job, clock() - t_start)
        return final
    finally:
        ctx.cleanup()

    if on_queued is not None:
        for queued_id in ctx.queued_job_ids:
            try:
                on_queued(queued_id)
            except Exception:
                log.exception("dispatching follow-up job %s failed", queued_id)
    return final


__all__ = ["FORBIDDEN_PARAM_KEYS", "GPU_METERED_KINDS", "KIND_PHASE", "assert_no_url_params", "is_primary_analysis",
           "resolve_handler", "run_job"]
