"""Datasets on disk (or in memory) -> pipeline runs -> scored results.

Loaders return :class:`Dataset` objects; :func:`run_dataset` analyzes every
item through the public pipeline and scores it with
:mod:`lockedgroove.eval.metrics`; :func:`evaluate` assembles the JSON document
that ``scripts/eval_accuracy.py`` prints and stores under ``data/eval/``.

The only pipeline surface used is ``lockedgroove.pipeline.analyze_array`` and
``lockedgroove.report.effective``. A stage that is missing or fails shows up
as a miss with its reason (from ``Context.errors``), never as a crash.

Dataset layouts under ``data/`` (all produced by ``scripts/``):

    synthetic/<id>.wav + <id>.json                    build_synthetic_dataset.py
    giantsteps_tempo/audio/<name>.mp3
                     annotations_v2/tempo/<name>.bpm  fetch_public_datasets.py
    giantsteps_key/audio/<name>.mp3
                   annotations/key/<name>.key
    ballroom/annotations/<name>.beats
             BallroomData/<Genre>/<name>.wav
    corrections/<file_id>.<ext>                       pulled from Supabase at run time
"""

from __future__ import annotations

import functools
import json
import logging
import multiprocessing
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .metrics import (
    METRICS,
    GateResult,
    MetricResult,
    MetricSummary,
    Prediction,
    check_gates,
    merge_summaries,
    parse_key,
    prediction_from_report,
    score_item,
    summarize,
)

PUBLIC_DATASETS: tuple[str, ...] = ("giantsteps_tempo", "giantsteps_key", "ballroom")
DATASETS: tuple[str, ...] = ("synthetic", *PUBLIC_DATASETS, "corrections")
RESULTS_SCHEMA = 1
CORRECTION_FIELDS = ("tempo_bpm", "downbeat_phase", "first_downbeat_s", "key", "meter", "section_labels")
CORRECTIONS_ENV = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EVAL_CORRECTIONS_USER_ID")


# --------------------------------------------------------------------------
# data classes
# --------------------------------------------------------------------------

@dataclass
class Item:
    id: str
    truth: dict[str, Any]
    path: str | None = None
    """audio file on disk (loaded with ``lockedgroove.ingest.load_audio``)"""
    audio: tuple[np.ndarray, int] | None = None
    """in-memory ``(y, sr)``; used by tests, never pickled to workers"""
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class Dataset:
    name: str
    items: list[Item] = field(default_factory=list)
    skipped: list[dict[str, str]] = field(default_factory=list)
    """items that could not be evaluated at all (no audio, bad annotation): ``{id, reason}``"""
    note: str | None = None
    """why the dataset has no items, when it has none"""


@dataclass
class ItemRun:
    id: str
    prediction: Prediction
    elapsed_s: float = 0.0
    duration_s: float | None = None
    timings_s: dict[str, float] = field(default_factory=dict)


@dataclass
class ItemResult:
    id: str
    scores: dict[str, MetricResult]
    prediction: Prediction
    elapsed_s: float
    duration_s: float | None
    timings_s: dict[str, float]
    meta: dict[str, Any] = field(default_factory=dict)

    def to_json_dict(self) -> dict[str, Any]:
        p = self.prediction
        return {
            "id": self.id,
            "scores": {m: r.to_json_dict() for m, r in self.scores.items()},
            "prediction": {
                "bpm": p.bpm, "alternates_bpm": p.alternates_bpm,
                "key": list(p.key) if p.key else None,
                "key_alternate": list(p.key_alternate) if p.key_alternate else None,
                "n_beats": len(p.beats_s), "n_downbeats": len(p.downbeats_s),
                "first_downbeat_s": p.downbeats_s[0] if p.downbeats_s else None,
                "n_sections": len(p.sections) if p.has_structure else None,
            },
            "errors": p.errors,
            "elapsed_s": round(self.elapsed_s, 3),
            "duration_s": self.duration_s,
            "timings_s": {k: round(v, 3) for k, v in self.timings_s.items()},
            "meta": self.meta,
        }


# --------------------------------------------------------------------------
# loaders
# --------------------------------------------------------------------------

def _limit(items: list[Item], limit: int | None) -> list[Item]:
    items.sort(key=lambda it: it.id)
    return items[:limit] if limit is not None else items


