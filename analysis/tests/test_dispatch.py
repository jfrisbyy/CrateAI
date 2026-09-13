"""POST /dispatch and GET /health (CONTRACTS section 4 and 9) plus the pure Modal dispatch logic."""

from __future__ import annotations

import pathlib
import sys
import tomllib
import types
import uuid

import pytest
import soundfile as sf

from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import sha256_file
from lockedgroove.modal_app import (
    GPU_KINDS,
    PIP_BASE,
    PIP_COMPUTE,
    PIP_GPU,
    choose_runner,
    pip_packages,
    verify_bearer,
)
from lockedgroove.server import LocalRunner, build_from_env, create_app
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import click_track, to_stereo

USER = str(uuid.uuid4())
SECRET = "s3cret-dispatch-token"
SR = 22050


# ---------------------------------------------------------------------------
# pure functions used by the Modal dispatcher
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind,params,expected", [
    ("analyze", {}, "cpu"),
    ("render_loop", {"loop_id": "x"}, "cpu"),
    ("chop", {"mode": "grid"}, "cpu"),
    ("midi", {"kind": "melody"}, "cpu"),
    ("breakdown", {}, "cpu"),
    ("stems", {"model": "htdemucs_ft"}, "gpu"),
    ("embed", {}, "gpu"),
    ("beatbox_train", {"examples": []}, "gpu"),
    ("beatbox_transcribe", {"recording_path": "x"}, "cpu"),
    ("revoice", {"instrument": "guitar", "path": "symbolic"}, "cpu"),
    ("revoice", {"instrument": "guitar"}, "cpu"),
    ("revoice", {"instrument": "guitar", "path": "neural"}, "gpu"),
    ("revoice", {"instrument": "guitar", "path": "NEURAL"}, "gpu"),
])
def test_choose_runner(kind, params, expected):
    assert choose_runner(kind, params) == expected


def test_gpu_kinds_are_the_documented_set():
    assert GPU_KINDS == {"stems", "embed", "beatbox_train"}


@pytest.mark.parametrize("header,secret,ok", [
    (f"Bearer {SECRET}", SECRET, True),
    (f"bearer {SECRET}", SECRET, True),
    (f"Bearer   {SECRET}  ", SECRET, True),
    (None, SECRET, False),
    ("", SECRET, False),
    (f"Bearer {SECRET}x", SECRET, False),
    (f"Bearer {SECRET[:-1]}", SECRET, False),
    (SECRET, SECRET, False),  # no scheme
    (f"Basic {SECRET}", SECRET, False),
    ("Bearer", SECRET, False),
    (f"Bearer {SECRET}", None, False),  # fail closed when no secret is configured
    (f"Bearer {SECRET}", "", False),
])
def test_verify_bearer(header, secret, ok):
    assert verify_bearer(header, secret) is ok


def test_modal_pip_lists_mirror_pyproject():
    pyproject = pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text())
    assert PIP_BASE == data["project"]["dependencies"]
    compute = [d for d in data["project"]["optional-dependencies"]["compute"] if not d.startswith("modal")]
    assert PIP_COMPUTE == compute
    assert PIP_GPU == data["project"]["optional-dependencies"]["gpu"]
    assert pip_packages(gpu=False) == PIP_BASE + PIP_COMPUTE


def test_gpu_extras_toggle(monkeypatch):
    monkeypatch.delenv("LOCKEDGROOVE_GPU_EXTRAS", raising=False)
    assert pip_packages(gpu=True) == PIP_BASE + PIP_COMPUTE
    monkeypatch.setenv("LOCKEDGROOVE_GPU_EXTRAS", "1")
    assert pip_packages(gpu=True) == PIP_BASE + PIP_COMPUTE + PIP_GPU


def test_modal_app_module_declares_the_functions():
    pytest.importorskip("modal")
    import lockedgroove.modal_app as m

    assert m.app.name == "lockedgroove"
    for fn in (m.run_job_cpu, m.run_job_gpu, m.web):
        assert hasattr(fn, "spawn") and hasattr(fn, "remote"), fn  # modal.Function handles
    assert m.CPU_SPEC == {"cpu": 4, "memory": 8192, "timeout": 900}
    assert m.GPU_SPEC == {"gpu": "A10G", "timeout": 1800}


# ---------------------------------------------------------------------------
# the HTTP surface over the in-memory database and local storage
# ---------------------------------------------------------------------------


