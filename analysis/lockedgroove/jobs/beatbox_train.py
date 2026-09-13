"""``beatbox_train``: enrollment recordings -> a per-user classifier (BUILD_PACKET section 15).

params: ``{ examples: [{ "class": "kick" | "snare" | "hat" | ..., "storage_path": "library/{user}/..." }] }``
writes: the model at ``derived/{user}/beatbox/model.joblib`` and a ``beatbox_profiles`` row (one per
user). A profile with cross-validated accuracy under 85 % is stored disabled with the reason.
"""

from __future__ import annotations

import os

from ..beatbox.train import Example, examples_from_recording, train
from ..db import Database
from ..ingest import load_audio
from ..storage import Storage, content_type_for
from .common import JobContext, JobError, params_of
from .derived import owner_path_ok


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    user = job.get("user_id")
    examples_spec = params.get("examples")
    if not user or not isinstance(examples_spec, list) or not examples_spec:
        raise JobError("beatbox_train needs params.examples (class + storage_path per recording)")
    examples: list[Example] = []
    for i, ex in enumerate(examples_spec):
        cls, path = ex.get("class"), ex.get("storage_path")
        if not cls or not owner_path_ok(path or "", user):
            raise JobError(f"examples[{i}] needs a class and a storage_path under your library")
        local = ctx.download(path)
        y, sr = load_audio(local, mono=True)
        examples.extend(examples_from_recording(cls, y, sr))
        ctx.progress(0.1 + 0.5 * (i + 1) / len(examples_spec), "segment")
    ctx.progress(0.7, "train")
    res = train(examples)
    result = {"cv_accuracy": res.cv_accuracy, "enabled": res.enabled, "message": res.message,
              "sample_count": res.sample_count, "per_class_counts": res.per_class_counts, "classes": res.classes}
    if not res.model_bytes:
        return result
    local = os.path.join(ctx.workdir, "model.joblib")
    with open(local, "wb") as f:
        f.write(res.model_bytes)
    model_path = f"derived/{user}/beatbox/model.joblib"
    storage.upload(model_path, local, content_type_for(model_path))
    row = db.upsert_rows("beatbox_profiles", [{"user_id": user, "model_path": model_path, "classes": res.classes,
                                               "sample_count": res.sample_count, "cv_accuracy": res.cv_accuracy,
                                               "enabled": res.enabled}], on_conflict="user_id")[0]
    result["profile_id"] = row.get("id")
    result["model_path"] = model_path
    return result


__all__ = ["run"]
