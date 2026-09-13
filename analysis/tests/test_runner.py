"""The job lifecycle (CONTRACTS section 4) independent of any real handler."""

from __future__ import annotations

import os
import sys
import types
import uuid

import pytest

from lockedgroove.db import InMemoryDatabase
from lockedgroove.jobs import KIND_PHASE, JobError, run_job
from lockedgroove.jobs.runner import assert_no_url_params, is_primary_analysis, resolve_handler
from lockedgroove.storage import LocalStorage

USER = str(uuid.uuid4())


@pytest.fixture
def db():
    return InMemoryDatabase()


@pytest.fixture
def storage(tmp_path):
    return LocalStorage(tmp_path / "bucket")


def _file(db, **over):
    sha = over.pop("sha", "c" * 64)
    row = {"user_id": USER, "sha256": sha, "original_filename": "song.wav",
           "storage_path": f"library/{USER}/{sha[:2]}/{sha}.wav", "status": "queued"}
    row.update(over)
    return db.insert_file(row)


def _fake_handler(monkeypatch, kind: str, fn):
    """Register ``fn`` as ``lockedgroove.jobs.<kind>.run`` for this test."""
    module = types.ModuleType(f"lockedgroove.jobs.{kind}")
    module.run = fn
    monkeypatch.setitem(sys.modules, f"lockedgroove.jobs.{kind}", module)
    return module


def test_phase_table_covers_every_job_kind():
    from lockedgroove.db import JOB_KINDS

    assert set(KIND_PHASE) == set(JOB_KINDS)
    assert KIND_PHASE["analyze"] == 0 and KIND_PHASE["render_loop"] == 1 and KIND_PHASE["stems"] == 2


def test_lifecycle_done(db, storage, monkeypatch):
    seen = {}

    def handler(job, _db, _storage, ctx):
        seen["running_row"] = _db.get_job(job["id"])
        seen["ctx"] = ctx
        ctx.progress(0.5, "halfway")
        assert os.path.isdir(ctx.workdir)
        return {"stem_ids": ["s1", "s2"]}

    _fake_handler(monkeypatch, "stems", handler)
    f = _file(db)
    job = db.insert_job({"user_id": USER, "file_id": f["id"], "kind": "stems", "params": {"model": "htdemucs_ft"}})

    final = run_job(job["id"], db, storage)

    assert seen["running_row"]["status"] == "running"
    assert seen["running_row"]["started_at"] and seen["running_row"]["error"] is None
    assert final["status"] == "done"
    assert final["result"] == {"stem_ids": ["s1", "s2"]}
    assert final["finished_at"] >= final["started_at"]
    assert final["progress"] == 1.0
    assert not os.path.exists(seen["ctx"].workdir)  # scratch is cleaned up
    assert db.get_file(f["id"])["status"] == "queued"  # not an analysis: file untouched


def test_lifecycle_failed_records_error_and_marks_primary_analysis_file(db, storage, monkeypatch):
    def handler(job, _db, _storage, ctx):
        raise RuntimeError("decoder exploded")

    _fake_handler(monkeypatch, "analyze", handler)
    f = _file(db)
    job = db.insert_job({"user_id": USER, "file_id": f["id"], "kind": "analyze"})

    final = run_job(job["id"], db, storage)

    assert final["status"] == "failed"
    assert final["error"] == "decoder exploded"
    assert final["finished_at"]
    assert db.get_file(f["id"])["status"] == "failed"


def test_failed_reanalysis_keeps_a_ready_file_ready(db, storage, monkeypatch):
    def handler(job, _db, _storage, ctx):
        _db.update_file(job["file_id"], {"status": "analyzing"})
        raise RuntimeError("new stage broke")

    _fake_handler(monkeypatch, "analyze", handler)
    f = _file(db, status="ready", report={"schema_version": "3.0"}, analysis_version=1)
    job = db.insert_job({"user_id": USER, "file_id": f["id"], "kind": "analyze", "params": {"analysis_version": 2}})
    final = run_job(job["id"], db, storage)
    assert final["status"] == "failed"
    assert db.get_file(f["id"])["status"] == "ready"


def test_failed_secondary_analysis_task_leaves_file_alone(db, storage, monkeypatch):
    def handler(job, _db, _storage, ctx):
        raise RuntimeError("finder broke")

    _fake_handler(monkeypatch, "analyze", handler)
    f = _file(db, status="ready", report={"schema_version": "3.0"})
    job = db.insert_job({"user_id": USER, "file_id": f["id"], "kind": "analyze", "params": {"task": "find_loops"}})
    assert not is_primary_analysis(job)
    run_job(job["id"], db, storage)
    assert db.get_file(f["id"])["status"] == "ready"


def test_not_implemented_kind_fails_with_phase_message(db, storage, monkeypatch):
    monkeypatch.setitem(sys.modules, "lockedgroove.jobs.chop", None)  # import raises ModuleNotFoundError
    job = db.insert_job({"user_id": USER, "kind": "chop", "params": {"mode": "grid", "count": 8}})
    final = run_job(job["id"], db, storage)
    assert final["status"] == "failed"
    assert final["error"] == "job kind chop is not implemented yet (arrives in Phase 3)"


def test_missing_dependency_inside_a_handler_is_not_mistaken_for_missing_kind(monkeypatch):
    import lockedgroove.jobs.runner as runner_module

    def import_module(name):
        assert name == "lockedgroove.jobs.embed"
        raise ModuleNotFoundError("No module named 'laion_clap'", name="laion_clap")

    monkeypatch.setattr(runner_module.importlib, "import_module", import_module)
    with pytest.raises(ModuleNotFoundError, match="laion_clap"):  # the real error, not "arrives in Phase 6"
        resolve_handler("embed")


