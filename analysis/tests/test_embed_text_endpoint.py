import pytest
from fastapi.testclient import TestClient

from lockedgroove.db import InMemoryDatabase
from lockedgroove.embeddings.clap import set_embedder
from lockedgroove.server import create_app
from lockedgroove.storage import LocalStorage

SECRET = "s3cret"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_EMBEDDER", "1")
    set_embedder(None)
    app = create_app(InMemoryDatabase(), LocalStorage(tmp_path), secret=SECRET, submit=lambda job_id, job=None: "x")
    yield TestClient(app)
    set_embedder(None)


def test_embed_text_requires_bearer(client):
    assert client.post("/embed_text", json={"texts": ["dusty soul"]}).status_code == 401


def test_embed_text_returns_vectors(client):
    r = client.post("/embed_text", json={"texts": ["dusty soul loop", "bright synth"]},
                    headers={"authorization": f"Bearer {SECRET}"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] and body["dim"] == 512 and len(body["vectors"]) == 2 and len(body["vectors"][0]) == 512
    assert body["model"] == "hash-fake"


def test_embed_text_validates_body(client):
    h = {"authorization": f"Bearer {SECRET}"}
    assert client.post("/embed_text", json={"texts": []}, headers=h).status_code == 400
    assert client.post("/embed_text", json={"texts": ["x" * 600]}, headers=h).status_code == 400
    assert client.post("/embed_text", json={"texts": ["a"] * 40}, headers=h).status_code == 400