def load_synthetic(data_dir: pathlib.Path, limit: int | None = None) -> Dataset:
    d = data_dir / "synthetic"
    ds = Dataset("synthetic")
    if not d.is_dir():
        ds.note = f"not found: {d} (run scripts/build_synthetic_dataset.py)"
        return ds
    for js in sorted(d.glob("*.json")):
        if js.name == "manifest.json":
            continue
        try:
            truth = json.loads(js.read_text())
        except ValueError as exc:
            ds.skipped.append({"id": js.stem, "reason": f"bad truth json: {exc}"})
            continue
        wav = d / f"{js.stem}.wav"
        if not wav.exists():
            ds.skipped.append({"id": js.stem, "reason": "missing wav"})
            continue
        params = truth.get("params") or {}
        meta = {k: params.get(k) for k in ("structure", "loop_bars", "with_drums", "pattern", "swing",
                                           "lead_s", "pickup_beats", "width", "sr") if k in params}
        ds.items.append(Item(id=str(truth.get("id") or js.stem), truth=truth, path=str(wav), meta=meta))
    ds.items = _limit(ds.items, limit)
    if not ds.items and not ds.note:
        ds.note = f"no items under {d}"
    return ds


def _find_audio(dirs: list[pathlib.Path], name: str, suffixes: tuple[str, ...]) -> pathlib.Path | None:
    for d in dirs:
        for suffix in suffixes:
            p = d / f"{name}{suffix}"
            if p.exists():
                return p
    return None


def load_giantsteps_tempo(data_dir: pathlib.Path, limit: int | None = None) -> Dataset:
    d = data_dir / "giantsteps_tempo"
    ds = Dataset("giantsteps_tempo")
    v2, v1 = d / "annotations_v2" / "tempo", d / "annotations" / "tempo"
    ann_dir = v2 if v2.is_dir() else v1
    if not ann_dir.is_dir():
        ds.note = f"not found: {d} (run scripts/fetch_public_datasets.py --dataset giantsteps_tempo)"
        return ds
    audio_dirs = [d / "audio", d]
    for bpm_file in sorted(ann_dir.glob("*.bpm")):
        name = bpm_file.name[: -len(".bpm")]
        try:
            bpm = float(bpm_file.read_text().strip().split()[0])
        except (ValueError, IndexError):
            ds.skipped.append({"id": name, "reason": "unreadable bpm annotation"})
            continue
        if bpm <= 0:
            ds.skipped.append({"id": name, "reason": "no tempo annotation (0.0 in v2)"})
            continue
        audio = _find_audio(audio_dirs, name, (".mp3", ".wav", ".flac"))
        if audio is None:
            ds.skipped.append({"id": name, "reason": "missing audio"})
            continue
        meta: dict[str, Any] = {"annotation": "v2" if ann_dir == v2 else "v1"}
        v1_file = v1 / bpm_file.name
        if ann_dir == v2 and v1_file.exists():
            try:
                meta["bpm_v1"] = float(v1_file.read_text().strip().split()[0])
            except (ValueError, IndexError):
                pass
        ds.items.append(Item(id=name, truth={"bpm": bpm}, path=str(audio), meta=meta))
    ds.items = _limit(ds.items, limit)
    if not ds.items and not ds.note:
        ds.note = f"annotations present under {d} but no audio (see scripts/fetch_public_datasets.py)"
    return ds


def load_giantsteps_key(data_dir: pathlib.Path, limit: int | None = None) -> Dataset:
    d = data_dir / "giantsteps_key"
    ds = Dataset("giantsteps_key")
    ann_dir = d / "annotations" / "key"
    if not ann_dir.is_dir():
        ds.note = f"not found: {d} (run scripts/fetch_public_datasets.py --dataset giantsteps_key)"
        return ds
    audio_dirs = [d / "audio", d]
    for key_file in sorted(ann_dir.glob("*.key")):
        name = key_file.name[: -len(".key")]
        key = parse_key(key_file.read_text().strip())
        if key is None:
            ds.skipped.append({"id": name, "reason": f"unparsable key annotation {key_file.read_text().strip()!r}"})
            continue
        audio = _find_audio(audio_dirs, name, (".mp3", ".wav", ".flac"))
        if audio is None:
            ds.skipped.append({"id": name, "reason": "missing audio"})
            continue
        ds.items.append(Item(id=name, truth={"key": {"tonic": key[0], "mode": key[1]}}, path=str(audio)))
    ds.items = _limit(ds.items, limit)
    if not ds.items and not ds.note:
        ds.note = f"annotations present under {d} but no audio (see scripts/fetch_public_datasets.py)"
    return ds


