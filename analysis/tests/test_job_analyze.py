"""The ``analyze`` job end to end over LocalStorage and the in-memory database."""

from __future__ import annotations

import importlib.util
import sys
import types
import uuid

import numpy as np
import pytest
import soundfile as sf

from lockedgroove import ANALYSIS_VERSION
from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import sha256_file
from lockedgroove.jobs import analyze as analyze_job
from lockedgroove.jobs import run_job
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import Pattern, drum_loop, to_stereo

USER = str(uuid.uuid4())
SR = 22050


@pytest.fixture
def library(tmp_path):
    """LocalStorage with one synthetic stereo WAV under library/<user>/<ab>/<sha>.wav, plus its files row."""
    storage = LocalStorage(tmp_path / "bucket")
    y = to_stereo(drum_loop(90.0, 2, Pattern.boom_bap(), sr=SR), width=0.3)
    wav = tmp_path / "beat.wav"
    sf.write(wav, y.T, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    storage_path = f"library/{USER}/{sha[:2]}/{sha}.wav"
    storage.upload(storage_path, str(wav))
    db = InMemoryDatabase()
    file = db.insert_file({
        "user_id": USER, "sha256": sha, "original_filename": "beat.wav", "storage_path": storage_path,
        "size_bytes": wav.stat().st_size, "status": "queued",
    })
    return types.SimpleNamespace(db=db, storage=storage, file=file, duration_s=y.shape[1] / SR, sha=sha)


def _analyze_job(db, file, **params):
    return db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze", "params": params})


def test_analyze_writes_report_peaks_vitals_and_marks_ready(library):
    db, storage, file = library.db, library.storage, library.file
    job = _analyze_job(db, file)

    final = run_job(job["id"], db, storage)

    assert final["status"] == "done", final["error"]
    assert final["finished_at"] and final["started_at"]
    assert final["result"]["file_id"] == file["id"]
    assert final["result"]["skipped"] is False
    assert "truncated_to_s" not in final["result"]

    row = db.get_file(file["id"])
    assert row["status"] == "ready"
    assert row["analysis_version"] == ANALYSIS_VERSION
    assert row["report"]["schema_version"] == "3.0"
    assert row["report"]["analysis_version"] == ANALYSIS_VERSION
    assert row["report"]["file"]["id"] == file["id"]
    assert row["report"]["file"]["sha256"] == library.sha
    assert row["report"]["file"]["original_filename"] == "beat.wav"
    assert row["peaks"]["version"] == 1 and row["peaks"]["points"] == 2000
    assert len(row["peaks"]["min"]) == 2000 and len(row["peaks"]["max"]) == 2000
    assert max(row["peaks"]["max"]) > 0.3
    assert row["duration_s"] == pytest.approx(library.duration_s, abs=1e-3)
    assert row["sample_rate"] == SR and row["channels"] == 2 and row["format"] == "wav"
    # the status went through 'analyzing' on the way
    assert "analyzing" in [w["status"] for w in db.writes_to("files", "update")]


def test_second_run_is_skipped_as_idempotent(library):
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file)["id"], db, storage)
    writes_before = len(db.writes_to("files", "update"))

    final = run_job(_analyze_job(db, file, analysis_version=ANALYSIS_VERSION)["id"], db, storage)

    assert final["status"] == "done"
    assert final["result"]["skipped"] is True
    assert final["result"]["analysis_version"] == ANALYSIS_VERSION
    assert len(db.writes_to("files", "update")) == writes_before  # the file row was not touched
    assert db.get_file(file["id"])["status"] == "ready"


def test_newer_version_or_force_reanalyzes(library):
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file)["id"], db, storage)

    newer = run_job(_analyze_job(db, file, analysis_version=ANALYSIS_VERSION + 1)["id"], db, storage)
    assert newer["result"]["skipped"] is False
    assert db.get_file(file["id"])["analysis_version"] == ANALYSIS_VERSION + 1

    forced = run_job(_analyze_job(db, file, force=True)["id"], db, storage)
    assert forced["result"]["skipped"] is False


