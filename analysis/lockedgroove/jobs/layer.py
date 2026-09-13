"""``layer``: render a layer (stacked lanes) to a library file.

params: ``{ layer_id, apply_plan?: true }``
The ``layers`` and ``layer_items`` rows are the editable state. Items still at their defaults
(stretch 1, pitch 0, offset 0) receive the alignment plan's values (tempo-match, key-match,
downbeat-align) and the rows are updated so the UI shows what was applied.
writes: ``derived/{user}/{layer_id}/layer.wav``, a ``files`` row (``kind='layer_render'``),
``layers.render_file_id`` (+ target tempo/key when unset), and an ``analyze`` job for the render.
"""

from __future__ import annotations

import numpy as np

from ..combine.align import AlignItem, ItemPlan, apply_plan, plan_alignment
from ..combine.layer import Lane, render_layer
from ..db import Database
from ..storage import Storage
from .common import JobContext, JobError, params_of
from .derived import effective_report_of, load_file_audio, queue_analyze, write_wav_file

RENDER_SR = 44100


def _align_item(file: dict, tags: list[str]) -> AlignItem:
    r = effective_report_of(file)
    bpm = r.tempo.bpm if r and r.tempo else None
    first_db = r.beats.downbeats_s[0] if r and r.beats and r.beats.downbeats_s else 0.0
    tonic = r.key.tonic if r and r.key else None
    mode = r.key.mode if r and r.key else None
    stem_name = file.get("original_filename", "")
    item_tags = list(tags)
    if file.get("kind") == "stem" and "drums" in stem_name.lower():
        item_tags.append("drums")
    return AlignItem(file_id=file["id"], bpm=bpm, first_downbeat_s=float(first_db), tonic=tonic, mode=mode,
                     kind=file.get("kind") or "original", tags=item_tags)


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    layer_id = params.get("layer_id")
    if not layer_id:
        raise JobError("layer job needs params.layer_id")
    layers = db.select("layers", {"id": layer_id}, limit=1)
    if not layers:
        raise JobError(f"layer {layer_id} not found")
    layer = layers[0]
    if job.get("user_id") and layer.get("user_id") != job["user_id"]:
        raise JobError("layer does not belong to the job's user")
    items = sorted(db.select("layer_items", {"layer_id": layer_id}), key=lambda r: (r.get("position") or 0, str(r.get("created_at") or "")))
    if not items:
        raise JobError("the layer has no items")

    ctx.progress(0.05, "download")
    files: list[dict] = []
    audio: list[tuple[np.ndarray, int]] = []
    for it in items:
        f, y, sr = load_file_audio(db, ctx, it["file_id"], layer.get("user_id"))
        files.append(f)
        audio.append((y, sr))
    tags_by_file = {f["id"]: [t["tag"] for t in db.select("tags", {"file_id": f["id"]})] for f in files}
    align_items = [_align_item(f, tags_by_file[f["id"]]) for f in files]
    target_key = None
    if isinstance(layer.get("key"), dict) and layer["key"].get("tonic"):
        target_key = (layer["key"]["tonic"], layer["key"].get("mode") or "minor")
    plan = plan_alignment(align_items, target_bpm=layer.get("tempo_bpm"), target_key=target_key)

    ctx.progress(0.2, "align")
    lanes: list[Lane] = []
    applied: list[dict] = []
    import librosa

    for it, f, (y, sr), ip in zip(items, files, audio, plan.items):
        at_defaults = (float(it.get("stretch_ratio", 1) or 1) == 1.0 and float(it.get("pitch_semitones", 0) or 0) == 0.0
                       and float(it.get("offset_s", 0) or 0) == 0.0)
        if params.get("apply_plan", True) and at_defaults:
            chosen = ip
            db.update_rows("layer_items", {"id": it["id"]}, {"stretch_ratio": ip.stretch_ratio,
                                                             "pitch_semitones": ip.pitch_semitones,
                                                             "offset_s": ip.offset_s})
        else:
            chosen = ItemPlan(file_id=f["id"], stretch_ratio=float(it.get("stretch_ratio") or 1.0),
                              pitch_semitones=float(it.get("pitch_semitones") or 0.0),
                              offset_s=float(it.get("offset_s") or 0.0), reason="user values")
        if sr != RENDER_SR:
            y = np.stack([librosa.resample(ch, orig_sr=sr, target_sr=RENDER_SR) for ch in y]).astype(np.float32)
        y = apply_plan(y, RENDER_SR, chosen, mode=str(it.get("stretch_mode") or "transient"))
        filt = it.get("filter") if isinstance(it.get("filter"), dict) else {}
        lanes.append(Lane(y=y, offset_s=chosen.offset_s, gain_db=float(it.get("gain_db") or 0.0),
                          muted=bool(it.get("muted", False)), highpass_hz=filt.get("highpass_hz"),
                          lowpass_hz=filt.get("lowpass_hz"), name=f.get("original_filename", "")))
        applied.append({"item_id": it["id"], "file_id": f["id"], "stretch_ratio": chosen.stretch_ratio,
                        "pitch_semitones": chosen.pitch_semitones, "offset_s": chosen.offset_s, "reason": chosen.reason})

    ctx.progress(0.6, "render")
    out = render_layer(lanes, RENDER_SR)
    if out.shape[1] == 0:
        raise JobError("the render is empty (every lane muted or offset past the end)")
    name = (layer.get("name") or "layer").strip() or "layer"
    ctx.progress(0.8, "write")
    row = write_wav_file(db, storage, ctx, user_id=layer["user_id"], parent=files[0], y=out, sr=RENDER_SR,
                         storage_path=f"derived/{layer['user_id']}/{layer_id}/layer.wav",
                         filename=f"{name}_{round(plan.target_bpm)}bpm.wav", kind="layer_render")
    patch = {"render_file_id": row["id"]}
    if not layer.get("tempo_bpm"):
        patch["tempo_bpm"] = plan.target_bpm
    if not layer.get("key") and plan.target_tonic:
        patch["key"] = {"tonic": plan.target_tonic, "mode": plan.target_mode}
    db.update_rows("layers", {"id": layer_id}, patch)
    analyze = queue_analyze(db, ctx, layer["user_id"], row["id"])
    return {"layer_id": layer_id, "render_file_id": row["id"], "analyze_job_id": analyze["id"],
            "plan": plan.to_json(), "applied": applied, "sample_rate": RENDER_SR}


__all__ = ["run"]