def parse_beats_file(text: str) -> tuple[list[float], list[float], int]:
    """CPJKU ``.beats`` format: ``<time_s> <beat id>`` per line; id 1 marks a downbeat."""
    beats: list[float] = []
    downbeats: list[float] = []
    max_id = 1
    for line in text.splitlines():
        parts = line.split()
        if not parts:
            continue
        try:
            t = float(parts[0])
        except ValueError:
            continue
        beats.append(t)
        if len(parts) > 1:
            try:
                beat_id = int(float(parts[1]))
            except ValueError:
                beat_id = 0
            if beat_id == 1:
                downbeats.append(t)
            max_id = max(max_id, beat_id)
    return beats, downbeats, max_id


def load_ballroom(data_dir: pathlib.Path, limit: int | None = None) -> Dataset:
    d = data_dir / "ballroom"
    ds = Dataset("ballroom")
    ann_dir = d / "annotations"
    if not ann_dir.is_dir():
        ds.note = f"not found: {d} (run scripts/fetch_public_datasets.py --dataset ballroom)"
        return ds
    wavs: dict[str, pathlib.Path] = {}
    for p in d.rglob("*.wav"):
        wavs.setdefault(p.stem, p)
    for beats_file in sorted(ann_dir.glob("*.beats")):
        name = beats_file.name[: -len(".beats")]
        beats, downbeats, beats_per_bar = parse_beats_file(beats_file.read_text())
        if len(beats) < 2:
            ds.skipped.append({"id": name, "reason": "fewer than two annotated beats"})
            continue
        audio = wavs.get(name)
        if audio is None:
            ds.skipped.append({"id": name, "reason": "missing audio"})
            continue
        ibi = np.diff(np.asarray(beats))
        bpm = float(60.0 / np.median(ibi)) if ibi.size else None
        truth = {"bpm": bpm, "beats_s": beats, "downbeats_s": downbeats,
                 "meter": f"{beats_per_bar}/4", "beats_per_bar": beats_per_bar}
        ds.items.append(Item(id=name, truth=truth, path=str(audio),
                             meta={"genre": audio.parent.name, "bpm_derived_from": "median inter-beat interval"}))
    ds.items = _limit(ds.items, limit)
    if not ds.items and not ds.note:
        ds.note = f"annotations present under {d} but no audio (see scripts/fetch_public_datasets.py)"
    return ds


# --------------------------------------------------------------------------
# corrections (Supabase, service role, one account only)
# --------------------------------------------------------------------------

def _sb_json(url: str, key: str, method: str = "GET", body: dict | None = None, timeout: float = 60) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json",
        **({"Content-Type": "application/json"} if data is not None else {}),
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    return json.loads(raw) if raw else None


def _sb_rest(base: str, key: str, table: str, params: Mapping[str, str]) -> list[dict]:
    url = f"{base.rstrip('/')}/rest/v1/{table}?{urllib.parse.urlencode(params)}"
    out = _sb_json(url, key)
    return list(out or [])


def _sb_signed_url(base: str, key: str, bucket: str, path: str, expires_s: int = 600) -> str:
    url = f"{base.rstrip('/')}/storage/v1/object/sign/{bucket}/{urllib.parse.quote(path)}"
    out = _sb_json(url, key, method="POST", body={"expiresIn": expires_s})
    signed = (out or {}).get("signedURL") or (out or {}).get("signedUrl")
    if not signed:
        raise RuntimeError("storage did not return a signed URL")
    if signed.startswith("http"):
        return signed
    return f"{base.rstrip('/')}/storage/v1{signed if signed.startswith('/') else '/' + signed}"


