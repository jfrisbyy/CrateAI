"""``stems``: GPU separation; each stem becomes a library file with its own analysis.

params: ``{ model: "htdemucs_ft" | "htdemucs_6s" | "bs_roformer" }``
writes: WAVs at ``derived/{user}/{file_id}/stems/{model}/{stem}.wav``, ``files`` rows
(``kind='stem'``, ``parent_file_id``), ``stems`` rows, and one ``analyze`` job per stem.

``LOCKEDGROOVE_FAKE_STEMS=1`` (or ``ctx.options["separator"]``) uses the band-split
stand-in so the pipeline runs without a model; such rows carry ``model = '<model>-fake'``.
"""

from __future__ import annotations

import os

from ..db import Database
from ..stems.separate import DEFAULT_MODEL, MODELS, AudioSeparatorBackend, FakeSeparator, separate_file
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import base_name, queue_analyze, write_wav_file


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    model = params.get("model") or DEFAULT_MODEL
    if model not in MODELS:
        raise JobError(f"unknown stem model {model!r}; choose one of {sorted(MODELS)}")
    file_id = job.get("file_id")
    if not file_id:
        raise JobError("stems job has no file_id")
    file = db.get_file(file_id)
    if file is None:
        raise JobError(f"file {file_id} not found")

    ctx.progress(0.05, "download")
    local = ctx.download(file["storage_path"])
    backend = ctx.options.get("separator")
    fake = False
    if backend is None:
        if os.environ.get("LOCKEDGROOVE_FAKE_STEMS") == "1":
            backend, fake = FakeSeparator(), True
        else:
            backend = AudioSeparatorBackend(output_dir=os.path.join(ctx.workdir, "sep"))
    elif isinstance(backend, FakeSeparator):
        fake = True
    ctx.progress(0.1, "separate")
    stems = separate_file(local, model, backend)
    model_label = f"{model}-fake" if fake else model

    ctx.progress(0.6, "write")
    written: dict[str, dict] = {}
    for i, s in enumerate(stems):
        storage_path = f"derived/{file['user_id']}/{file_id}/stems/{model_label}/{s.name}.wav"
        filename = f"{base_name(file)}_{s.name}.wav"
        row = write_wav_file(db, storage, ctx, user_id=file["user_id"], parent=file, y=s.y, sr=s.sr,
                             storage_path=storage_path, filename=filename, kind="stem")
        stem_row = db.upsert_rows("stems", [{
            "user_id": file["user_id"], "file_id": file_id, "stem": s.name, "model": model_label,
            "stem_file_id": row["id"],
        }], on_conflict="file_id,model,stem")[0]
        analyze = queue_analyze(db, ctx, file["user_id"], row["id"])
        written[s.name] = {"file_id": row["id"], "stem_row_id": stem_row.get("id"), "analyze_job_id": analyze["id"]}
        ctx.progress(0.6 + 0.35 * (i + 1) / len(stems), "write")
    return {"file_id": file_id, "model": model_label, "fake": fake, "stems": written}


__all__ = ["run"]
