"""Storage: bucket-relative keys only (never a URL), LocalStorage round trips, Supabase REST calls."""

from __future__ import annotations

import json
import os

import pytest

from lockedgroove.storage import LocalStorage, StorageError, SupabaseStorage, content_type_for, validate_path


@pytest.mark.parametrize("path", [
    "https://example.com/song.mp3", "http://x/y.wav", "file:///tmp/x.wav", "s3://bucket/x.wav",
    "/library/u/ab/abc.wav", "library/../derived/u/x.wav", "library//u/x.wav", "", "./x.wav",
])
def test_validate_path_rejects_urls_absolute_and_dot_segments(path):
    with pytest.raises(StorageError):
        validate_path(path)


def test_validate_path_accepts_bucket_keys():
    assert validate_path("library/u/ab/abcd.wav") == "library/u/ab/abcd.wav"
    assert validate_path("derived/u/f/loops/l.wav") == "derived/u/f/loops/l.wav"


def test_content_types():
    assert content_type_for("x.wav") == "audio/wav"
    assert content_type_for("x.mp3") == "audio/mpeg"
    assert content_type_for("x.mid") == "audio/midi"
    assert content_type_for("x.unknownext") == "application/octet-stream"


def test_local_storage_round_trip(tmp_path):
    storage = LocalStorage(tmp_path / "bucket")
    src = tmp_path / "in.wav"
    src.write_bytes(b"RIFFdata")
    storage.upload("library/u/ab/abc.wav", str(src), "audio/wav")
    assert storage.exists("library/u/ab/abc.wav")
    local = storage.download("library/u/ab/abc.wav")
    try:
        assert local != str(src) and local.endswith(".wav")
        assert open(local, "rb").read() == b"RIFFdata"
    finally:
        os.remove(local)
    url = storage.signed_url("library/u/ab/abc.wav", expires_s=600)
    assert url.startswith("file://") and "expires=" in url
    storage.delete("library/u/ab/abc.wav")
    assert not storage.exists("library/u/ab/abc.wav")
    storage.delete("library/u/ab/abc.wav")  # idempotent
    with pytest.raises(StorageError, match="not found"):
        storage.download("library/u/ab/abc.wav")
    with pytest.raises(StorageError):
        storage.download("../outside.wav")


def _mock_storage(handler):
    import httpx

    client = httpx.Client(transport=httpx.MockTransport(handler),
                          headers={"apikey": "svc", "Authorization": "Bearer svc"})
    return SupabaseStorage("https://proj.supabase.co", "svc", client=client)


def test_supabase_storage_requests(tmp_path):
    import httpx

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if request.method == "GET" and path == "/storage/v1/object/audio/library/u/ab/abc.wav":
            return httpx.Response(200, content=b"RIFFbytes")
        if request.method == "GET":
            return httpx.Response(404, json={"error": "not found"})
        if request.method == "POST" and path == "/storage/v1/object/audio/derived/u/f/loops/l.wav":
            assert request.headers["x-upsert"] == "true"
            assert request.headers["content-type"] == "audio/wav"
            assert request.read() == b"WAVE"
            return httpx.Response(200, json={"Key": "audio/derived/u/f/loops/l.wav"})
        if request.method == "POST" and path == "/storage/v1/object/sign/audio/library/u/ab/abc.wav":
            assert json.loads(request.content) == {"expiresIn": 600}
            return httpx.Response(200, json={"signedURL": "/object/sign/audio/library/u/ab/abc.wav?token=T"})
        if request.method == "DELETE":
            return httpx.Response(200, json={"message": "Successfully deleted"})
        return httpx.Response(500, text="unexpected")

    storage = _mock_storage(handler)
    local = storage.download("library/u/ab/abc.wav")
    try:
        assert local.endswith(".wav") and open(local, "rb").read() == b"RIFFbytes"
    finally:
        os.remove(local)
    assert seen[0].headers["authorization"] == "Bearer svc" and seen[0].headers["apikey"] == "svc"

    with pytest.raises(StorageError, match="not found"):
        storage.download("library/u/ab/missing.wav")

    out = tmp_path / "l.wav"
    out.write_bytes(b"WAVE")
    storage.upload("derived/u/f/loops/l.wav", str(out), "audio/wav")

    url = storage.signed_url("library/u/ab/abc.wav", expires_s=600)
    assert url == "https://proj.supabase.co/storage/v1/object/sign/audio/library/u/ab/abc.wav?token=T"

    storage.delete("derived/u/f/loops/l.wav")
    assert seen[-1].method == "DELETE" and seen[-1].url.path == "/storage/v1/object/audio/derived/u/f/loops/l.wav"

    with pytest.raises(StorageError, match="URL"):
        storage.download("https://example.com/song.mp3")
