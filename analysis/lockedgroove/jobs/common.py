"""Shared pieces for job handlers: the per-job context, progress writer, errors."""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..db import Database, jsonable
from ..storage import Storage

log = logging.getLogger(__name__)

PROGRESS_MIN_INTERVAL_S = 2.0


class JobError(RuntimeError):
    """A job cannot run as asked; ``str(exc)`` is what the user sees in ``jobs.error``."""


class ProgressWriter:
    """Writes ``jobs.progress`` at most once per ``min_interval_s`` (2 s by default).

    Calls inside the interval are dropped, not deferred: the final state is
    written by the runner with the ``done`` update, so nothing is lost.
    """

    def __init__(self, db: Database, job_id: str, *, min_interval_s: float = PROGRESS_MIN_INTERVAL_S,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.db = db
        self.job_id = job_id
        self.min_interval_s = min_interval_s
        self.clock = clock
        self.last_write_at: float | None = None
        self.last_fraction: float | None = None
        self.last_stage: str | None = None
        self.writes = 0

    def __call__(self, fraction: float, stage: str | None = None) -> bool:
        fraction = float(min(1.0, max(0.0, fraction)))
        self.last_fraction = fraction
        if stage is not None:
            self.last_stage = stage
        now = self.clock()
        if self.last_write_at is not None and now - self.last_write_at < self.min_interval_s:
            return False
        try:
            self.db.update_job(self.job_id, {"progress": fraction})
        except Exception:  # progress is best effort and must never break a job
            log.debug("progress write failed for job %s", self.job_id, exc_info=True)
            return False
        self.last_write_at = now
        self.writes += 1
        return True


@dataclass
class JobContext:
    """What a handler gets besides the job row, the database and the storage.

    * ``progress(fraction, stage=None)`` writes ``jobs.progress`` (throttled).
    * ``download(path)`` fetches an object to a temp file that is removed when the job ends.
    * ``workdir`` is a scratch directory removed when the job ends.
    * ``queued_job_ids``: handlers that create follow-up jobs (a stem's own
      ``analyze``, a loop render's ``analyze``) append the new ids; the runner
      reports them in ``result.queued_job_ids`` and hands them to the host's
      dispatcher.
    """

    job_id: str
    db: Database
    storage: Storage
    progress: ProgressWriter
    workdir: str = field(default_factory=lambda: tempfile.mkdtemp(prefix="lockedgroove-job-"))
    queued_job_ids: list[str] = field(default_factory=list)
    temp_paths: list[str] = field(default_factory=list)
    options: dict[str, Any] = field(default_factory=dict)

    def download(self, path: str) -> str:
        local = self.storage.download(path)
        self.temp_paths.append(local)
        return local

    def cleanup(self) -> None:
        for p in self.temp_paths:
            try:
                os.remove(p)
            except OSError:
                pass
        self.temp_paths.clear()
        shutil.rmtree(self.workdir, ignore_errors=True)


def params_of(job: dict) -> dict:
    params = job.get("params")
    return dict(params) if isinstance(params, dict) else {}


__all__ = ["JobContext", "JobError", "PROGRESS_MIN_INTERVAL_S", "ProgressWriter", "jsonable", "params_of"]
