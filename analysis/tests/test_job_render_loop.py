"""The ``render_loop`` job: WAV out, files row in, loops.render_file_id set, analyze queued.

The DSP (``lockedgroove.loops.render``) arrives in Phase 1. The wiring is
tested with a stand-in renderer of the agreed signature; the same flow runs
against the real module once it is importable, and is skipped until then.
"""

from __future__ import annotations

import importlib.util
import sys
import types
import uuid

import numpy as np
import pytest
import soundfile as sf

from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import load_audio, sha256_file
from lockedgroove.jobs import run_job
from lockedgroove.jobs.render_loop import loop_filename
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import Pattern, drum_loop, to_stereo

USER = str(uuid.uuid4())
SR = 22050
HAVE_RENDER = importlib.util.find_spec("lockedgroove.loops.render") is not None


def _report(bpm=90.0, tonic="F", mode="minor"):
    return {
        "schema_version": "3.0", "analysis_version": 1,
        "file": {"duration_s": 5.0, "sample_rate": SR, "channels": 2},
        "tempo": {"bpm": bpm, "confidence": 0.9, "method": "librosa", "alternates_bpm": [bpm / 2, bpm * 2]},
        "key": {"tonic": tonic, "mode": mode, "confidence": 0.7, "method": "ks"},
        "tags": [], "user_edits": {},
    }