def truth_from_corrections(report_json: Mapping[str, Any] | None, edits: Mapping[str, Any]) -> tuple[dict, list[str]]:
    """Ground truth for the fields a user corrected (principle 7).

    Only corrected fields become truth: a corrected tempo gives ``bpm``, a
    corrected key gives ``key``, and a downbeat/meter correction gives the
    downbeat grid that ``effective()`` produces from the stored report plus
    the edits. Section label edits carry no boundary truth and are ignored.
    """
    truth: dict[str, Any] = {}
    notes: list[str] = []
    if edits.get("tempo_bpm") is not None:
        try:
            truth["bpm"] = float(edits["tempo_bpm"])
        except (TypeError, ValueError):
            notes.append("tempo_bpm correction is not a number")
    if isinstance(edits.get("key"), Mapping):
        k = parse_key(f"{edits['key'].get('tonic')} {edits['key'].get('mode')}")
        if k:
            truth["key"] = {"tonic": k[0], "mode": k[1]}
        else:
            notes.append("key correction is not a key")
    if any(edits.get(f) is not None for f in ("downbeat_phase", "first_downbeat_s", "meter")):
        if not report_json:
            notes.append("downbeat correction without a stored report")
        else:
            try:
                from lockedgroove.report import AnalysisReport, UserEdits, effective

                report = AnalysisReport.model_validate(report_json)
                merged = report.user_edits.model_dump()
                merged.update({k: v for k, v in edits.items() if k in UserEdits.model_fields})
                report.user_edits = UserEdits(**merged)
                eff = effective(report)
                if eff.beats is not None and eff.beats.downbeats_s:
                    truth["downbeats_s"] = list(eff.beats.downbeats_s)
                    truth["meter"] = eff.beats.meter
                else:
                    notes.append("stored report has no beat grid to apply the downbeat correction to")
            except Exception as exc:  # schema drift must not sink the run
                notes.append(f"could not apply downbeat correction: {type(exc).__name__}: {exc}")
    return truth, notes


def load_corrections(data_dir: pathlib.Path, limit: int | None = None,
                     env: Mapping[str, str] | None = None, log: Callable[[str], None] = print) -> Dataset:
    """Corrections of one account, read with the service role (OPEN_QUESTIONS L.36).

    Needs ``SUPABASE_URL``, ``SUPABASE_SERVICE_ROLE_KEY`` and
    ``EVAL_CORRECTIONS_USER_ID`` (the account whose corrections may be used);
    without them the dataset is skipped with a message. Audio is cached under
    ``data/corrections/`` (gitignored) and never leaves the machine.
    """
    env = env if env is not None else os.environ
    ds = Dataset("corrections")
    missing = [k for k in CORRECTIONS_ENV if not env.get(k)]
    if missing:
        ds.note = ("skipped: " + ", ".join(missing) + " not set. The corrections set is read with the service "
                   "role for one account only (OPEN_QUESTIONS L.36); set all three to use it.")
        return ds
    base, key, uid = env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"], env["EVAL_CORRECTIONS_USER_ID"]
    try:
        rows = _sb_rest(base, key, "corrections", {
            "select": "id,file_id,field,predicted,corrected,created_at",
            "user_id": f"eq.{uid}", "order": "created_at.asc", "limit": "10000",
        })
    except (urllib.error.URLError, OSError, ValueError) as exc:
        ds.note = f"skipped: could not read the corrections table ({type(exc).__name__}: {exc})"
        return ds
    if not rows:
        ds.note = "no corrections logged for this account yet"
        return ds
    edits_by_file: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("field") in CORRECTION_FIELDS:
            edits_by_file.setdefault(row["file_id"], {})[row["field"]] = row.get("corrected")
    file_ids = sorted(edits_by_file)
    files: dict[str, dict] = {}
    for i in range(0, len(file_ids), 50):
        chunk = file_ids[i:i + 50]
        try:
            for f in _sb_rest(base, key, "files", {
                "select": "id,storage_path,original_filename,report,format,duration_s",
                "id": f"in.({','.join(chunk)})", "user_id": f"eq.{uid}",
            }):
                files[f["id"]] = f
        except (urllib.error.URLError, OSError, ValueError) as exc:
            ds.note = f"skipped: could not read the files table ({type(exc).__name__}: {exc})"
            return ds
    out_dir = data_dir / "corrections"
    out_dir.mkdir(parents=True, exist_ok=True)
    n_downloaded = 0
    for file_id in file_ids:
        f = files.get(file_id)
        if f is None:
            ds.skipped.append({"id": file_id, "reason": "file row not found for this account"})
            continue
        truth, notes = truth_from_corrections(f.get("report"), edits_by_file[file_id])
        if not truth:
            ds.skipped.append({"id": file_id, "reason": "; ".join(notes) or "no scorable correction"})
            continue
        storage_path = f.get("storage_path") or ""
        ext = pathlib.PurePosixPath(storage_path).suffix or (f".{f['format']}" if f.get("format") else ".wav")
        local = out_dir / f"{file_id}{ext}"
        if not local.exists():
            try:
                signed = _sb_signed_url(base, key, "audio", storage_path)
                tmp = local.with_suffix(local.suffix + ".part")
                with urllib.request.urlopen(signed, timeout=120) as resp, open(tmp, "wb") as fh:
                    while True:
                        chunk_b = resp.read(1 << 20)
                        if not chunk_b:
                            break
                        fh.write(chunk_b)
                tmp.replace(local)
                n_downloaded += 1
            except (urllib.error.URLError, OSError, RuntimeError) as exc:
                ds.skipped.append({"id": file_id, "reason": f"download failed: {type(exc).__name__}"})
                continue
        ds.items.append(Item(id=file_id, truth=truth, path=str(local),
                             meta={"corrected_fields": sorted(edits_by_file[file_id]), "notes": notes}))
    ds.items = _limit(ds.items, limit)
    log(f"corrections: {len(rows)} rows on {len(file_ids)} files; {len(ds.items)} scorable, "
        f"{n_downloaded} downloaded, {len(ds.skipped)} skipped")
    if not ds.items and not ds.note:
        ds.note = "corrections exist but none produced a scorable truth"
    return ds


