"""Every remaining job kind end to end over LocalStorage and the in-memory database."""

from __future__ import annotations

import sys
import types
import uuid

import numpy as np
import pytest
import soundfile as sf

from lockedgroove.db import InMemoryDatabase
from lockedgroove.embeddings.clap import set_embedder
from lockedgroove.ingest import sha256_file
from lockedgroove.jobs import run_job
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import (
    Pattern,
    chord_progression,
    drum_loop,
    hat,
    kick,
    silence,
    snare,
    to_stereo,
    triad,
)

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
from test_breakdown import full_report  # noqa: E402

USER = str(uuid.uuid4())
SR = 22050


def _grid_report(bpm: float, bars: int):
    r = full_report(bpm=bpm)
    beat = 60.0 / bpm
    times = [i * beat for i in range(bars * 4 + 1)]
    r.beats.times_s = times
    r.beats.downbeats_s = times[::4]
    r.file.duration_s = bars * 4 * beat
    return r


@pytest.fixture
def world(tmp_path):
    storage = LocalStorage(tmp_path / "bucket")
    db = InMemoryDatabase()

    def add_file(name: str, y: np.ndarray, report=None, sr: int = SR, kind: str = "original"):
        y2 = y if y.ndim == 2 else np.stack([y, y])
        wav = tmp_path / name
        sf.write(wav, y2.T, sr, subtype="PCM_16")
        sha = sha256_file(str(wav))
        path = f"library/{USER}/{sha[:2]}/{sha}.wav"
        storage.upload(path, str(wav))
        row = {"user_id": USER, "sha256": sha, "original_filename": name, "storage_path": path, "kind": kind,
               "status": "ready" if report is not None else "queued", "duration_s": y2.shape[1] / sr, "sample_rate": sr,
               "channels": 2}
        if report is not None:
            row["report"] = report.to_json_dict()
            row["analysis_version"] = 1
        return db.insert_file(row)

    def add_recording(name: str, y: np.ndarray) -> str:
        wav = tmp_path / name
        sf.write(wav, y, SR, subtype="PCM_16")
        path = f"library/{USER}/beatbox/{name}"
        storage.upload(path, str(wav))
        return path

    def job(job_kind: str, file_id=None, **params):
        return db.insert_job({"user_id": USER, "file_id": file_id, "kind": job_kind, "params": params})

    beat = to_stereo(drum_loop(90.0, 4, Pattern.boom_bap(), SR), width=0.2)
    beat_file = add_file("beat.wav", beat, _grid_report(90.0, 4))
    return types.SimpleNamespace(db=db, storage=storage, add_file=add_file, add_recording=add_recording, job=job,
                                 beat=beat_file)


def _queued_analyze(db, file_id):
    return [j for j in db.select("jobs", {"file_id": file_id, "kind": "analyze"}) if j["status"] == "queued"]


