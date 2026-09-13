"""``embed``: CLAP embedding for search plus zero-shot tags (GPU job).

params: ``{ model?: string }``
writes: an ``embeddings`` row (upsert on ``file_id, model``), ``tags`` rows (source ``model``), and the
report's ``tags`` list when a report exists.
"""

from __future__ import annotations

from ..analysis.tags import zero_shot_tags
from ..db import Database
from ..embeddings.clap import get_embedder
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import load_file_audio, report_of


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params_of(job)
    if not job.get("file_id"):
        raise JobError("embed job has no file_id")
    ctx.progress(0.05, "download")
    file, y, sr = load_file_audio(db, ctx, job["file_id"], job.get("user_id"))
    embedder = ctx.options.get("embedder")
    if embedder is None:
        try:
            embedder = get_embedder()
        except ImportError as exc:
            raise JobError("CLAP is not installed on this runner; the embed job runs on the GPU image "
                           "(or set LOCKEDGROOVE_FAKE_EMBEDDER=1 for development)") from exc
    ctx.progress(0.3, "embed")
    emb = embedder.embed_audio(y.mean(axis=0), sr)
    row = db.upsert_rows("embeddings", [{
        "user_id": file["user_id"], "file_id": file["id"], "model": embedder.name,
        "vector": [float(v) for v in emb],
    }], on_conflict="file_id,model")[0]
    ctx.progress(0.7, "tags")
    tags = zero_shot_tags(emb, embedder)
    tag_rows = [{"user_id": file["user_id"], "file_id": file["id"], "tag": t.tag, "source": "model",
                 "confidence": float(t.confidence)} for t in tags]
    if tag_rows:
        keep = {t["tag"] for t in tag_rows}
        for old in db.select("tags", {"file_id": file["id"], "source": "model"}):
            if old["tag"] not in keep:
                db.delete_rows("tags", {"id": old["id"]})
        db.upsert_rows("tags", tag_rows, on_conflict="file_id,tag,source")
    report = report_of(file)
    if report is not None:
        report.tags = tags
        db.update_file(file["id"], {"report": report.to_json_dict()})
    return {"file_id": file["id"], "embedding_id": row.get("id"), "model": embedder.name,
            "tags": [t.model_dump() for t in tags]}


__all__ = ["run"]