LOADERS: dict[str, Callable[..., Dataset]] = {
    "synthetic": load_synthetic,
    "giantsteps_tempo": load_giantsteps_tempo,
    "giantsteps_key": load_giantsteps_key,
    "ballroom": load_ballroom,
    "corrections": load_corrections,
}


def load_dataset(name: str, data_dir: pathlib.Path, limit: int | None = None, **kwargs: Any) -> Dataset:
    if name not in LOADERS:
        raise ValueError(f"unknown dataset {name!r}; choose from {', '.join(DATASETS)} or all")
    return LOADERS[name](data_dir, limit=limit, **kwargs)


# --------------------------------------------------------------------------
# running the pipeline
# --------------------------------------------------------------------------

def _worker_init(log_level: int | None = None) -> None:
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMBA_NUM_THREADS"):
        os.environ.setdefault(var, "1")
    if log_level is not None:
        # spawned workers start with a fresh logging config; mirror the parent's level
        logging.basicConfig(level=log_level, format="%(levelname)s %(name)s: %(message)s")


def analyze_item(item: Item, stages: list[str] | None = None) -> ItemRun:
    """Load, analyze, resolve user edits, and read the prediction. Never raises."""
    t0 = time.perf_counter()
    duration_s: float | None = None
    try:
        from lockedgroove.pipeline import analyze_array
        from lockedgroove.report import effective

        if item.audio is not None:
            y, sr = item.audio
        else:
            from lockedgroove.ingest import load_audio

            y, sr = load_audio(item.path, mono=False)
        duration_s = float(np.asarray(y).shape[-1] / sr) if sr else None
        report, ctx = analyze_array(y, sr, stages=stages, return_context=True)
        pred = prediction_from_report(effective(report), ctx.errors)
        timings = dict(ctx.timings_s)
    except Exception as exc:
        pred = Prediction(errors={"analysis": f"{type(exc).__name__}: {exc}"})
        timings = {}
    return ItemRun(item.id, pred, time.perf_counter() - t0, duration_s, timings)


def _run_from_callable(item: Item, analyze_fn: Callable[[Item], Any]) -> ItemRun:
    """Adapt a test double: it may return an ItemRun, a report, or ``(report, errors)``."""
    t0 = time.perf_counter()
    try:
        out = analyze_fn(item)
        if isinstance(out, ItemRun):
            return out
        errors: Mapping[str, str] = {}
        if isinstance(out, tuple) and len(out) == 2:
            out, errors = out
        from lockedgroove.report import AnalysisReport, effective

        if isinstance(out, AnalysisReport):
            out = effective(out)
        pred = prediction_from_report(out, errors)
    except Exception as exc:
        pred = Prediction(errors={"analysis": f"{type(exc).__name__}: {exc}"})
    return ItemRun(item.id, pred, time.perf_counter() - t0)


