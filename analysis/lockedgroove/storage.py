"""Object storage for the compute side: bucket ``audio``, private.

Paths are bucket-relative keys from docs/CONTRACTS.md section 2
(``library/{user_id}/{sha256[:2]}/{sha256}.{ext}`` for originals,
``derived/{user_id}/...`` for everything compute writes). A path is never a
URL: anything with a scheme, a leading slash, or ``..`` is rejected, so no
caller can smuggle an external location through here (principle 3).

``SupabaseStorage`` talks to the Storage REST API with the service role.
``LocalStorage`` keeps objects under a directory for tests and offline work.
"""

from __future__ import annotations

import mimetypes
import os
import shutil
import tempfile
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

DEFAULT_BUCKET = "audio"
SIGNED_URL_EXPIRY_S = 600  # 10 minutes (CONTRACTS section 2)


class StorageError(RuntimeError):
    """A storage request failed or the path is invalid."""


def validate_path(path: str) -> str:
    """Return ``path`` if it is a plain bucket-relative key, else raise ``StorageError``."""
    if not isinstance(path, str) or not path:
        raise StorageError("storage path must be a non-empty string")
    lowered = path.lower()
    if "://" in lowered or lowered.startswith(("http:", "https:", "ftp:", "file:", "data:", "s3:")):
        raise StorageError(f"storage path must be a bucket key, not a URL: {path!r}")
    if path.startswith(("/", "\\")):
        raise StorageError(f"storage path must be relative to the bucket: {path!r}")
    parts = path.replace("\\", "/").split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise StorageError(f"storage path contains an empty or dot segment: {path!r}")
    return path


def content_type_for(path: str, default: str = "application/octet-stream") -> str:
    ext = os.path.splitext(path)[1].lower()
    known = {
        ".wav": "audio/wav", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".flac": "audio/flac",
        ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
        ".oga": "audio/ogg", ".opus": "audio/opus", ".mid": "audio/midi", ".midi": "audio/midi",
        ".zip": "application/zip", ".json": "application/json", ".joblib": "application/octet-stream",
    }
    if ext in known:
        return known[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or default


def _temp_path_for(path: str) -> str:
    """A fresh temp file path that keeps the object's extension (decoders sniff it)."""
    suffix = os.path.splitext(path)[1] or ""
    fd, tmp = tempfile.mkstemp(prefix="lockedgroove-", suffix=suffix)
    os.close(fd)
    return tmp


@runtime_checkable
class Storage(Protocol):
    bucket: str

    def download(self, path: str) -> str:
        """Fetch the object to a local temp file and return its path. The caller deletes it."""
        ...

    def upload(self, path: str, local_path: str, content_type: str | None = None) -> None: ...

    def signed_url(self, path: str, expires_s: int = SIGNED_URL_EXPIRY_S) -> str: ...

    def delete(self, path: str) -> None: ...


# ---------------------------------------------------------------------------
# Supabase Storage
# ---------------------------------------------------------------------------


class SupabaseStorage:
    """Supabase Storage REST API with the service role key.

    * download: ``GET  /storage/v1/object/{bucket}/{path}`` streamed to a temp file
    * upload:   ``POST /storage/v1/object/{bucket}/{path}`` with ``x-upsert: true``
    * sign:     ``POST /storage/v1/object/sign/{bucket}/{path}`` ``{"expiresIn": s}``
    * delete:   ``DELETE /storage/v1/object/{bucket}/{path}``
    """

    def __init__(self, url: str, service_role_key: str, *, bucket: str = DEFAULT_BUCKET,
                 timeout_s: float = 300.0, client: Any = None) -> None:
        if not url or not service_role_key:
            raise StorageError("SupabaseStorage needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        import httpx

        self.url = url.rstrip("/")
        self.base = f"{self.url}/storage/v1"
        self.bucket = bucket
        headers = {"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"}
        self._client = client or httpx.Client(timeout=timeout_s, headers=headers, follow_redirects=True)
        self._own_client = client is None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, bucket: str = DEFAULT_BUCKET) -> SupabaseStorage:
        env = env if env is not None else os.environ
        return cls(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""), bucket=bucket)

    def close(self) -> None:
        if self._own_client:
            self._client.close()

    def _object_url(self, path: str) -> str:
        return f"{self.base}/object/{self.bucket}/{validate_path(path)}"

    def download(self, path: str) -> str:
        tmp = _temp_path_for(path)
        try:
            with self._client.stream("GET", self._object_url(path)) as resp:
                if resp.status_code == 404 or resp.status_code == 400:
                    raise StorageError(f"object not found in bucket {self.bucket!r}: {path}")
                if resp.status_code >= 400:
                    raise StorageError(f"download {path} -> {resp.status_code}: {resp.read()[:300]!r}")
                with open(tmp, "wb") as out:
                    for chunk in resp.iter_bytes(1 << 20):
                        out.write(chunk)
        except Exception:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        return tmp

    def upload(self, path: str, local_path: str, content_type: str | None = None) -> None:
        headers = {
            "x-upsert": "true",
            "Content-Type": content_type or content_type_for(path),
        }
        with open(local_path, "rb") as fh:
            resp = self._client.post(self._object_url(path), content=fh, headers=headers)
        if resp.status_code >= 400:
            raise StorageError(f"upload {path} -> {resp.status_code}: {resp.text[:300]}")

    def signed_url(self, path: str, expires_s: int = SIGNED_URL_EXPIRY_S) -> str:
        resp = self._client.post(f"{self.base}/object/sign/{self.bucket}/{validate_path(path)}",
                                 json={"expiresIn": int(expires_s)})
        if resp.status_code >= 400:
            raise StorageError(f"sign {path} -> {resp.status_code}: {resp.text[:300]}")
        signed = resp.json().get("signedURL") or resp.json().get("signedUrl")
        if not signed:
            raise StorageError(f"sign {path}: no signedURL in response")
        if signed.startswith("http"):
            return signed
        return f"{self.base}{signed if signed.startswith('/') else '/' + signed}"

    def delete(self, path: str) -> None:
        resp = self._client.delete(self._object_url(path))
        if resp.status_code >= 400 and resp.status_code != 404:
            raise StorageError(f"delete {path} -> {resp.status_code}: {resp.text[:300]}")


