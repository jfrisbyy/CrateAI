"""``compare``: two files, same structure, side by side, with deltas ("mine vs the reference").

params: ``{ file_a_id, file_b_id, a_name?: "mine", b_name?: "the reference" }``
writes: a ``comparisons`` row.
"""

from __future__ import annotations

from ..breakdown.compare import compare
from ..db import Database
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import report_of, stem_reports


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    a_id, b_id = params.get("file_a_id"), params.get("file_b_id")
    if not a_id or not b_id:
        raise JobError("compare needs params.file_a_id and params.file_b_id")
    a, b = db.get_file(a_id), db.get_file(b_id)
    if a is None or b is None:
        raise JobError("one of the files was not found")
    user = job.get("user_id")
    if user and (a.get("user_id") != user or b.get("user_id") != user):
        raise JobError("files do not belong to the job's user")
    ra, rb = report_of(a), report_of(b)
    if ra is None or rb is None:
        raise JobError("both files need to be analyzed before comparing")
    sa = {k: v for k, v in stem_reports(db, a_id).items() if v is not None}
    sb = {k: v for k, v in stem_reports(db, b_id).items() if v is not None}
    content = compare(ra, rb, sa or None, sb or None, a_name=params.get("a_name") or "mine",
                      b_name=params.get("b_name") or "the reference")
    row = db.insert_rows("comparisons", [{"user_id": a["user_id"], "file_a_id": a_id, "file_b_id": b_id,
                                          "content": content.model_dump(mode="json")}])[0]
    return {"comparison_id": row["id"], "delta_count": len(content.deltas), "missing": content.missing}


__all__ = ["run"]