def test_download_failure_fails_job_and_file(library):
    db, storage = library.db, library.storage
    sha = "d" * 64
    missing = db.insert_file({"user_id": USER, "sha256": sha, "original_filename": "gone.wav",
                              "storage_path": f"library/{USER}/dd/{sha}.wav", "status": "queued"})
    final = run_job(_analyze_job(db, missing)["id"], db, storage)
    assert final["status"] == "failed"
    assert isinstance(final["error"], str) and "not found" in final["error"]
    assert final["finished_at"]
    assert db.get_file(missing["id"])["status"] == "failed"


def test_files_longer_than_the_cap_are_analyzed_on_their_head(library, monkeypatch):
    db, storage, file = library.db, library.storage, library.file
    monkeypatch.setattr(analyze_job, "MAX_ANALYSIS_S", 1.0)
    final = run_job(_analyze_job(db, file)["id"], db, storage)
    assert final["status"] == "done", final["error"]
    assert final["result"]["truncated_to_s"] == 1.0
    assert "first 0 minutes" in final["result"]["note"] or "minute" in final["result"]["note"]
    row = db.get_file(file["id"])
    assert row["duration_s"] == pytest.approx(library.duration_s, abs=1e-3)  # whole file
    assert row["report"]["file"]["duration_s"] == pytest.approx(library.duration_s, abs=1e-3)
    assert row["peaks"]["points"] == 2000


def test_user_edits_survive_reanalysis(library):
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file)["id"], db, storage)
    report = db.get_file(file["id"])["report"]
    report["user_edits"] = {**report["user_edits"], "tempo_bpm": 93.0, "key": {"tonic": "F", "mode": "minor"}}
    db.update_file(file["id"], {"report": report})

    run_job(_analyze_job(db, file, force=True)["id"], db, storage)

    edits = db.get_file(file["id"])["report"]["user_edits"]
    assert edits["tempo_bpm"] == 93.0 and edits["key"] == {"tonic": "F", "mode": "minor"}


def test_unknown_stage_fails_clearly(library):
    db, storage, file = library.db, library.storage, library.file
    final = run_job(_analyze_job(db, file, stages=["tempo", "vibes"])["id"], db, storage)
    assert final["status"] == "failed"
    assert "unknown stages" in final["error"]


def test_model_tags_are_upserted_and_stale_ones_removed(library, monkeypatch):
    from lockedgroove.report import Tag

    db, storage, file = library.db, library.storage, library.file
    tags = [Tag(tag="rhodes", confidence=0.8), Tag(tag="dusty", confidence=0.6)]
    fake = types.ModuleType("lockedgroove.analysis.tags")
    fake.run = lambda y, sr, ctx: list(tags)
    monkeypatch.setitem(sys.modules, "lockedgroove.analysis.tags", fake)
    db.insert_rows("tags", [{"user_id": USER, "file_id": file["id"], "tag": "keeper", "source": "user"}])

    final = run_job(_analyze_job(db, file, stages=["tags"])["id"], db, storage)
    assert final["status"] == "done", final["error"]
    assert len(final["result"]["tag_ids"]) == 2
    rows = db.select("tags", {"file_id": file["id"]})
    assert {(r["tag"], r["source"]) for r in rows} == {("rhodes", "model"), ("dusty", "model"), ("keeper", "user")}
    assert db.get_file(file["id"])["report"]["tags"][0]["tag"] == "rhodes"

    tags[:] = [Tag(tag="rhodes", confidence=0.9)]
    run_job(_analyze_job(db, file, stages=["tags"], force=True)["id"], db, storage)
    rows = db.select("tags", {"file_id": file["id"]})
    assert {(r["tag"], r["source"]) for r in rows} == {("rhodes", "model"), ("keeper", "user")}
    assert [r for r in rows if r["tag"] == "rhodes"][0]["confidence"] == pytest.approx(0.9)


# ---------------------------------------------------------------------------
# task: find_loops
# ---------------------------------------------------------------------------


def _fake_finder(monkeypatch, candidates):
    fake = types.ModuleType("lockedgroove.loops.finder")
    seen = {}

    def find_loops(y, sr, report, bars=None, top_k=12):
        seen.update(y_ndim=y.ndim, sr=sr, report=report, bars=bars, top_k=top_k)
        return candidates

    fake.find_loops = find_loops
    monkeypatch.setitem(sys.modules, "lockedgroove.loops.finder", fake)
    return seen