def test_stems_job_writes_stem_files_rows_and_analyze_jobs(world, monkeypatch):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_STEMS", "1")
    final = run_job(world.job("stems", world.beat["id"], model="htdemucs_ft")["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    assert final["result"]["fake"] is True and final["result"]["model"] == "htdemucs_ft-fake"
    stems = world.db.select("stems", {"file_id": world.beat["id"]})
    assert sorted(s["stem"] for s in stems) == ["bass", "drums", "other", "vocals"]
    for s in stems:
        f = world.db.get_file(s["stem_file_id"])
        assert f["kind"] == "stem" and f["parent_file_id"] == world.beat["id"] and f["status"] == "queued"
        assert world.storage.exists(f["storage_path"])
        assert _queued_analyze(world.db, f["id"])
    assert len(final["result"]["queued_job_ids"]) == 4
    # rerun replaces rows instead of duplicating them
    run_job(world.job("stems", world.beat["id"], model="htdemucs_ft")["id"], world.db, world.storage)
    assert len(world.db.select("stems", {"file_id": world.beat["id"]})) == 4


def test_chop_grid_transients_and_replace(world):
    final = run_job(world.job("chop", world.beat["id"], mode="grid", start_bar=0, end_bar=1, divisions=4)["id"],
                    world.db, world.storage)
    assert final["status"] == "done", final["error"]
    chops = world.db.select("chops", {"source_file_id": world.beat["id"]})
    assert len(chops) == 8 and final["result"]["count"] == 8
    first = world.db.get_file(chops[0]["chop_file_id"])
    assert first["kind"] == "chop" and first["parent_file_id"] == world.beat["id"]
    assert abs(first["duration_s"] - 60 / 90) < 0.01
    assert len(final["result"]["queued_job_ids"]) == 8
    final2 = run_job(world.job("chop", world.beat["id"], mode="transients", count=6)["id"], world.db, world.storage)
    assert final2["status"] == "done", final2["error"]
    chops = world.db.select("chops", {"source_file_id": world.beat["id"]})
    assert len(chops) == 6  # replaced
    assert world.db.get_file(first["id"]) is None  # old chop file removed
    bad = run_job(world.job("chop", world.beat["id"], mode="manual")["id"], world.db, world.storage)
    assert bad["status"] == "failed" and "markers_s" in bad["error"]


def test_midi_kinds(world):
    for kind in ("drums", "chords", "groove"):
        final = run_job(world.job("midi", world.beat["id"], kind=kind)["id"], world.db, world.storage)
        assert final["status"] == "done", (kind, final["error"])
        row = world.db.select("midi", {"id": final["result"]["midi_id"]})[0]
        assert row["kind"] == kind and row["notes"]["notes"] and world.storage.exists(row["storage_path"])
        if kind == "drums":
            assert any(n["cls"] == "kick" and n["step"] == 0 for n in row["notes"]["notes"])
            assert all("offset_ms" in n for n in row["notes"]["notes"])
        if kind == "groove":
            assert "template" in row["notes"]["meta"]
    try:
        import basic_pitch  # noqa: F401
    except ImportError:
        final = run_job(world.job("midi", world.beat["id"], kind="melody")["id"], world.db, world.storage)
        assert final["status"] == "failed" and "Basic Pitch" in final["error"]


def test_embed_job_with_fake_embedder(world, monkeypatch):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_EMBEDDER", "1")
    set_embedder(None)
    try:
        final = run_job(world.job("embed", world.beat["id"])["id"], world.db, world.storage)
    finally:
        set_embedder(None)
    assert final["status"] == "done", final["error"]
    emb = world.db.select("embeddings", {"file_id": world.beat["id"]})
    assert len(emb) == 1 and len(emb[0]["vector"]) == 512 and emb[0]["model"] == "hash-fake"
    tags = world.db.select("tags", {"file_id": world.beat["id"]})
    assert tags and all(t["source"] == "model" for t in tags)
    assert world.db.get_file(world.beat["id"])["report"]["tags"]


def test_layer_job_renders_and_applies_plan(world):
    sample = chord_progression([triad("F", "minor"), triad("G#", "major")] * 2, 4, 96.0, SR, repeats=1)
    sample_file = world.add_file("sample.wav", sample, _grid_report(96.0, 4))
    layer = world.db.insert_rows("layers", [{"user_id": USER, "name": "test layer"}])[0]
    world.db.insert_rows("layer_items", [
        {"user_id": USER, "layer_id": layer["id"], "file_id": world.beat["id"], "position": 0, "stretch_ratio": 1,
         "pitch_semitones": 0, "offset_s": 0, "gain_db": 0, "muted": False},
        {"user_id": USER, "layer_id": layer["id"], "file_id": sample_file["id"], "position": 1, "stretch_ratio": 1,
         "pitch_semitones": 0, "offset_s": 0, "gain_db": -6, "muted": False, "filter": {"lowpass_hz": 3000}},
    ])
    final = run_job(world.job("layer", None, layer_id=layer["id"])["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    render = world.db.get_file(final["result"]["render_file_id"])
    assert render["kind"] == "layer_render" and world.storage.exists(render["storage_path"])
    assert world.db.select("layers", {"id": layer["id"]})[0]["render_file_id"] == render["id"]
    assert final["result"]["plan"]["target_bpm"] == 90.0
    updated = {i["file_id"]: i for i in world.db.select("layer_items", {"layer_id": layer["id"]})}
    assert abs(updated[sample_file["id"]]["stretch_ratio"] - 90 / 96) < 1e-6
    assert _queued_analyze(world.db, render["id"])


def test_revoice_symbolic_with_edited_notes_and_neural_deferred(world):
    notes = [{"pitch": 60, "start_s": 0.0, "end_s": 0.5, "velocity": 100}, {"pitch": 64, "start_s": 0.6, "end_s": 1.0, "velocity": 90}]
    final = run_job(world.job("revoice", world.beat["id"], instrument="rhodes", path="symbolic", notes=notes,
                              keep_groove=True)["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    rv = world.db.select("revoices", {"id": final["result"]["revoice_id"]})[0]
    assert rv["instrument"] == "rhodes" and rv["path"] == "symbolic"
    render = world.db.get_file(rv["render_file_id"])
    assert render["kind"] == "revoice_render" and render["duration_s"] > 1.0
    midi = world.db.select("midi", {"id": rv["midi_id"]})[0]
    assert midi["notes"]["notes"][0]["pitch"] == 60
    neural = run_job(world.job("revoice", world.beat["id"], instrument="rhodes", path="neural")["id"], world.db, world.storage)
    assert neural["status"] == "failed" and "symbolic" in neural["error"]
    unknown = run_job(world.job("revoice", world.beat["id"], instrument="kazoo", path="symbolic")["id"], world.db, world.storage)
    assert unknown["status"] == "failed" and "kazoo" in unknown["error"]


def test_breakdown_job_queues_missing_and_versions(world):
    final = run_job(world.job("breakdown", world.beat["id"])["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    assert final["result"]["version"] == 1 and "stems" in final["result"]["requires"]
    assert "stems" in final["result"]["queued"]
    row = world.db.select("breakdowns", {"file_id": world.beat["id"]})[0]
    vitals = next(s for s in row["content"]["sections"] if s["key"] == "vitals")
    assert any("90 BPM" in f["text"] for f in vitals["facts"])
    again = run_job(world.job("breakdown", world.beat["id"])["id"], world.db, world.storage)
    assert again["result"]["version"] == 2 and "stems" not in again["result"]["queued"]  # already pending
    assert len([j for j in world.db.select("jobs", {"file_id": world.beat["id"], "kind": "stems"})]) == 1


def test_compare_job_writes_comparison(world):
    other = world.add_file("other.wav", to_stereo(drum_loop(92.0, 2, Pattern.four_on_floor(), SR)), _grid_report(92.0, 2))
    final = run_job(world.job("compare", None, file_a_id=world.beat["id"], file_b_id=other["id"])["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    row = world.db.select("comparisons", {"id": final["result"]["comparison_id"]})[0]
    assert row["file_a_id"] == world.beat["id"] and row["content"]["deltas"]
    unanalyzed = world.add_file("raw.wav", drum_loop(100.0, 1, Pattern.kick_on_one(), SR))
    bad = run_job(world.job("compare", None, file_a_id=world.beat["id"], file_b_id=unanalyzed["id"])["id"], world.db, world.storage)
    assert bad["status"] == "failed" and "analyzed" in bad["error"]


def _hits_recording(events, seed=0):
    rng = np.random.default_rng(seed)
    y = silence(max(t for t, _ in events) + 0.5, SR)
    for t, cls in events:
        smp = {"kick": lambda: kick(SR, brightness=rng.uniform(0, 0.1)), "snare": lambda: snare(SR, seed=int(rng.integers(1e6))),
               "hat": lambda: hat(SR, seed=int(rng.integers(1e6)))}[cls]()
        i = int(round(t * SR))
        y[i:i + len(smp)] += smp[: len(y) - i]
    return np.clip(y, -1, 1)


def test_beatbox_train_then_transcribe(world):
    examples = []
    for cls in ("kick", "snare", "hat"):
        rec = _hits_recording([(i * 0.4, cls) for i in range(20)], seed=hash(cls) % 1000)
        examples.append({"class": cls, "storage_path": world.add_recording(f"{cls}.wav", rec)})
    trained = run_job(world.job("beatbox_train", None, examples=examples)["id"], world.db, world.storage)
    assert trained["status"] == "done", trained["error"]
    assert trained["result"]["enabled"] and trained["result"]["cv_accuracy"] >= 0.85
    profile = world.db.select("beatbox_profiles", {"user_id": USER})[0]
    assert profile["enabled"] and world.storage.exists(profile["model_path"])
    step = 60 / 90 / 4
    pattern = [(0 * step, "kick"), (4 * step, "snare"), (8 * step, "kick"), (12 * step, "snare")] + [(s * step, "hat") for s in (2, 6, 10, 14)]
    rec_path = world.add_recording("pattern.wav", _hits_recording(pattern, seed=5))
    transcribed = run_job(world.job("beatbox_transcribe", None, recording_path=rec_path, grid_file_id=world.beat["id"])["id"],
                          world.db, world.storage)
    assert transcribed["status"] == "done", transcribed["error"]
    row = world.db.select("midi", {"id": transcribed["result"]["midi_id"]})[0]
    assert row["kind"] == "beatbox" and row["source_file_id"] == world.beat["id"]
    assert len(row["notes"]["hits"]) == 8 and row["notes"]["step_view"]
    rejected = run_job(world.job("beatbox_transcribe", None, recording_path=f"library/{uuid.uuid4()}/x.wav")["id"], world.db, world.storage)
    assert rejected["status"] == "failed"
