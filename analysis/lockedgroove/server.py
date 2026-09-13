"""The dispatch API and the local runner (docs/CONTRACTS.md sections 4 and 9).

``create_app(db, storage, secret=..., submit=...)`` builds the FastAPI app
that both the local runner and the Modal deployment serve:

    POST /dispatch   authorization: Bearer {COMPUTE_DISPATCH_SECRET}
                     { "job_id": "<uuid>" }
                     -> 200 { "ok": true, "call_id": "..." }
                     -> 401 without or with the wrong bearer, 404 unknown job
    GET  /health     -> 200 { "ok": true, ... }

The body is only the id: the compute side reads the ``jobs`` row with the
service role. ``submit(job_id, job)`` is the host's way of starting the work
and returns the call id (a thread-pool future locally, ``.spawn()`` on Modal).

Local runner::

    cd analysis && uv run lockedgroove-server      # http://127.0.0.1:8787

reads ``analysis/.env`` (see ``.env.example``) and runs jobs in a thread pool
of two workers with ``SupabaseDatabase`` and ``SupabaseStorage``.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
import textwrap
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import ANALYSIS_VERSION, SCHEMA_VERSION
from .db import Database
from .jobs.runner import KIND_PHASE, run_job
from .modal_app import verify_bearer
from .storage import Storage

log = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_WORKERS = 2
ENV_FILE = Path(__file__).resolve().parents[1] / ".env"  # analysis/.env

Submit = Callable[[str, dict], str]


def implemented_kinds() -> list[str]:
    """Job kinds whose handler module exists in this checkout."""
    out = []
    for kind in KIND_PHASE:
        try:
            if importlib.util.find_spec(f"lockedgroove.jobs.{kind}") is not None:
                out.append(kind)
        except (ImportError, ValueError):
            continue
    return out


class LocalRunner:
    """Runs jobs in a thread pool; follow-up jobs a handler creates are submitted too."""

    def __init__(self, db: Database, storage: Storage, max_workers: int = DEFAULT_WORKERS) -> None:
        self.db = db
        self.storage = storage
        self.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="lockedgroove-job")
        self.calls: dict[str, Future] = {}
        self._lock = threading.Lock()
        self.max_workers = max_workers

    def submit(self, job_id: str, job: dict | None = None) -> str:
        call_id = f"local-{uuid.uuid4().hex[:16]}"
        self.db.update_job(job_id, {"modal_call_id": call_id})
        future = self.executor.submit(run_job, job_id, self.db, self.storage, on_queued=self.submit)
        with self._lock:
            self.calls[call_id] = future
        return call_id

    def wait(self, call_id: str, timeout: float | None = None) -> dict:
        with self._lock:
            future = self.calls[call_id]
        return future.result(timeout=timeout)

    def wait_all(self, timeout: float | None = None) -> None:
        while True:
            with self._lock:
                pending = [f for f in self.calls.values() if not f.done()]
            if not pending:
                return
            for f in pending:
                f.result(timeout=timeout)

    @property
    def running(self) -> int:
        with self._lock:
            return sum(1 for f in self.calls.values() if f.running())

    def shutdown(self, wait: bool = True) -> None:
        self.executor.shutdown(wait=wait)


def create_app(db: Database, storage: Storage, *, secret: str, submit: Submit, runner_name: str = "local",
               extra_health: dict[str, Any] | None = None) -> FastAPI:
    app = FastAPI(title="lockedgroove compute", version="0.1.0", docs_url=None, redoc_url=None)
    app.state.db = db
    app.state.storage = storage
    app.state.secret = secret
    app.state.submit = submit

    def unauthorized():
        return JSONResponse({"ok": False, "error": "unauthorized"}, status_code=401,
                            headers={"WWW-Authenticate": "Bearer"})

    @app.get("/health")
    async def health() -> dict:
        return {
            "ok": True,
            "service": "lockedgroove",
            "runner": runner_name,
            "analysis_version": ANALYSIS_VERSION,
            "schema_version": SCHEMA_VERSION,
            "implemented_kinds": implemented_kinds(),
            "kind_phase": KIND_PHASE,
            **(extra_health or {}),
        }

    @app.post("/dispatch")
    async def dispatch(request: Request):
        if not verify_bearer(request.headers.get("authorization"), app.state.secret):
            return unauthorized()
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "body must be JSON: {\"job_id\": \"<uuid>\"}"}, status_code=400)
        job_id = body.get("job_id") if isinstance(body, dict) else None
        if not isinstance(job_id, str) or not job_id:
            return JSONResponse({"ok": False, "error": "job_id is required"}, status_code=400)
        job = app.state.db.get_job(job_id)
        if job is None:
            return JSONResponse({"ok": False, "error": f"job {job_id} not found"}, status_code=404)
        if job.get("status") == "done":
            return JSONResponse({"ok": True, "call_id": job.get("modal_call_id"), "already_done": True})
        try:
            call_id = app.state.submit(job_id, job)
        except Exception as exc:
            log.exception("dispatch of job %s failed", job_id)
            return JSONResponse({"ok": False, "error": f"dispatch failed: {exc}"}, status_code=500)
        return {"ok": True, "call_id": call_id}

    return app


# ---------------------------------------------------------------------------
# local runner entry point
# ---------------------------------------------------------------------------

_SETUP_HELP = """
lockedgroove-server: missing {missing}.