def test_find_loops_replaces_finder_rows_and_returns_ids(library, monkeypatch):
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file)["id"], db, storage)
    stale = db.insert_rows("loops", [
        {"user_id": USER, "file_id": file["id"], "start_s": 0.0, "end_s": 1.0, "origin": "finder", "bars": 1},
        {"user_id": USER, "file_id": file["id"], "start_s": 1.0, "end_s": 3.0, "origin": "user", "name": "mine"},
    ])
    seen = _fake_finder(monkeypatch, [
        {"start_s": 0.0, "end_s": 2.6667, "bars": 1, "score": np.float32(0.91),
         "components": {"seam": 0.9, "stability": np.float64(0.8)}},
        types.SimpleNamespace(start_s=2.6667, end_s=5.3333, bars=1, score=0.7, components=None),
    ])

    job = db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze",
                         "params": {"task": "find_loops", "bars": [1, 2], "top_k": 5}})
    final = run_job(job["id"], db, storage)

    assert final["status"] == "done", final["error"]
    assert seen["bars"] == [1, 2] and seen["top_k"] == 5 and seen["sr"] == SR and seen["y_ndim"] == 1
    assert seen["report"].schema_version == "3.0"
    assert final["result"]["count"] == 2 and final["result"]["replaced"] == 1
    rows = db.select("loops", {"file_id": file["id"]}, order="start_s.asc")
    assert [r["origin"] for r in rows] == ["finder", "user", "finder"]
    finder_rows = [r for r in rows if r["origin"] == "finder"]
    assert set(final["result"]["loop_ids"]) == {r["id"] for r in finder_rows}
    assert stale[0]["id"] not in {r["id"] for r in rows} and stale[1]["id"] in {r["id"] for r in rows}
    assert finder_rows[0]["name"] == "1 bar @ 0.0s" and finder_rows[1]["name"] == "1 bar @ 2.7s"
    assert finder_rows[0]["score"] == pytest.approx(0.91, abs=1e-3)
    assert finder_rows[0]["components"] == {"seam": 0.9, "stability": 0.8}
    assert db.get_file(file["id"])["status"] == "ready"


def test_find_loops_needs_a_report(library, monkeypatch):
    db, storage, file = library.db, library.storage, library.file
    _fake_finder(monkeypatch, [])
    job = db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze", "params": {"task": "find_loops"}})
    final = run_job(job["id"], db, storage)
    assert final["status"] == "failed" and "run analyze before find_loops" in final["error"]
    assert db.get_file(file["id"])["status"] == "queued"  # a secondary task never fails the file


@pytest.mark.skipif(importlib.util.find_spec("lockedgroove.loops.finder") is None,
                    reason="lockedgroove.loops.finder is not importable yet (Phase 1)")
def test_find_loops_with_the_real_finder(library):
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file)["id"], db, storage)
    if not (db.get_file(file["id"])["report"].get("beats") or {}).get("times_s"):
        pytest.skip("the beats stage has not landed; the finder needs a grid")
    job = db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze",
                         "params": {"task": "find_loops", "bars": [1, 2], "top_k": 4}})
    final = run_job(job["id"], db, storage)
    assert final["status"] == "done", final["error"]
    rows = db.select("loops", {"file_id": file["id"], "origin": "finder"})
    assert 0 < len(rows) <= 4 and set(final["result"]["loop_ids"]) == {r["id"] for r in rows}
    for r in rows:
        assert r["end_s"] > r["start_s"] and r["bars"] in (1, 2) and 0.0 <= r["score"] <= 1.0
        assert r["name"] and "seam" in r["components"]


def test_find_loops_without_the_finder_module_fails_clearly(library, monkeypatch):
    monkeypatch.setitem(sys.modules, "lockedgroove.loops.finder", None)  # import raises ModuleNotFoundError
    db, storage, file = library.db, library.storage, library.file
    db.update_file(file["id"], {"report": {"schema_version": "3.0"}, "status": "ready"})
    job = db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze", "params": {"task": "find_loops"}})
    final = run_job(job["id"], db, storage)
    assert final["status"] == "failed"
    assert "loop finder is not available yet" in final["error"] and "Phase 1" in final["error"]
