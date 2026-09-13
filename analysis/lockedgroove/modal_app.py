"""Modal app for lockedgroove compute (Modal 1.x).

Deploy from ``analysis/``::

    modal token new                      # once per machine
    modal secret create lockedgroove \\
        SUPABASE_URL=https://<ref>.supabase.co \\
        SUPABASE_SERVICE_ROLE_KEY=... COMPUTE_DISPATCH_SECRET=...
    modal deploy lockedgroove/modal_app.py

Functions:

* ``run_job_cpu(job_id)``  cpu=4, 8 GiB, 15 min: analyze, render_loop, chop, midi, ...
* ``run_job_gpu(job_id)``  A10G, 30 min: stems, embed, beatbox_train, neural revoice
* ``web``                  one ASGI app serving ``POST /dispatch`` and ``GET /health``
                           at ``https://<workspace>--lockedgroove-web.modal.run``

``COMPUTE_DISPATCH_URL`` in web/.env.local is that base URL; the web posts
``{ "job_id" }`` to ``{COMPUTE_DISPATCH_URL}/dispatch`` with the bearer
secret, and the dispatcher reads the job's kind from the database, picks the
CPU or GPU function, ``.spawn()``s it and records the call id on the row.

``modal.fastapi_endpoint`` serves a single function at ``/`` only, which is
why the contract's ``/dispatch`` and ``/health`` paths are served by one
``@modal.asgi_app()`` reusing ``lockedgroove.server.create_app``.

The Modal-specific parts are guarded so this module imports (and the pure
dispatch logic is testable) without a Modal token.
"""

from __future__ import annotations

import functools
import hmac
import logging
import os
from typing import Any

log = logging.getLogger(__name__)

APP_NAME = "lockedgroove"
SECRET_NAME = "lockedgroove"
SECRET_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "COMPUTE_DISPATCH_SECRET"]
VOLUME_NAME = "lockedgroove-model-cache"
CACHE_MOUNT = "/cache"
PYTHON_VERSION = "3.11"
APT_PACKAGES = ["ffmpeg", "libsndfile1", "fluidsynth", "fluid-soundfont-gm"]
GPU_TYPE = "A10G"
CPU_SPEC: dict[str, Any] = {"cpu": 4, "memory": 8192, "timeout": 900}
GPU_SPEC: dict[str, Any] = {"gpu": GPU_TYPE, "timeout": 1800}

# Kinds that need a GPU; ``revoice`` only on the neural path (OPEN_QUESTIONS A.4).
GPU_KINDS = frozenset({"stems", "embed", "beatbox_train"})

# Mirrors analysis/pyproject.toml; tests/test_dispatch.py asserts they agree.
# ``modal`` itself is not installed into the image: the runtime injects it.
PIP_BASE = [
    "numpy>=1.26,<3",
    "scipy>=1.11",
    "librosa>=0.10.2",
    "soundfile>=0.12",
    "pyloudnorm>=0.1.1",
    "pydantic>=2.6",
    "pretty_midi>=0.2.10",
    "mido>=1.3",
    "scikit-learn>=1.4",
    "joblib>=1.3",
]
PIP_COMPUTE = [
    "supabase>=2.4",
    "httpx>=0.27",
    "fastapi>=0.110",
    "uvicorn>=0.29",
    "python-dotenv>=1.0",
    "pyfluidsynth>=1.3",
]
# Phase 2+ (separation, embeddings, transcription). Heavy; included in the GPU
# image only when LOCKEDGROOVE_GPU_EXTRAS=1 is set at deploy time until the
# stages that need them land.
PIP_GPU = [
    "torch>=2.2",
    "audio-separator[gpu]>=0.28",
    "basic-pitch>=0.4",
    "laion-clap>=1.1",
]
IMAGE_ENV = {
    "LOCKEDGROOVE_MODEL_CACHE": CACHE_MOUNT,
    "HF_HOME": f"{CACHE_MOUNT}/huggingface",
    "TORCH_HOME": f"{CACHE_MOUNT}/torch",
    "AUDIO_SEPARATOR_MODEL_DIR": f"{CACHE_MOUNT}/audio-separator",
    "NUMBA_CACHE_DIR": "/tmp/numba-cache",
    "LOCKEDGROOVE_SOUNDFONT": "/usr/share/sounds/sf2/FluidR3_GM.sf2",
}


# ---------------------------------------------------------------------------
# pure dispatch logic (unit-tested without Modal)
# ---------------------------------------------------------------------------


def choose_runner(kind: str, params: dict | None = None) -> str:
    """``"gpu"`` for separation, embeddings, beatbox training and neural re-voice; ``"cpu"`` otherwise."""
    if kind in GPU_KINDS:
        return "gpu"
    if kind == "revoice" and str((params or {}).get("path", "symbolic")).lower() == "neural":
        return "gpu"
    return "cpu"