# ---------------------------------------------------------------------------
# Local directory
# ---------------------------------------------------------------------------


class LocalStorage:
    """Objects under ``root``; the same keys as the bucket. For tests and offline runs."""

    def __init__(self, root: str | os.PathLike, bucket: str = DEFAULT_BUCKET) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.bucket = bucket

    def _resolve(self, path: str) -> Path:
        target = (self.root / validate_path(path)).resolve()
        if self.root not in target.parents and target != self.root:
            raise StorageError(f"storage path escapes the root: {path!r}")
        return target

    def exists(self, path: str) -> bool:
        return self._resolve(path).is_file()

    def download(self, path: str) -> str:
        src = self._resolve(path)
        if not src.is_file():
            raise StorageError(f"object not found in bucket {self.bucket!r}: {path}")
        tmp = _temp_path_for(path)
        shutil.copyfile(src, tmp)
        return tmp

    def upload(self, path: str, local_path: str, content_type: str | None = None) -> None:
        dst = self._resolve(path)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(local_path, dst)

    def put_bytes(self, path: str, data: bytes) -> None:
        dst = self._resolve(path)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)

    def signed_url(self, path: str, expires_s: int = SIGNED_URL_EXPIRY_S) -> str:
        target = self._resolve(path)
        return f"file://{target}?expires={int(time.time()) + int(expires_s)}"

    def delete(self, path: str) -> None:
        target = self._resolve(path)
        if target.is_file():
            target.unlink()


__all__ = [
    "DEFAULT_BUCKET", "LocalStorage", "SIGNED_URL_EXPIRY_S", "Storage", "StorageError", "SupabaseStorage",
    "content_type_for", "validate_path",
]