def test_handler_module_without_run_is_reported(monkeypatch):
    monkeypatch.setitem(sys.modules, "lockedgroove.jobs.embed", types.ModuleType("lockedgroove.jobs.embed"))
    with pytest.raises(JobError, match="has no run"):
        resolve_handler("embed")


def test_unknown_kind_fails_clearly(db, storage, monkeypatch):
    with pytest.raises(JobError, match="unknown job kind 'teleport'"):
        resolve_handler("teleport")
    # the schema's check constraint stops such a row in Postgres; relax the mirror to reach the runner path
    monkeypatch.setitem(InMemoryDatabase._CHECKS, ("jobs", "kind"), ("teleport",))
    job = db.insert_job({"user_id": USER, "kind": "teleport"})
    final = run_job(job["id"], db, storage)
    assert final["status"] == "failed"
    assert "unknown job kind 'teleport'" in final["error"]


def test_missing_job_raises(db, storage):
    with pytest.raises(JobError, match="not found"):
        run_job(str(uuid.uuid4()), db, storage)


def test_done_job_is_not_run_again(db, storage, monkeypatch):
    calls = []
    _fake_handler(monkeypatch, "stems", lambda job, d, s, c: calls.append(job["id"]) or {})
    job = db.insert_job({"user_id": USER, "kind": "stems", "status": "done", "result": {"stem_ids": []}})
    final = run_job(job["id"], db, storage)
    assert final["status"] == "done" and calls == []


# ---------------------------------------------------------------------------
# principle 3: no URL ever enters a job
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("params", [
    {"url": "https://example.com/song.mp3"},
    {"URL": "https://example.com/song.mp3"},
    {"href": "x"},
    {"link": "x"},
    {"source_url": "x"},
    {"items": [{"file_id": "f", "download_link": "x"}]},
    {"nested": {"deeper": {"uri": "spotify:track:1"}}},
])
def test_url_params_are_rejected(params):
    with pytest.raises(JobError, match="principle 3"):
        assert_no_url_params(params)


def test_path_params_are_allowed():
    assert_no_url_params({"recording_path": "derived/u/beatbox/x.wav", "storage_path": "library/u/ab/abc.wav",
                          "examples": [{"class": "kick", "storage_path": "derived/u/beatbox/k1.wav"}]})


def test_runner_fails_url_jobs_for_every_kind(db, storage, monkeypatch):
    called = []
    for kind in KIND_PHASE:
        _fake_handler(monkeypatch, kind, lambda job, d, s, c: called.append(job["kind"]) or {})
    for kind in KIND_PHASE:
        job = db.insert_job({"user_id": USER, "kind": kind, "params": {"url": "https://youtu.be/xyz"}})
        final = run_job(job["id"], db, storage)
        assert final["status"] == "failed", kind
        assert "never a URL" in final["error"] and "principle 3" in final["error"]
    assert called == []  # no handler ever saw a URL job


# ---------------------------------------------------------------------------
# progress throttling and follow-up jobs
# ---------------------------------------------------------------------------


def test_progress_writes_are_throttled_to_one_per_two_seconds(db, storage, monkeypatch):
    now = [100.0]

    def handler(job, _db, _storage, ctx):
        for i in range(10):
            ctx.progress(i / 10, f"stage{i}")  # all within the same 2 s window
        now[0] += 2.5
        ctx.progress(0.95, "late")
        now[0] += 1.0
        ctx.progress(0.99, "too-soon")
        return {}

    _fake_handler(monkeypatch, "stems", handler)
    job = db.insert_job({"user_id": USER, "kind": "stems"})
    run_job(job["id"], db, storage, clock=lambda: now[0])
    progress_values = [w["progress"] for w in db.writes_to("jobs", "update") if "progress" in w]
    # running (0.0), first call (0.0), the one after 2.5 s (0.95), done (1.0)
    assert progress_values == [0.0, 0.0, 0.95, 1.0]


def test_follow_up_jobs_are_reported_and_dispatched(db, storage, monkeypatch):
    def handler(job, _db, _storage, ctx):
        child = _db.insert_job({"user_id": USER, "kind": "analyze", "file_id": job["file_id"]})
        ctx.queued_job_ids.append(child["id"])
        return {"stem_ids": ["x"]}

    _fake_handler(monkeypatch, "stems", handler)
    f = _file(db)
    job = db.insert_job({"user_id": USER, "file_id": f["id"], "kind": "stems"})
    dispatched = []
    final = run_job(job["id"], db, storage, on_queued=dispatched.append)
    assert final["result"]["stem_ids"] == ["x"]
    assert final["result"]["queued_job_ids"] == dispatched
    assert len(dispatched) == 1 and db.get_job(dispatched[0])["kind"] == "analyze"


def test_downloaded_temp_files_are_removed_after_the_job(db, storage, monkeypatch):
    storage.put_bytes("library/u/ab/abc.wav", b"RIFF")
    paths = []

    def handler(job, _db, _storage, ctx):
        local = ctx.download("library/u/ab/abc.wav")
        paths.append(local)
        assert open(local, "rb").read() == b"RIFF"
        return {}

    _fake_handler(monkeypatch, "stems", handler)
    job = db.insert_job({"user_id": USER, "kind": "stems"})
    run_job(job["id"], db, storage)
    assert paths and not os.path.exists(paths[0])
    assert storage.exists("library/u/ab/abc.wav")  # the object itself is untouched