def _warm_numba_cache(stages: list[str] | None) -> None:
    """Compile librosa's numba kernels once, in this process, before the pool starts.

    Workers share the on-disk numba cache (``site-packages/librosa/**/__pycache__/*.nbi``).
    Several fresh workers compiling and writing the same kernels at once has
    left a torn cache that segfaulted every later process (the beat tracker's
    gufunc); one warm run here fills the cache so the workers only read it.
    """
    try:
        from lockedgroove.pipeline import analyze_array
        from lockedgroove.testing.synth import click_track

        sr = 22050
        analyze_array(click_track(120.0, 6.0, sr), sr, stages=stages)
    except Exception as exc:  # the real items report their own errors
        logging.getLogger(__name__).warning("numba warm-up failed: %s", exc)


def _crash_worker(item: Item, stages: list[str] | None = None) -> ItemRun:  # pragma: no cover - runs in a child
    """A worker function for the tests: dies the way a native crash does, without a result."""
    import os

    os._exit(3)


def run_dataset(dataset: Dataset, stages: list[str] | None = None, workers: int = 1,
                analyze_fn: Callable[[Item], Any] | None = None,
                on_progress: Callable[[str, int, int, ItemResult], None] | None = None,
                stall_timeout_s: float = 600.0,
                worker_fn: Callable[..., ItemRun] | None = None) -> list[ItemResult]:
    """Analyze and score every item; results come back in the dataset's item order.

    With workers > 1 the items run in a spawn pool. A worker that dies mid-item
    (a crash inside a native library) is replaced by the pool but its result
    never arrives, and ``imap`` would wait forever; so after ``stall_timeout_s``
    without any item finishing, the items still pending are recorded as errors
    and the run completes.
    """
    items = list(dataset.items)
    by_id = {it.id: it for it in items}
    if len(by_id) != len(items):
        raise ValueError(f"duplicate item ids in dataset {dataset.name}")
    runs: dict[str, ItemRun] = {}
    results: dict[str, ItemResult] = {}

    def finish(run: ItemRun) -> None:
        item = by_id[run.id]
        scores = score_item(run.prediction, item.truth)
        res = ItemResult(run.id, scores, run.prediction, run.elapsed_s, run.duration_s, run.timings_s, dict(item.meta))
        results[run.id] = res
        runs[run.id] = run
        if on_progress:
            on_progress(dataset.name, len(results), len(items), res)

    parallel = workers > 1 and analyze_fn is None and all(it.audio is None for it in items) and len(items) > 1
    if parallel:
        if worker_fn is None:
            _warm_numba_cache(stages)
        ctx = multiprocessing.get_context("spawn")
        fn = functools.partial(worker_fn or analyze_item, stages=stages)
        level = logging.getLogger().getEffectiveLevel()
        with ctx.Pool(min(workers, len(items)), initializer=_worker_init, initargs=(level,)) as pool:
            pending = {it.id: pool.apply_async(fn, (it,)) for it in items}
            last_progress = time.monotonic()
            while pending:
                ready = [iid for iid, ar in pending.items() if ar.ready()]
                for iid in ready:
                    ar = pending.pop(iid)
                    try:
                        run = ar.get()
                    except Exception as exc:  # raised outside analyze_item's own guard
                        run = ItemRun(iid, Prediction(errors={"analysis": f"{type(exc).__name__}: {exc}"}))
                    finish(run)
                    last_progress = time.monotonic()
                if not pending:
                    break
                if not ready:
                    if time.monotonic() - last_progress > stall_timeout_s:
                        logging.getLogger(__name__).error(
                            "no item finished in %.0fs; recording %d pending item(s) as lost",
                            stall_timeout_s, len(pending))
                        for iid in list(pending):
                            pending.pop(iid)
                            msg = f"lost: no result within {stall_timeout_s:.0f}s (worker crash?)"
                            finish(ItemRun(iid, Prediction(errors={"analysis": msg})))
                        break
                    time.sleep(0.25)
    else:
        for item in items:
            finish(_run_from_callable(item, analyze_fn) if analyze_fn else analyze_item(item, stages))
    return [results[it.id] for it in items]


# --------------------------------------------------------------------------
# results document
# --------------------------------------------------------------------------

@dataclass
class DatasetOutcome:
    dataset: Dataset
    results: list[ItemResult]
    elapsed_s: float = 0.0
    requested: bool = True
    """True when the user named this dataset explicitly (a missing one then fails the gate)"""


