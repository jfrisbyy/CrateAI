"""``breakdown``: compose the beat breakdown from measured fields; queue what is missing.

params: ``{ web_context?: {...}, model?: stem model }``
Always writes a new ``breakdowns`` version with what is measured now (sections that can't be
written say so and name the job), and queues the missing prerequisites once: ``stems`` when there
are none, the Phase 4 stages on the original when stems exist but those sections are null, and a
per-stem ``analyze`` for any stem without a report. The web re-requests the breakdown when those
jobs finish, so the document fills in as sections become available.
"""

from __future__ import annotations

from ..breakdown.compose import compose
from ..db import Database
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import PHASE4_STAGES, pending_job, queue_analyze, report_of, stem_reports, stem_rows


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    file_id = job.get("file_id")
    if not file_id:
        raise JobError("breakdown job has no file_id")
    file = db.get_file(file_id)
    if file is None:
        raise JobError(f"file {file_id} not found")
    if job.get("user_id") and file.get("user_id") != job["user_id"]:
        raise JobError("file does not belong to the job's user")

    queued: dict[str, str] = {}
    report = report_of(file)
    if report is None or report.tempo is None:
        if not pending_job(db, file_id, "analyze"):
            queued["analyze"] = queue_analyze(db, ctx, file["user_id"], file_id)["id"]

    rows = stem_rows(db, file_id, params.get("model"))
    reports = stem_reports(db, file_id, params.get("model"))
    if not rows:
        if not pending_job(db, file_id, "stems"):
            j = db.insert_job({"user_id": file["user_id"], "file_id": file_id, "kind": "stems", "status": "queued",
                               "params": {"model": params.get("model") or "htdemucs_ft"}})
            ctx.queued_job_ids.append(j["id"])
            queued["stems"] = j["id"]
    else:
        for name, row in rows.items():
            if reports.get(name) is None and not pending_job(db, row["stem_file_id"], "analyze"):
                queued[f"analyze:{name}"] = queue_analyze(db, ctx, file["user_id"], row["stem_file_id"])["id"]
        if report is not None and report.tempo is not None and all(
                getattr(report, f) is None for f in ("drums", "sample_use", "instrumentation", "effects_estimates")):
            if not any(p.get("params", {}).get("stages") == PHASE4_STAGES for p in db.select("jobs", {"file_id": file_id, "kind": "analyze"})
                       if p.get("status") in ("queued", "running")):
                # force: the file is already at the current analysis version; without it the analyze job skips
                queued["analyze:phase4"] = queue_analyze(db, ctx, file["user_id"], file_id, stages=PHASE4_STAGES,
                                                         extra_params={"force": True})["id"]

    ctx.progress(0.5, "compose")
    content = compose(report or __import__("lockedgroove.report", fromlist=["AnalysisReport"]).AnalysisReport.empty(),
                      {k: v for k, v in reports.items() if v is not None} or None,
                      title=file.get("title"), artist=file.get("artist"), web_context=params.get("web_context"))
    existing = db.select("breakdowns", {"file_id": file_id})
    version = max([int(r.get("version") or 0) for r in existing] + [0]) + 1
    row = db.insert_rows("breakdowns", [{"user_id": file["user_id"], "file_id": file_id, "version": version,
                                         "content": content.model_dump(mode="json"),
                                         "web_context": params.get("web_context")}])[0]
    return {"breakdown_id": row["id"], "version": version, "requires": content.requires, "queued": queued,
            "complete": not content.requires}


__all__ = ["run"]
