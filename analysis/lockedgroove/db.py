"""Database access for the compute side.

Compute writes results with the service role (BUILD_PACKET section 3), so
everything here goes through PostgREST with the service key and bypasses RLS.
Nothing in this module reads a URL as an input to a job; the only network
target is the Supabase project named by ``SUPABASE_URL``.

Two implementations of the same ``Database`` protocol:

* ``SupabaseDatabase``: PostgREST over httpx.
* ``InMemoryDatabase``: dict-backed, for tests and the dispatch test client.
  It mirrors the defaults and check constraints of
  ``supabase/migrations/20260913000000_init.sql`` closely enough that a
  handler that passes against it also passes against Postgres.

Filters are ``{column: value}`` and mean equality; ``None`` means ``IS NULL``
and a list/tuple/set means ``IN (...)``.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, Protocol, runtime_checkable

log = logging.getLogger(__name__)

Filters = Mapping[str, Any]

JOB_KINDS = (
    "analyze", "stems", "chop", "midi", "embed", "render_loop", "layer",
    "revoice", "breakdown", "compare", "beatbox_train", "beatbox_transcribe",
    "export",
)
JOB_STATUSES = ("queued", "running", "done", "failed")
FILE_KINDS = ("original", "stem", "chop", "loop_render", "layer_render", "revoice_render")
FILE_STATUSES = ("uploading", "queued", "analyzing", "ready", "failed")
LOOP_ORIGINS = ("finder", "user", "chat")
TAG_SOURCES = ("model", "user")

# tables with an updated_at column maintained by a trigger in Postgres
_TABLES_WITH_UPDATED_AT = {"files", "layers", "conversations"}

# (user_id, sha256) is unique on files; the in-memory store enforces the same
_UNIQUE = {
    "files": [("user_id", "sha256")],
    "stems": [("file_id", "model", "stem")],
    "embeddings": [("file_id", "model")],
    "tags": [("file_id", "tag", "source")],
    "breakdowns": [("file_id", "version")],
    "beatbox_profiles": [("user_id",)],
}


class DatabaseError(RuntimeError):
    """A request to the database failed or a constraint was violated."""


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


@runtime_checkable
class Database(Protocol):
    """What the job runner and the handlers need from the database."""

    def get_job(self, job_id: str) -> dict | None: ...

    def update_job(self, job_id: str, patch: dict) -> dict: ...

    def insert_job(self, row: dict) -> dict: ...

    def get_file(self, file_id: str) -> dict | None: ...

    def update_file(self, file_id: str, patch: dict) -> dict: ...

    def insert_file(self, row: dict) -> dict:
        """Insert a ``files`` row; on conflict on ``(user_id, sha256)`` return the existing row."""
        ...

    def find_file(self, user_id: str, sha256: str) -> dict | None: ...

    def insert_rows(self, table: str, rows: list[dict]) -> list[dict]: ...

    def upsert_rows(self, table: str, rows: list[dict], on_conflict: str) -> list[dict]:
        """Insert or update on the comma-separated ``on_conflict`` columns (merge-duplicates)."""
        ...

    def update_rows(self, table: str, filters: Filters, patch: dict) -> list[dict]: ...

    def delete_rows(self, table: str, filters: Filters) -> int: ...

    def select(self, table: str, filters: Filters | None = None, limit: int | None = None,
               order: str | None = None) -> list[dict]: ...


# ---------------------------------------------------------------------------
# JSON safety: handlers hand us numpy scalars now and then; PostgREST cannot
# take them, and neither should the in-memory store.
# ---------------------------------------------------------------------------


def jsonable(value: Any) -> Any:
    """Convert numpy scalars/arrays, tuples, sets, pydantic and dataclass objects to plain JSON types."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Mapping):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(v) for v in value]
    if hasattr(value, "model_dump"):  # pydantic
        return jsonable(value.model_dump(mode="json"))
    if hasattr(value, "__dataclass_fields__"):
        return jsonable({k: getattr(value, k) for k in value.__dataclass_fields__})
    if hasattr(value, "tolist"):  # numpy scalar or array
        return jsonable(value.tolist())
    if hasattr(value, "item"):
        return jsonable(value.item())
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    return str(value)


