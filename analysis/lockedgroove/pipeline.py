"""Runs analysis stages in order and assembles the AnalysisReport.

Contract (docs/CONTRACTS.md section 8):

    report = analyze_array(y, sr, file_info=FileInfo(...))
    report, ctx = analyze_array(y, sr, return_context=True)

``y`` may be mono ``(n,)`` or stereo ``(2, n)`` at any sample rate. The
pipeline mixes to mono and resamples to ``ANALYSIS_SR`` for the DSP stages,
and keeps the native signal in ``ctx.native`` for loudness and spectral.

Each stage is ``lockedgroove.analysis.<name>.run(y, sr, ctx)`` returning the
section model or ``None``. A stage that raises leaves its section ``None`` and
records the error in ``ctx.errors``; the rest of the report still ships.
"""

from __future__ import annotations

import importlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np

from . import ANALYSIS_VERSION
from .report import AnalysisReport, FileInfo

log = logging.getLogger(__name__)

ANALYSIS_SR = 22050

# (report field, stage module). Order matters: tempo before beats, beats
# before groove and structure, structure before the per-section stages.
STAGE_ORDER: list[tuple[str, str]] = [
    ("tempo", "tempo"),
    ("beats", "beats"),
    ("onsets", "onsets"),
    ("key", "key"),
    ("groove", "groove"),
    ("loudness", "loudness"),
    ("spectral", "spectral"),
    ("structure", "structure"),
    ("chords", "chords"),
    ("drums", "drums"),
    ("sample_use", "sampleuse"),
    ("instrumentation", "instrumentation"),
    ("effects_estimates", "effects"),
    ("tags", "tags"),
]

# Phase 0 set. Later phases append to this as their stages land.
DEFAULT_STAGES: list[str] = [
    "tempo", "beats", "onsets", "key", "groove", "loudness", "spectral", "structure",
]

FIELD_TO_MODULE = {f: m for f, m in STAGE_ORDER}


@dataclass
class Context:
    """What a stage can see besides its own audio."""

    report: AnalysisReport
    sr: int = ANALYSIS_SR
    native: Optional[tuple[np.ndarray, int]] = None
    """(signal, sample_rate) as loaded; stereo as (2, n) when available."""
    stems: Optional[dict[str, np.ndarray]] = None
    """stem name -> mono float32 at ``sr``; present when separation has run."""
    library_candidates: list[dict[str, Any]] = field(default_factory=list)
    """possible sample sources for sample_use pitch-shift estimation."""
    options: dict[str, Any] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    timings_s: dict[str, float] = field(default_factory=dict)
    on_progress: Optional[Callable[[str, float], None]] = None

    def progress(self, stage: str, fraction: float) -> None:
        if self.on_progress:
            try:
                self.on_progress(stage, fraction)
            except Exception:  # progress must never break analysis
                log.debug("progress callback failed", exc_info=True)


def to_mono(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        return y
    if y.ndim == 2:
        # accept (channels, n) or (n, channels)
        if y.shape[0] > y.shape[1]:
            y = y.T
        return y.mean(axis=0).astype(np.float32)
    raise ValueError(f"unsupported audio shape {y.shape}")


def resample(y: np.ndarray, sr: int, target_sr: int) -> np.ndarray:
    if sr == target_sr:
        return np.asarray(y, dtype=np.float32)
    import librosa

    return librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=target_sr, res_type="soxr_hq")


def _stage_fn(module_name: str) -> Callable:
    mod = importlib.import_module(f"lockedgroove.analysis.{module_name}")
    return getattr(mod, "run")


def analyze_array(
    y: np.ndarray,
    sr: int,
    file_info: Optional[FileInfo] = None,
    stages: Optional[list[str]] = None,
    stems: Optional[dict[str, np.ndarray]] = None,
    library_candidates: Optional[list[dict[str, Any]]] = None,
    options: Optional[dict[str, Any]] = None,
    analysis_version: int = ANALYSIS_VERSION,
    on_progress: Optional[Callable[[str, float], None]] = None,
    return_context: bool = False,
    base_report: Optional[AnalysisReport] = None,
):
    """Analyze an audio array and return the AnalysisReport.

    ``stages`` selects report fields (``"tempo"``, ``"structure"``, ...); the
    default is the Phase 0 set. ``base_report`` lets later phases add
    sections to an existing report without recomputing the earlier ones.
    """
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 2 and y.shape[0] > y.shape[1]:
        y = y.T
    native = (y, sr)
    mono = to_mono(y)
    if not np.isfinite(mono).all():
        mono = np.nan_to_num(mono)
    ya = resample(mono, sr, ANALYSIS_SR)

    if base_report is not None:
        report = base_report.model_copy(deep=True)
    else:
        report = AnalysisReport.empty(file_info or FileInfo(), analysis_version=analysis_version)
    if file_info is not None:
        report.file = file_info
    report.analysis_version = analysis_version
    if report.file.duration_s == 0.0 and sr:
        report.file.duration_s = float(len(mono) / sr)
    if report.file.sample_rate == 0:
        report.file.sample_rate = int(sr)
    if report.file.channels == 0:
        report.file.channels = int(y.shape[0]) if y.ndim == 2 else 1

    ctx = Context(report=report, sr=ANALYSIS_SR, native=native, stems=stems,
                  library_candidates=list(library_candidates or []), options=dict(options or {}),
                  on_progress=on_progress)
    if stems:
        ctx.stems = {name: resample(to_mono(arr), sr, ANALYSIS_SR) for name, arr in stems.items()}

    wanted = list(stages) if stages is not None else list(DEFAULT_STAGES)
    ordered = [(f, m) for f, m in STAGE_ORDER if f in wanted]
    unknown = set(wanted) - {f for f, _ in STAGE_ORDER}
    if unknown:
        raise ValueError(f"unknown stages: {sorted(unknown)}")

    for i, (field_name, module_name) in enumerate(ordered):
        ctx.progress(field_name, i / max(1, len(ordered)))
        t0 = time.perf_counter()
        try:
            fn = _stage_fn(module_name)
            section = fn(ya, ANALYSIS_SR, ctx)
            if field_name == "tags":
                report.tags = list(section or [])
            else:
                setattr(report, field_name, section)
        except ModuleNotFoundError as exc:
            ctx.errors[field_name] = f"stage not available: {exc}"
            log.warning("stage %s not available: %s", field_name, exc)
        except Exception as exc:  # one failing stage must not sink the report
            ctx.errors[field_name] = f"{type(exc).__name__}: {exc}"
            log.exception("stage %s failed", field_name)
        ctx.timings_s[field_name] = time.perf_counter() - t0
    ctx.progress("done", 1.0)

    if return_context:
        return report, ctx
    return report


def analyze_file(path: str, **kwargs):
    """Load a file with ``lockedgroove.ingest`` and analyze it."""
    from .ingest import file_info_for, load_audio

    y, sr = load_audio(path, mono=False)
    info = kwargs.pop("file_info", None) or file_info_for(path, y, sr)
    return analyze_array(y, sr, file_info=info, **kwargs)


__all__ = ["ANALYSIS_SR", "Context", "DEFAULT_STAGES", "STAGE_ORDER", "analyze_array", "analyze_file",
           "resample", "to_mono"]