def verify_bearer(header: str | None, secret: str | None) -> bool:
    """Constant-time check of ``Authorization: Bearer <secret>``; fails closed when no secret is configured."""
    if not secret or not header:
        return False
    scheme, _, token = header.strip().partition(" ")
    if scheme.lower() != "bearer":
        return False
    token = token.strip()
    if not token:
        return False
    return hmac.compare_digest(token.encode("utf-8"), secret.encode("utf-8"))


def gpu_extras_enabled(env: dict[str, str] | None = None) -> bool:
    env = env if env is not None else os.environ
    return str(env.get("LOCKEDGROOVE_GPU_EXTRAS", "")).strip().lower() in ("1", "true", "yes")


def pip_packages(gpu: bool) -> list[str]:
    packages = [*PIP_BASE, *PIP_COMPUTE]
    if gpu and gpu_extras_enabled():
        packages += PIP_GPU
    return packages


# ---------------------------------------------------------------------------
# Modal objects (only when the modal package is importable)
# ---------------------------------------------------------------------------

try:
    import modal
except ImportError:  # local tests without modal: the pure functions above still work
    modal = None  # type: ignore[assignment]


@functools.lru_cache(maxsize=1)
def _clients():
    from lockedgroove.db import SupabaseDatabase
    from lockedgroove.storage import SupabaseStorage

    return SupabaseDatabase.from_env(), SupabaseStorage.from_env()


def build_image(gpu: bool = False):
    """The container image: Debian slim + ffmpeg/libsndfile + the pyproject dependencies + this package."""
    return (
        modal.Image.debian_slim(python_version=PYTHON_VERSION)
        .apt_install(*APT_PACKAGES)
        .pip_install(*pip_packages(gpu))
        .env(IMAGE_ENV)
        .add_local_python_source("lockedgroove")
    )


if modal is not None:
    app = modal.App(APP_NAME)
    cpu_image = build_image(gpu=False)
    gpu_image = build_image(gpu=True)
    secret = modal.Secret.from_name(SECRET_NAME, required_keys=SECRET_KEYS)
    model_cache = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

    def _run(job_id: str) -> dict:
        from lockedgroove.jobs.runner import run_job

        db, storage = _clients()
        final = run_job(job_id, db, storage, on_queued=submit_job)
        try:
            model_cache.commit()  # persist any model weights a stage downloaded
        except Exception:
            log.debug("volume commit skipped", exc_info=True)
        return {"job_id": job_id, "status": final.get("status"), "error": final.get("error")}

    @app.function(image=cpu_image, secrets=[secret], volumes={CACHE_MOUNT: model_cache}, **CPU_SPEC)
    def run_job_cpu(job_id: str) -> dict:
        return _run(job_id)

    @app.function(image=gpu_image, secrets=[secret], volumes={CACHE_MOUNT: model_cache}, **GPU_SPEC)
    def run_job_gpu(job_id: str) -> dict:
        return _run(job_id)

    @app.function(image=gpu_image, secrets=[secret], volumes={CACHE_MOUNT: model_cache}, gpu=GPU_TYPE, timeout=120)
    def embed_text_gpu(texts: list[str]) -> dict:
        from lockedgroove.server import local_embed_text

        return local_embed_text(texts)

    def submit_job(job_id: str, job: dict | None = None) -> str:
        """Spawn the right function for the job's kind and record the call id on the row."""
        db, _ = _clients()
        if job is None:
            job = db.get_job(job_id)
        if job is None:
            raise KeyError(f"job {job_id} not found")
        runner = choose_runner(str(job.get("kind")), job.get("params") or {})
        fn = run_job_gpu if runner == "gpu" else run_job_cpu
        call = fn.spawn(job_id)
        call_id = call.object_id
        db.update_job(job_id, {"modal_call_id": call_id})
        log.info("job %s (%s) spawned on %s as %s", job_id, job.get("kind"), runner, call_id)
        return call_id

    @app.function(image=cpu_image, secrets=[secret], timeout=60)
    @modal.asgi_app()
    def web():
        from lockedgroove.server import create_app

        db, storage = _clients()
        return create_app(
            db, storage,
            secret=os.environ.get("COMPUTE_DISPATCH_SECRET", ""),
            submit=submit_job,
            runner_name="modal",
            extra_health={"gpu": GPU_TYPE, "gpu_kinds": sorted(GPU_KINDS), "gpu_extras": gpu_extras_enabled()},
            embed_text=lambda texts: embed_text_gpu.remote(texts),
        )


__all__ = [
    "APP_NAME", "CACHE_MOUNT", "CPU_SPEC", "GPU_KINDS", "GPU_SPEC", "GPU_TYPE", "PIP_BASE", "PIP_COMPUTE",
    "PIP_GPU", "SECRET_KEYS", "SECRET_NAME", "VOLUME_NAME", "build_image", "choose_runner", "gpu_extras_enabled",
    "pip_packages", "verify_bearer",
]