def evaluate(outcomes: Mapping[str, DatasetOutcome], gates: Mapping[str, Mapping[str, float]] | None = None,
             enforce_gates: bool = True, stages: list[str] | None = None,
             meta: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Summaries per dataset and overall, gate results, and the verdict, as one JSON-able dict."""
    from lockedgroove import ANALYSIS_VERSION

    datasets_doc: dict[str, Any] = {}
    summaries: dict[str, dict[str, MetricSummary]] = {}
    for name, oc in outcomes.items():
        summary = summarize(r.scores for r in oc.results)
        if oc.results:
            summaries[name] = summary
        datasets_doc[name] = {
            "n_items": len(oc.results),
            "n_skipped": len(oc.dataset.skipped),
            "skipped": oc.dataset.skipped[:200],
            "note": oc.dataset.note,
            "requested": oc.requested,
            "elapsed_s": round(oc.elapsed_s, 2),
            "metrics": {m: s.to_json_dict() for m, s in summary.items()},
            "items": [r.to_json_dict() for r in oc.results],
        }
    overall = merge_summaries(summaries.values())
    gate_results: list[GateResult] = check_gates(summaries, gates) if gates else []
    missing_requested = [name for name, oc in outcomes.items() if oc.requested and not oc.results]
    passed: bool | None = None
    verdict_notes: list[str] = []
    if enforce_gates and gates:
        applicable = [g for g in gate_results if g.applicable]
        failed = [g for g in applicable if g.passed is False]
        passed = not failed
        if not applicable:
            passed = False
            verdict_notes.append("no gate applied to any scored item")
        for name in missing_requested:
            gated = name in gates
            if gated:
                passed = False
                verdict_notes.append(f"requested dataset {name!r} was not scored: {outcomes[name].dataset.note}")
    return {
        "schema": RESULTS_SCHEMA,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "analysis_version": ANALYSIS_VERSION,
        "stages": stages,
        "meta": dict(meta or {}),
        "datasets": datasets_doc,
        "overall": {m: s.to_json_dict() for m, s in overall.items()},
        "gates": {
            "enforced": bool(enforce_gates and gates),
            "results": [g.to_json_dict() for g in gate_results],
            "passed": passed,
            "notes": verdict_notes,
        },
    }


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

def _fmt_metric(m: Mapping[str, Any]) -> str:
    if not m or not m.get("n"):
        return "n/a"
    return f"{m['score']:.3f} ({m['n']})"


def render_table(doc: Mapping[str, Any]) -> str:
    """Plain-text table plus gate lines and the top miss reasons."""
    headers = ["dataset", "items", *METRICS]
    rows: list[list[str]] = []
    for name, d in doc["datasets"].items():
        if d["n_items"]:
            rows.append([name, str(d["n_items"]), *[_fmt_metric(d["metrics"].get(m, {})) for m in METRICS]])
        else:
            rows.append([name, "0", *["-"] * len(METRICS)])
    if sum(1 for d in doc["datasets"].values() if d["n_items"]) > 1:
        rows.append(["overall", str(sum(d["n_items"] for d in doc["datasets"].values())),
                     *[_fmt_metric(doc["overall"].get(m, {})) for m in METRICS]])
    widths = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h) for i, h in enumerate(headers)]
    lines = ["  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)),
             "  ".join("-" * w for w in widths)]
    lines += ["  ".join(c.ljust(widths[i]) for i, c in enumerate(r)) for r in rows]
    lines.append("score = hits/n for the boolean metrics, mean F for structure_f; (n) = items the metric applied to")
    for name, d in doc["datasets"].items():
        if not d["n_items"]:
            lines.append(f"{name}: {d.get('note') or 'no items'}")
        elif d["n_skipped"]:
            reasons: dict[str, int] = {}
            for s in d["skipped"]:
                reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
            top = ", ".join(f"{k} x{v}" for k, v in sorted(reasons.items(), key=lambda kv: -kv[1])[:3])
            lines.append(f"{name}: {d['n_skipped']} item(s) not evaluated ({top})")
    reason_lines = []
    for name, d in doc["datasets"].items():
        for m in METRICS:
            ms = d["metrics"].get(m) or {}
            if ms.get("n") and ms.get("reasons"):
                top = list(ms["reasons"].items())[:3]
                reason_lines.append(f"  {name}.{m}: " + "; ".join(f"{r} x{c}" for r, c in top))
    if reason_lines:
        lines.append("misses by reason:")
        lines.extend(reason_lines)
    g = doc["gates"]
    if g["results"]:
        lines.append("gates" + ("" if g["enforced"] else " (not enforced)") + ":")
        for r in g["results"]:
            if r["passed"] is None:
                status = "n/a "
            else:
                status = "PASS" if r["passed"] else "FAIL"
            score = f"{r['score']:.3f}" if r["score"] is not None else "-"
            lines.append(f"  {status} {r['dataset']}.{r['metric']}: {score} >= {r['threshold']:.2f} (n={r['n']})")
        for note in g["notes"]:
            lines.append(f"  ! {note}")
        if g["enforced"]:
            lines.append("gate verdict: " + ("PASS" if g["passed"] else "FAIL"))
    return "\n".join(lines)


def render_markdown(doc: Mapping[str, Any]) -> str:
    out = [f"# Accuracy harness — {doc['created_at']}", ""]
    if doc.get("meta"):
        out.append("; ".join(f"{k}: {v}" for k, v in doc["meta"].items() if v is not None))
        out.append("")
    out.append("| dataset | items | " + " | ".join(METRICS) + " |")
    out.append("|---|---:|" + "|".join(["---:"] * len(METRICS)) + "|")
    for name, d in doc["datasets"].items():
        cells = [_fmt_metric(d["metrics"].get(m, {})) for m in METRICS] if d["n_items"] else ["-"] * len(METRICS)
        out.append(f"| {name} | {d['n_items']} | " + " | ".join(cells) + " |")
    if sum(1 for d in doc["datasets"].values() if d["n_items"]) > 1:
        out.append(f"| **overall** | {sum(d['n_items'] for d in doc['datasets'].values())} | "
                   + " | ".join(_fmt_metric(doc["overall"].get(m, {})) for m in METRICS) + " |")
    out.append("")
    out.append("Score = hits/n for the boolean metrics, mean F for `structure_f`; (n) = items the metric applied to.")
    out.append("")
    for name, d in doc["datasets"].items():
        if not d["n_items"]:
            out.append(f"- **{name}**: {d.get('note') or 'no items'}")
        elif d["n_skipped"]:
            out.append(f"- **{name}**: {d['n_skipped']} item(s) not evaluated (no audio or bad annotation)")
    reason_lines = []
    for name, d in doc["datasets"].items():
        for m in METRICS:
            ms = d["metrics"].get(m) or {}
            if ms.get("n") and ms.get("reasons"):
                top = list(ms["reasons"].items())[:3]
                reason_lines.append(f"- `{name}.{m}`: " + "; ".join(f"{r} ×{c}" for r, c in top))
    if reason_lines:
        out += ["", "## Misses by reason", "", *reason_lines]
    g = doc["gates"]
    if g["results"]:
        out += ["", "## Gates" + ("" if g["enforced"] else " (not enforced)"), "",
                "| gate | score | threshold | n | result |", "|---|---:|---:|---:|---|"]
        for r in g["results"]:
            status = "n/a" if r["passed"] is None else ("PASS" if r["passed"] else "FAIL")
            score = f"{r['score']:.3f}" if r["score"] is not None else "-"
            out.append(f"| {r['dataset']}.{r['metric']} | {score} | {r['threshold']:.2f} | {r['n']} | {status} |")
        for note in g["notes"]:
            out.append(f"- {note}")
        if g["enforced"]:
            out += ["", f"**Gate verdict: {'PASS' if g['passed'] else 'FAIL'}**"]
    return "\n".join(out) + "\n"


def save_results(doc: Mapping[str, Any], eval_dir: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    """Write ``<timestamp>.json`` and ``latest.json`` (plus ``latest.md``) under ``eval_dir``."""
    eval_dir.mkdir(parents=True, exist_ok=True)
    stamp = doc["created_at"].replace(":", "").replace("-", "")
    stamped = eval_dir / f"{stamp}.json"
    text = json.dumps(doc, indent=1)
    stamped.write_text(text)
    latest = eval_dir / "latest.json"
    latest.write_text(text)
    (eval_dir / "latest.md").write_text(render_markdown(doc))
    return stamped, latest


__all__ = [
    "CORRECTIONS_ENV", "DATASETS", "PUBLIC_DATASETS", "Dataset", "DatasetOutcome", "Item", "ItemResult", "ItemRun",
    "analyze_item", "evaluate", "load_ballroom", "load_corrections", "load_dataset", "load_giantsteps_key",
    "load_giantsteps_tempo", "load_synthetic", "parse_beats_file", "render_markdown", "render_table",
    "run_dataset", "save_results", "truth_from_corrections",
]
