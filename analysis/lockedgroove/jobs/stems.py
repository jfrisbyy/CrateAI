"""``stems``: separation on the GPU; each stem becomes a library file with its own analysis.

params: ``{ model?: <registry key>, stems?: ["drums", ...] }``
writes: WAVs at ``derived/{user}/{file_id}/stems/{model}/{stem}.wav``, ``files`` rows
(``kind='stem'``, ``parent_file_id``), ``stems`` rows carrying the separation's quality,
and one ``analyze`` job per stem.

With no ``model`` the best installed separator that produces the requested stems
is used. There is deliberately **no fast mode**: separation is irreversible, a
weak separator costs high-frequency detail nothing downstream can restore, and a
job that asks for one is refused rather than quietly served.

``LOCKEDGROOVE_FAKE_STEMS=1`` (or ``ctx.options["separator"]``) uses the band-split
stand-in so the pipeline runs without a model; its rows are labelled as a stand-in
in both the model name and the quality columns.
"""

from __future__ import annotations

import os

from ..db import Database
from ..stems.separate import (
    DEFAULT_STEMS,
    AudioSeparatorBackend,
    FakeSeparator,
    backend_available_models,
    model_label,
    resolve_model,
    separate_file,
)
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import base_name, queue_analyze, write_wav_file

NO_FAST_MODE = ("fast", "fast_mode", "quality", "preset", "speed")


def _reject_fast_mode(params: dict) -> None:
    named = [k for k in NO_FAST_MODE if k in params]
    if named:
        raise JobError(
            f"the stems job takes no {' or '.join(sorted(named))} parameter: separation always uses the best "
            "available model. Pass `model` to name one explicitly, or nothing to get the best.")


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    _reject_fast_mode(params)
    file_id = job.get("file_id")
    if not file_id:
        raise JobError("stems job has no file_id")
    file = db.get_file(file_id)
    if file is None:
        raise JobError(f"file {file_id} not found")

    wanted = params.get("stems") or DEFAULT_STEMS
    if not isinstance(wanted, (list, tuple)) or not all(isinstance(s, str) for s in wanted):
        raise JobError("`stems` must be a list of stem names")

    ctx.progress(0.05, "download")
    local = ctx.download(file["storage_path"])
    backend = ctx.options.get("separator")
    fake = isinstance(backend, FakeSeparator)
    if backend is None:
        if os.environ.get("LOCKEDGROOVE_FAKE_STEMS") == "1":
            backend, fake = FakeSeparator(), True
        else:
            backend = AudioSeparatorBackend(output_dir=os.path.join(ctx.workdir, "sep"))
    try:
        choice = resolve_model(params.get("model"), wanted, backend_available_models(backend), stand_in=fake)
    except ValueError as exc:
        raise JobError(str(exc)) from exc

    ctx.progress(0.1, "separate")
    stems = separate_file(local, choice.model, backend)
    label = model_label(choice.model, stand_in=fake)
    quality_row = choice.quality.to_row()

    ctx.progress(0.6, "write")
    written: dict[str, dict] = {}
    for i, s in enumerate(stems):
        storage_path = f"derived/{file['user_id']}/{file_id}/stems/{label}/{s.name}.wav"
        filename = f"{base_name(file)}_{s.name}.wav"
        row = write_wav_file(db, storage, ctx, user_id=file["user_id"], parent=file, y=s.y, sr=s.sr,
                             storage_path=storage_path, filename=filename, kind="stem")
        stem_row = db.upsert_rows("stems", [{
            "user_id": file["user_id"], "file_id": file_id, "stem": s.name, "model": label,
            "stem_file_id": row["id"], **quality_row,
        }], on_conflict="file_id,model,stem")[0]
        analyze = queue_analyze(db, ctx, file["user_id"], row["id"])
        written[s.name] = {"file_id": row["id"], "stem_row_id": stem_row.get("id"), "analyze_job_id": analyze["id"]}
        ctx.progress(0.6 + 0.35 * (i + 1) / len(stems), "write")
    return {"file_id": file_id, "model": label, "fake": fake, "stems": written,
            "quality": choice.quality.to_json(), "model_reason": choice.reason,
            "downgraded": choice.downgraded}


__all__ = ["run"]