@pytest.fixture
def world(tmp_path):
    storage = LocalStorage(tmp_path / "bucket")
    y = to_stereo(drum_loop(90.0, 2, Pattern.boom_bap(), sr=SR), width=0.2)
    wav = tmp_path / "track.wav"
    sf.write(wav, y.T, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    storage_path = f"library/{USER}/{sha[:2]}/{sha}.wav"
    storage.upload(storage_path, str(wav))
    db = InMemoryDatabase()
    file = db.insert_file({"user_id": USER, "sha256": sha, "original_filename": "My Track.wav",
                           "storage_path": storage_path, "status": "ready", "analysis_version": 1,
                           "report": _report(), "duration_s": y.shape[1] / SR, "sample_rate": SR, "channels": 2})
    loop = db.insert_rows("loops", [{"user_id": USER, "file_id": file["id"], "start_s": 0.5, "end_s": 3.1667,
                                     "bars": 1, "origin": "user", "name": "1 bar @ 0.5s"}])[0]
    return types.SimpleNamespace(db=db, storage=storage, file=file, loop=loop)


def _install_fake_renderer(monkeypatch):
    fake = types.ModuleType("lockedgroove.loops.render")
    calls = {}

    def render_loop(y_stereo, sr, start_s, end_s, crossfade_ms=12.0, snap_zero_crossing=True):
        assert y_stereo.ndim == 2 and y_stereo.shape[0] == 2
        calls.update(sr=sr, start_s=start_s, end_s=end_s, crossfade_ms=crossfade_ms, snap=snap_zero_crossing)
        a, b = int(start_s * sr), int(end_s * sr)
        return y_stereo[:, a:b].astype(np.float32), {"start_s": start_s, "end_s": end_s,
                                                      "crossfade_ms": crossfade_ms, "snapped": snap_zero_crossing}

    def export_wav(path, y, sr, bit_depth=24):
        sf.write(path, np.asarray(y).T, sr, subtype={16: "PCM_16", 24: "PCM_24"}[bit_depth])

    fake.render_loop = render_loop
    fake.export_wav = export_wav
    monkeypatch.setitem(sys.modules, "lockedgroove.loops.render", fake)
    return calls


def _render_job(db, loop, **params):
    return db.insert_job({"user_id": USER, "file_id": loop["file_id"], "kind": "render_loop",
                          "params": {"loop_id": loop["id"], **params}})


def _assert_render_outcome(world, final, expect_meta=True):
    db, storage, file, loop = world.db, world.storage, world.file, world.loop
    assert final["status"] == "done", final["error"]
    result = final["result"]
    render_id = result["render_file_id"]
    storage_path = f"derived/{USER}/{file['id']}/loops/{loop['id']}.wav"
    assert result["storage_path"] == storage_path
    assert storage.exists(storage_path)

    render = db.get_file(render_id)
    assert render["kind"] == "loop_render" and render["parent_file_id"] == file["id"]
    assert render["status"] == "queued" and render["format"] == "wav" and render["channels"] == 2
    assert len(render["sha256"]) == 64 and render["user_id"] == USER
    assert render["original_filename"] == result["filename"] == "My-Track_90bpm_Fm_1bar.wav"

    local = storage.download(storage_path)
    info = sf.info(local)
    assert info.subtype == "PCM_24" and info.channels == 2 and info.samplerate == SR
    y, sr = load_audio(local)
    assert abs(y.shape[1] / sr - (loop["end_s"] - loop["start_s"])) < 0.05
    assert render["duration_s"] == pytest.approx(y.shape[1] / sr, abs=1e-3)
    assert sha256_file(local) == render["sha256"]

    assert db.select("loops", {"id": loop["id"]})[0]["render_file_id"] == render_id

    analyze = db.get_job(result["analyze_job_id"])
    assert analyze["kind"] == "analyze" and analyze["file_id"] == render_id and analyze["status"] == "queued"
    assert result["queued_job_ids"] == [analyze["id"]]
    if expect_meta:
        assert result["render"]["crossfade_ms"] == 12.0 and result["render"]["start_s"] == loop["start_s"]
    return render, analyze


def test_render_loop_with_stand_in_renderer(world, monkeypatch):
    calls = _install_fake_renderer(monkeypatch)
    final = run_job(_render_job(world.db, world.loop)["id"], world.db, world.storage)
    render, analyze = _assert_render_outcome(world, final)
    assert calls == {"sr": SR, "start_s": 0.5, "end_s": 3.1667, "crossfade_ms": 12.0, "snap": True}

    # the library entry gets its own analysis
    done = run_job(analyze["id"], world.db, world.storage)
    assert done["status"] == "done", done["error"]
    assert world.db.get_file(render["id"])["status"] == "ready"
    assert world.db.get_file(render["id"])["report"]["file"]["kind"] == "loop_render"


def test_render_params_reach_the_renderer(world, monkeypatch):
    calls = _install_fake_renderer(monkeypatch)
    job = _render_job(world.db, world.loop, crossfade_ms=30, snap_zero_crossing=False)
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    assert calls["crossfade_ms"] == 30.0 and calls["snap"] is False
    assert final["result"]["render"]["crossfade_ms"] == 30.0


def test_render_loop_rejects_missing_loop(world, monkeypatch):
    _install_fake_renderer(monkeypatch)
    job = world.db.insert_job({"user_id": USER, "kind": "render_loop", "params": {"loop_id": str(uuid.uuid4())}})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed" and "not found" in final["error"]


@pytest.mark.skipif(importlib.util.find_spec("lockedgroove.loops.naming") is None, reason="naming lands in Phase 1")
def test_loop_filename_uses_the_naming_module():
    src = {"original_filename": "Soul Sample #2.aiff", "report": _report(88.0, "A#", "major"), "kind": "original"}
    assert loop_filename(src, {"bars": 4, "start_s": 0.0, "end_s": 1.0}) == "Soul-Sample-#2_88bpm_Bb_4bar.wav"
    stem = {"original_filename": "drums.wav", "kind": "stem", "report": _report(93.4, "C", "minor")}
    assert loop_filename(stem, {"bars": 2, "start_s": 0.0, "end_s": 1.0},
                         parent={"original_filename": "song.mp3"}) == "song_drums_93.4bpm_Cm_2bar.wav"
    # bars missing on the row: derived from the effective tempo (90 bpm, 4/4 -> 2.667 s per bar)
    assert loop_filename({"original_filename": "t.wav", "report": _report()},
                         {"bars": None, "start_s": 1.0, "end_s": 6.3333}) == "t_90bpm_Fm_2bar.wav"


def test_loop_filename_fallback_without_the_naming_module(monkeypatch):
    monkeypatch.setitem(sys.modules, "lockedgroove.loops.naming", None)
    src = {"original_filename": "Soul Sample #2.aiff", "report": _report(88.0, "A#", "major"), "kind": "original"}
    assert loop_filename(src, {"bars": 4, "start_s": 0.0, "end_s": 1.0}) == "Soul-Sample-#2_88bpm_A#_4bar.wav"
    assert loop_filename({"original_filename": "raw.wav"}, {"bars": None, "start_s": 0.0, "end_s": 1.0}) == "raw.wav"
    stem = {"original_filename": "drums.wav", "kind": "stem", "report": _report(93.4, "C", "minor")}
    assert loop_filename(stem, {"bars": 2, "start_s": 0.0, "end_s": 1.0},
                         parent={"original_filename": "song.mp3"}) == "song_drums_93.4bpm_Cm_2bar.wav"


def test_render_loop_without_the_renderer_fails_clearly(world, monkeypatch):
    monkeypatch.setitem(sys.modules, "lockedgroove.loops.render", None)  # import raises ModuleNotFoundError
    final = run_job(_render_job(world.db, world.loop)["id"], world.db, world.storage)
    assert final["status"] == "failed"
    assert "loop renderer is not available yet" in final["error"] and "Phase 1" in final["error"]


@pytest.mark.skipif(not HAVE_RENDER, reason="lockedgroove.loops.render is not importable yet (Phase 1)")
def test_render_loop_with_the_real_renderer(world):
    pytest.importorskip("lockedgroove.loops.render")
    final = run_job(_render_job(world.db, world.loop)["id"], world.db, world.storage)
    render, analyze = _assert_render_outcome(world, final, expect_meta=False)
    assert world.db.get_file(render["id"])["status"] == "queued"
