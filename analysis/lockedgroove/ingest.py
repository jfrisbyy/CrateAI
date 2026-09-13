"""Loading audio, hashing, and waveform peaks.

There is deliberately no function here that takes a URL. Files arrive from
Supabase Storage (downloaded to a temp path by the job runner) or from disk.
"""

from __future__ import annotations

import hashlib
import os
from typing import Optional

import numpy as np

from .report import FileInfo

SUPPORTED_EXTENSIONS = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wma"}
PEAK_POINTS = 2000


def sha256_file(path: str, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()


def load_audio(path: str, sr: Optional[int] = None, mono: bool = False) -> tuple[np.ndarray, int]:
    """Return ``(y, sr)``; ``y`` is ``(n,)`` when mono else ``(channels, n)`` float32.

    soundfile handles WAV/AIFF/FLAC/OGG and, with libsndfile >= 1.1, MP3.
    Anything else falls back to librosa's audioread/ffmpeg path.
    """
    y: np.ndarray
    native_sr: int
    try:
        import soundfile as sf

        data, native_sr = sf.read(path, dtype="float32", always_2d=True)
        y = data.T  # (channels, n)
    except Exception:
        import librosa

        y, native_sr = librosa.load(path, sr=None, mono=False)
        y = np.asarray(y, dtype=np.float32)
        if y.ndim == 1:
            y = y[None, :]
    if mono:
        y = y.mean(axis=0).astype(np.float32)
    elif y.shape[0] == 1:
        y = y[0]
    if sr is not None and sr != native_sr:
        import librosa

        y = librosa.resample(y, orig_sr=native_sr, target_sr=sr, res_type="soxr_hq")
        native_sr = sr
    return y, int(native_sr)


def file_info_for(path: str, y: np.ndarray, sr: int, **overrides) -> FileInfo:
    n = y.shape[-1]
    channels = 1 if y.ndim == 1 else int(y.shape[0])
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    info = FileInfo(
        original_filename=os.path.basename(path),
        duration_s=float(n / sr) if sr else 0.0,
        sample_rate=int(sr),
        channels=channels,
        format=ext or None,
    )
    return info.model_copy(update=overrides)


def compute_peaks(y: np.ndarray, points: int = PEAK_POINTS) -> dict:
    """Renderer-agnostic min/max peaks (docs/CONTRACTS.md section 6)."""
    mono = y if y.ndim == 1 else y.mean(axis=0)
    mono = np.asarray(mono, dtype=np.float32)
    n = len(mono)
    mins = np.zeros(points, dtype=np.float32)
    maxs = np.zeros(points, dtype=np.float32)
    if n > 0:
        edges = np.linspace(0, n, points + 1).astype(int)
        for i in range(points):
            a, b = edges[i], edges[i + 1]
            if b <= a:
                b = min(a + 1, n)
            seg = mono[a:b]
            if seg.size:
                mins[i] = seg.min()
                maxs[i] = seg.max()
    peak = float(max(np.max(np.abs(mins)), np.max(np.abs(maxs)), 1e-9))
    scale = 1.0 / peak if peak > 1.0 else 1.0
    return {
        "version": 1,
        "points": points,
        "min": [round(float(v * scale), 3) for v in mins],
        "max": [round(float(v * scale), 3) for v in maxs],
    }


__all__ = ["PEAK_POINTS", "SUPPORTED_EXTENSIONS", "compute_peaks", "file_info_for", "load_audio", "sha256_file"]