@pytest.fixture
def world(tmp_path):
    from fastapi.testclient import TestClient

    storage = LocalStorage(tmp_path / "bucket")
    y = to_stereo(click_track(120.0, 2.0, SR))
    wav = tmp_path / "clicks.wav"
    sf.write(wav, y.T, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    storage_path = f"library/{USER}/{sha[:2]}/{sha}.wav"
    storage.upload(storage_path, str(wav))

    db = InMemoryDatabase()
    file = db.insert_file({"user_id": USER, "sha256": sha, "original_filename": "clicks.wav",
                           "storage_path": storage_path, "status": "queued"})
    job = db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze"})
    runner = LocalRunner(db, storage, max_workers=2)
    app = create_app(db, storage, secret=SECRET, submit=runner.submit)
    client = TestClient(app)
    yield types.SimpleNamespace(db=db, storage=storage, file=file, job=job, runner=runner, client=client)
    runner.shutdown(wait=True)


def test_health(world):
    resp = world.client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["runner"] == "local"
    assert "analyze" in body["implemented_kinds"] and body["kind_phase"]["stems"] == 2


def test_dispatch_requires_bearer(world):
    resp = world.client.post("/dispatch", json={"job_id": world.job["id"]})
    assert resp.status_code == 401
    assert resp.json() == {"ok": False, "error": "unauthorized"}
    assert resp.headers["www-authenticate"] == "Bearer"
    assert world.db.get_job(world.job["id"])["status"] == "queued"


def test_dispatch_rejects_wrong_bearer(world):
    resp = world.client.post("/dispatch", json={"job_id": world.job["id"]},
                             headers={"authorization": "Bearer not-the-secret"})
    assert resp.status_code == 401
    assert world.db.get_job(world.job["id"])["status"] == "queued"


def test_dispatch_unknown_job_is_404(world):
    resp = world.client.post("/dispatch", json={"job_id": str(uuid.uuid4())},
                             headers={"authorization": f"Bearer {SECRET}"})
    assert resp.status_code == 404
    assert resp.json()["ok"] is False


def test_dispatch_bad_body_is_400(world):
    headers = {"authorization": f"Bearer {SECRET}"}
    assert world.client.post("/dispatch", json={}, headers=headers).status_code == 400
    assert world.client.post("/dispatch", content=b"not json", headers=headers).status_code == 400


def test_dispatch_runs_the_job(world):
    resp = world.client.post("/dispatch", json={"job_id": world.job["id"]},
                             headers={"authorization": f"Bearer {SECRET}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True and body["call_id"].startswith("local-")

    final = world.runner.wait(body["call_id"], timeout=120)
    assert final["status"] == "done", final["error"]
    job = world.db.get_job(world.job["id"])
    assert job["modal_call_id"] == body["call_id"]
    assert job["finished_at"]
    file = world.db.get_file(world.file["id"])
    assert file["status"] == "ready"
    assert file["report"]["schema_version"] == "3.0"
    assert file["peaks"]["points"] == 2000

    # dispatching a finished job again does not run it twice
    again = world.client.post("/dispatch", json={"job_id": world.job["id"]},
                              headers={"authorization": f"Bearer {SECRET}"})
    assert again.status_code == 200 and again.json()["already_done"] is True


def test_dispatch_runs_follow_up_jobs_created_by_a_handler(world, monkeypatch):
    def stems_handler(job, db, storage, ctx):
        child = db.insert_job({"user_id": USER, "file_id": job["file_id"], "kind": "analyze"})
        ctx.queued_job_ids.append(child["id"])
        return {"stem_ids": []}

    fake = types.ModuleType("lockedgroove.jobs.stems")
    fake.run = stems_handler
    monkeypatch.setitem(sys.modules, "lockedgroove.jobs.stems", fake)

    stems = world.db.insert_job({"user_id": USER, "file_id": world.file["id"], "kind": "stems"})
    resp = world.client.post("/dispatch", json={"job_id": stems["id"]},
                             headers={"authorization": f"Bearer {SECRET}"})
    assert resp.status_code == 200
    world.runner.wait(resp.json()["call_id"], timeout=120)
    world.runner.wait_all(timeout=120)
    children = world.db.select("jobs", {"kind": "analyze", "file_id": world.file["id"]})
    child = [c for c in children if c["id"] != world.job["id"]]
    assert len(child) == 1 and child[0]["status"] == "done", child
    assert child[0]["modal_call_id"].startswith("local-")
    assert world.db.get_file(world.file["id"])["status"] == "ready"


def test_local_runner_fails_loudly_without_configuration():
    with pytest.raises(SystemExit) as excinfo:
        build_from_env(env={})
    message = str(excinfo.value)
    assert "SUPABASE_URL" in message and "SUPABASE_SERVICE_ROLE_KEY" in message and "COMPUTE_DISPATCH_SECRET" in message
    assert ".env.example" in message