The local runner talks to the same Supabase project as the web app and writes
results with the service role. Set these in analysis/.env (copy .env.example):

  SUPABASE_URL=https://<project-ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=<Project Settings -> API -> service_role>
  COMPUTE_DISPATCH_SECRET=<the same value as COMPUTE_DISPATCH_SECRET in web/.env.local>

then set COMPUTE_DISPATCH_URL=http://127.0.0.1:{port} in web/.env.local and start
this again with `cd analysis && uv run lockedgroove-server`.
"""


def load_env(paths: list[Path] | None = None) -> list[Path]:
    """Load ``analysis/.env`` (and ``./.env``) without overriding variables already set."""
    from dotenv import load_dotenv

    loaded = []
    for path in paths or [ENV_FILE, Path.cwd() / ".env"]:
        if path.is_file():
            load_dotenv(path, override=False)
            loaded.append(path)
    return loaded


def build_from_env(env: dict[str, str] | None = None, max_workers: int = DEFAULT_WORKERS):
    """The app plus its runner from ``SUPABASE_URL``, ``SUPABASE_SERVICE_ROLE_KEY``, ``COMPUTE_DISPATCH_SECRET``."""
    env = env if env is not None else dict(os.environ)
    required = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "COMPUTE_DISPATCH_SECRET")
    missing = [k for k in required if not env.get(k)]
    if missing:
        port = int(env.get("LOCKEDGROOVE_PORT", DEFAULT_PORT))
        raise SystemExit(textwrap.dedent(_SETUP_HELP).format(missing=", ".join(missing), port=port))

    from .db import SupabaseDatabase
    from .storage import SupabaseStorage

    db = SupabaseDatabase.from_env(env)
    storage = SupabaseStorage.from_env(env)
    runner = LocalRunner(db, storage, max_workers=max_workers)
    app = create_app(db, storage, secret=env["COMPUTE_DISPATCH_SECRET"], submit=runner.submit,
                     runner_name="local", extra_health={"workers": max_workers, "supabase_url": env["SUPABASE_URL"]})
    app.state.runner = runner
    return app, runner


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=os.environ.get("LOCKEDGROOVE_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    loaded = load_env()
    for p in loaded:
        log.info("loaded %s", p)
    app, runner = build_from_env()
    host = os.environ.get("LOCKEDGROOVE_HOST", DEFAULT_HOST)
    port = int(os.environ.get("LOCKEDGROOVE_PORT", DEFAULT_PORT))
    log.info("lockedgroove local runner on http://%s:%d (workers=%d); set COMPUTE_DISPATCH_URL=http://%s:%d",
             host, port, runner.max_workers, host, port)
    import uvicorn

    try:
        uvicorn.run(app, host=host, port=port, log_level="info")
    finally:
        runner.shutdown(wait=False)


if __name__ == "__main__":  # pragma: no cover
    main(sys.argv[1:])


__all__ = ["DEFAULT_HOST", "DEFAULT_PORT", "DEFAULT_WORKERS", "ENV_FILE", "LocalRunner", "build_from_env",
           "create_app", "implemented_kinds", "load_env", "main"]