def _assert_json(row: Mapping[str, Any], where: str) -> None:
    try:
        json.dumps(row)
    except (TypeError, ValueError) as exc:
        raise DatabaseError(f"{where}: row is not JSON-serializable ({exc}); wrap values with jsonable()") from exc


# ---------------------------------------------------------------------------
# Supabase / PostgREST
# ---------------------------------------------------------------------------


def _pg_literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _pg_in_literal(value: Any) -> str:
    text = str(value).replace('"', '\\"')
    return f'"{text}"'


def filters_to_params(filters: Filters | None) -> dict[str, str]:
    """``{"id": x, "origin": "finder", "parent": None, "kind": [..]}`` -> PostgREST query params."""
    params: dict[str, str] = {}
    for column, value in (filters or {}).items():
        if value is None:
            params[column] = "is.null"
        elif isinstance(value, (list, tuple, set, frozenset)):
            params[column] = "in.(" + ",".join(_pg_in_literal(v) for v in value) + ")"
        else:
            params[column] = "eq." + _pg_literal(value)
    return params


class SupabaseDatabase:
    """PostgREST client using the service role key.

    Every request carries ``apikey`` and ``Authorization: Bearer`` with the
    service role key and asks for ``return=representation`` so writers get the
    rows back (ids for ``jobs.result``).
    """

    def __init__(self, url: str, service_role_key: str, *, schema: str = "public",
                 timeout_s: float = 30.0, retries: int = 3, client: Any = None) -> None:
        if not url or not service_role_key:
            raise DatabaseError("SupabaseDatabase needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        import httpx

        self.url = url.rstrip("/")
        self.rest = f"{self.url}/rest/v1"
        self.retries = max(1, retries)
        headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if schema != "public":
            headers["Accept-Profile"] = schema
            headers["Content-Profile"] = schema
        self._client = client or httpx.Client(timeout=timeout_s, headers=headers)
        self._own_client = client is None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> SupabaseDatabase:
        env = env if env is not None else os.environ
        return cls(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_ROLE_KEY", ""))

    def close(self) -> None:
        if self._own_client:
            self._client.close()

    # -- transport ---------------------------------------------------------

    def _request(self, method: str, table: str, *, params: dict | None = None,
                 json_body: Any = None, prefer: str | None = None) -> Any:
        import httpx

        headers = {"Prefer": prefer} if prefer else {}
        last_exc: Exception | None = None
        for attempt in range(self.retries):
            try:
                resp = self._client.request(method, f"{self.rest}/{table}", params=params,
                                            json=json_body, headers=headers)
            except httpx.TransportError as exc:  # connection reset, timeout, dns
                last_exc = exc
                time.sleep(0.5 * (2 ** attempt))
                continue
            if resp.status_code >= 500 and attempt < self.retries - 1:
                last_exc = DatabaseError(f"{method} {table} -> {resp.status_code}: {resp.text[:300]}")
                time.sleep(0.5 * (2 ** attempt))
                continue
            if resp.status_code >= 400:
                raise DatabaseError(f"{method} {table} -> {resp.status_code}: {resp.text[:500]}")
            if resp.status_code == 204 or not resp.content:
                return []
            return resp.json()
        raise DatabaseError(f"{method} {table} failed after {self.retries} attempts: {last_exc}")

    @staticmethod
    def _rows(payload: Any) -> list[dict]:
        if payload is None:
            return []
        if isinstance(payload, dict):
            return [payload]
        return list(payload)

    @staticmethod
    def _require_filters(filters: Filters | None, op: str) -> dict[str, str]:
        params = filters_to_params(filters)
        if not params:
            raise DatabaseError(f"refusing to {op} without filters (would touch the whole table)")
        return params

    # -- generic -----------------------------------------------------------

    def select(self, table: str, filters: Filters | None = None, limit: int | None = None,
               order: str | None = None, columns: str = "*") -> list[dict]:
        params = {"select": columns, **filters_to_params(filters)}
        if limit is not None:
            params["limit"] = str(int(limit))
        if order:
            params["order"] = order
        return self._rows(self._request("GET", table, params=params))

    def insert_rows(self, table: str, rows: list[dict]) -> list[dict]:
        if not rows:
            return []
        body = [jsonable(r) for r in rows]
        return self._rows(self._request("POST", table, json_body=body, prefer="return=representation"))

    def upsert_rows(self, table: str, rows: list[dict], on_conflict: str) -> list[dict]:
        if not rows:
            return []
        body = [jsonable(r) for r in rows]
        return self._rows(self._request(
            "POST", table, params={"on_conflict": on_conflict}, json_body=body,
            prefer="resolution=merge-duplicates,return=representation"))

    def update_rows(self, table: str, filters: Filters, patch: dict) -> list[dict]:
        params = self._require_filters(filters, "update")
        return self._rows(self._request("PATCH", table, params=params, json_body=jsonable(patch),
                                        prefer="return=representation"))

    def delete_rows(self, table: str, filters: Filters) -> int:
        params = self._require_filters(filters, "delete")
        return len(self._rows(self._request("DELETE", table, params=params, prefer="return=representation")))

    # -- jobs and files ------------------------------------------------------

    def get_job(self, job_id: str) -> dict | None:
        rows = self.select("jobs", {"id": job_id}, limit=1)
        return rows[0] if rows else None

    def update_job(self, job_id: str, patch: dict) -> dict:
        rows = self.update_rows("jobs", {"id": job_id}, patch)
        if not rows:
            raise DatabaseError(f"job {job_id} not found")
        return rows[0]

    def insert_job(self, row: dict) -> dict:
        return self.insert_rows("jobs", [row])[0]

    def get_file(self, file_id: str) -> dict | None:
        rows = self.select("files", {"id": file_id}, limit=1)
        return rows[0] if rows else None

    def update_file(self, file_id: str, patch: dict) -> dict:
        rows = self.update_rows("files", {"id": file_id}, patch)
        if not rows:
            raise DatabaseError(f"file {file_id} not found")
        return rows[0]

    def find_file(self, user_id: str, sha256: str) -> dict | None:
        rows = self.select("files", {"user_id": user_id, "sha256": sha256}, limit=1)
        return rows[0] if rows else None

    def insert_file(self, row: dict) -> dict:
        # ON CONFLICT (user_id, sha256) DO NOTHING; PostgREST returns only the
        # rows it inserted, so an empty result means the row already existed.
        inserted = self._rows(self._request(
            "POST", "files", params={"on_conflict": "user_id,sha256"}, json_body=[jsonable(row)],
            prefer="resolution=ignore-duplicates,return=representation"))
        if inserted:
            return inserted[0]
        existing = self.find_file(row["user_id"], row["sha256"])
        if existing is None:
            raise DatabaseError("insert_file: conflict reported but the existing row was not found")
        return existing


# ---------------------------------------------------------------------------
# In-memory (tests, local dispatch tests)
# ---------------------------------------------------------------------------


def _matches(row: Mapping[str, Any], filters: Filters | None) -> bool:
    for column, value in (filters or {}).items():
        actual = row.get(column)
        if value is None:
            if actual is not None:
                return False
        elif isinstance(value, (list, tuple, set, frozenset)):
            if actual not in value:
                return False
        elif actual != value:
            return False
    return True


class InMemoryDatabase:
    """Dict-backed ``Database`` with the schema's defaults and check constraints.

    Rows are deep-copied on the way in and out so callers cannot mutate the
    store by accident. ``self.writes`` logs every write as
    ``(op, table, payload)`` for assertions in tests. Thread-safe.
    """

    _DEFAULTS: dict[str, dict[str, Any]] = {
        "files": {"kind": "original", "status": "uploading", "analysis_version": 0, "report": None,
                  "peaks": None, "parent_file_id": None, "title": None, "artist": None},
        "jobs": {"status": "queued", "params": {}, "result": None, "error": None, "modal_call_id": None,
                 "progress": None, "started_at": None, "finished_at": None, "file_id": None},
        "loops": {"origin": "finder", "bars": None, "score": None, "components": None, "name": None,
                  "render_file_id": None},
        "tags": {"source": "model", "confidence": 1.0},
        "layers": {"name": None, "tempo_bpm": None, "key": None, "render_file_id": None},
        "breakdowns": {"version": 1, "web_context": None, "narration": None},
    }
    _REQUIRED: dict[str, tuple[str, ...]] = {
        "files": ("user_id", "sha256", "original_filename", "storage_path"),
        "jobs": ("user_id", "kind"),
        "loops": ("user_id", "file_id", "start_s", "end_s"),
        "tags": ("user_id", "file_id", "tag"),
        "stems": ("user_id", "file_id", "stem", "model", "stem_file_id"),
        "chops": ("user_id", "source_file_id", "start_s", "end_s", "index"),
        "midi": ("user_id", "kind", "storage_path"),
        "embeddings": ("user_id", "file_id", "model", "vector"),
    }
    _CHECKS: dict[tuple[str, str], tuple[str, ...]] = {
        ("files", "kind"): FILE_KINDS,
        ("files", "status"): FILE_STATUSES,
        ("jobs", "kind"): JOB_KINDS,
        ("jobs", "status"): JOB_STATUSES,
        ("loops", "origin"): LOOP_ORIGINS,
        ("tags", "source"): TAG_SOURCES,
        ("midi", "kind"): ("melody", "drums", "chords", "beatbox", "groove"),
        ("revoices", "path"): ("symbolic", "neural"),
    }

    def __init__(self) -> None:
        self.tables: dict[str, dict[str, dict]] = {}
        self.writes: list[tuple[str, str, Any]] = []
        self._lock = threading.RLock()

    # -- helpers -------------------------------------------------------------

    def _table(self, name: str) -> dict[str, dict]:
        return self.tables.setdefault(name, {})

    def _validate(self, table: str, row: Mapping[str, Any], *, inserting: bool) -> None:
        if inserting:
            for col in self._REQUIRED.get(table, ()):
                if row.get(col) is None:
                    raise DatabaseError(f"{table}.{col} is required")
        for (t, col), allowed in self._CHECKS.items():
            if t == table and col in row and row[col] is not None and row[col] not in allowed:
                raise DatabaseError(f"{table}.{col} = {row[col]!r} violates check ({', '.join(allowed)})")
        if table == "tags" and "confidence" in row and not (0 <= float(row["confidence"]) <= 1):
            raise DatabaseError("tags.confidence must be in [0, 1]")
        if table == "loops" and row.get("start_s") is not None and row.get("end_s") is not None:
            if not float(row["end_s"]) > float(row["start_s"]):
                raise DatabaseError("loops: end_s must be > start_s")

    def _check_unique(self, table: str, row: Mapping[str, Any], *, exclude_id: str | None = None) -> None:
        for cols in _UNIQUE.get(table, []):
            if any(row.get(c) is None for c in cols):
                continue
            for other in self._table(table).values():
                if other["id"] == exclude_id:
                    continue
                if all(other.get(c) == row.get(c) for c in cols):
                    raise DatabaseError(f"{table}: duplicate key on ({', '.join(cols)})")

    def _new_row(self, table: str, row: Mapping[str, Any]) -> dict:
        full = dict(self._DEFAULTS.get(table, {}))
        full.update(jsonable(dict(row)))
        full.setdefault("id", str(uuid.uuid4()))
        full.setdefault("created_at", now_iso())
        if table in _TABLES_WITH_UPDATED_AT:
            full.setdefault("updated_at", full["created_at"])
        _assert_json(full, f"insert into {table}")
        self._validate(table, full, inserting=True)
        return full

    def _find_conflict(self, table: str, row: Mapping[str, Any], cols: list[str]) -> dict | None:
        for other in self._table(table).values():
            if all(other.get(c) == row.get(c) for c in cols):
                return other
        return None

    # -- generic -----------------------------------------------------------

    def select(self, table: str, filters: Filters | None = None, limit: int | None = None,
               order: str | None = None) -> list[dict]:
        with self._lock:
            rows = [copy.deepcopy(r) for r in self._table(table).values() if _matches(r, filters)]
        if order:
            col, _, direction = order.partition(".")
            rows.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=(direction == "desc"))
        if limit is not None:
            rows = rows[: int(limit)]
        return rows

    def insert_rows(self, table: str, rows: list[dict]) -> list[dict]:
        out: list[dict] = []
        with self._lock:
            for row in rows:
                full = self._new_row(table, row)
                self._check_unique(table, full)
                self._table(table)[full["id"]] = full
                self.writes.append(("insert", table, copy.deepcopy(full)))
                out.append(copy.deepcopy(full))
        return out

    def upsert_rows(self, table: str, rows: list[dict], on_conflict: str) -> list[dict]:
        cols = [c.strip() for c in on_conflict.split(",") if c.strip()]
        out: list[dict] = []
        with self._lock:
            for row in rows:
                probe = dict(self._DEFAULTS.get(table, {}))  # defaults take part in the conflict match
                probe.update(jsonable(dict(row)))
                existing = self._find_conflict(table, probe, cols)
                if existing is None:
                    out.extend(self.insert_rows(table, [row]))
                    continue
                patch = jsonable(dict(row))
                patch.pop("id", None)
                existing.update(patch)
                if table in _TABLES_WITH_UPDATED_AT:
                    existing["updated_at"] = now_iso()
                self._validate(table, existing, inserting=False)
                self.writes.append(("upsert", table, copy.deepcopy(existing)))
                out.append(copy.deepcopy(existing))
        return out

    def update_rows(self, table: str, filters: Filters, patch: dict) -> list[dict]:
        if not filters:
            raise DatabaseError("refusing to update without filters (would touch the whole table)")
        patch = jsonable(dict(patch))
        _assert_json(patch, f"update {table}")
        out: list[dict] = []
        with self._lock:
            for row in self._table(table).values():
                if not _matches(row, filters):
                    continue
                candidate = {**row, **patch}
                self._validate(table, candidate, inserting=False)
                self._check_unique(table, candidate, exclude_id=row["id"])
                row.update(patch)
                if table in _TABLES_WITH_UPDATED_AT:
                    row["updated_at"] = now_iso()
                self.writes.append(("update", table, copy.deepcopy(row)))
                out.append(copy.deepcopy(row))
        return out

    def delete_rows(self, table: str, filters: Filters) -> int:
        if not filters:
            raise DatabaseError("refusing to delete without filters (would touch the whole table)")
        with self._lock:
            store = self._table(table)
            doomed = [rid for rid, row in store.items() if _matches(row, filters)]
            for rid in doomed:
                self.writes.append(("delete", table, store.pop(rid)))
        return len(doomed)

    # -- jobs and files ------------------------------------------------------

    def get_job(self, job_id: str) -> dict | None:
        rows = self.select("jobs", {"id": job_id}, limit=1)
        return rows[0] if rows else None

    def update_job(self, job_id: str, patch: dict) -> dict:
        rows = self.update_rows("jobs", {"id": job_id}, patch)
        if not rows:
            raise DatabaseError(f"job {job_id} not found")
        return rows[0]

    def insert_job(self, row: dict) -> dict:
        return self.insert_rows("jobs", [row])[0]

    def get_file(self, file_id: str) -> dict | None:
        rows = self.select("files", {"id": file_id}, limit=1)
        return rows[0] if rows else None

    def update_file(self, file_id: str, patch: dict) -> dict:
        rows = self.update_rows("files", {"id": file_id}, patch)
        if not rows:
            raise DatabaseError(f"file {file_id} not found")
        return rows[0]

    def find_file(self, user_id: str, sha256: str) -> dict | None:
        rows = self.select("files", {"user_id": user_id, "sha256": sha256}, limit=1)
        return rows[0] if rows else None

    def insert_file(self, row: dict) -> dict:
        with self._lock:
            existing = self.find_file(row["user_id"], row["sha256"])
            if existing is not None:
                return existing
            return self.insert_rows("files", [row])[0]

    # -- test conveniences ---------------------------------------------------

    def count(self, table: str, filters: Filters | None = None) -> int:
        return len(self.select(table, filters))

    def writes_to(self, table: str, op: str | None = None) -> list[Any]:
        return [payload for w_op, w_table, payload in self.writes if w_table == table and (op is None or w_op == op)]


__all__ = [
    "Database", "DatabaseError", "FILE_KINDS", "FILE_STATUSES", "Filters", "InMemoryDatabase",
    "JOB_KINDS", "JOB_STATUSES", "SupabaseDatabase", "filters_to_params", "jsonable", "now_iso",
]
