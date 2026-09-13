"""Onsets: ``librosa.onset.onset_detect(backtrack=True, units="time")`` at a fine hop.

The hop is 64 samples (2.9 ms at 22050 Hz) so backtracked onset times are within a few
milliseconds of the true attack; beats and groove reuse ``detect_onsets`` for their
timing measurements. Spectral flux cannot see an attack at the very first sample (there
is no previous frame), so a file whose first ``START_WINDOW_S`` already carries at least
``START_RMS_FRACTION`` of its peak short-time RMS gets an onset at 0.0 (a loop exported
on the one starts with a hit). ``Onsets`` carries no confidence field in the schema; the
method string records the detector and its resolution.
"""

from __future__ import annotations

import numpy as np

from ..report import Onsets

HOP_LENGTH = 64
START_WINDOW_S = 0.023
START_RMS_FRACTION = 0.1
MERGE_TOL_S = 0.01
METHOD = f"librosa.onset.onset_detect(backtrack=True, units=time, hop={HOP_LENGTH}); onset at 0 when the file starts loud"

# one-entry memo so the beats, onsets and groove stages of one pipeline run share the work
_memo: dict[str, tuple[tuple, np.ndarray]] = {}


def _key(y: np.ndarray, sr: int, hop_length: int) -> tuple:
    head = float(np.sum(y[:4096], dtype=np.float64))
    tail = float(np.sum(y[-4096:], dtype=np.float64))
    return (y.ctypes.data, y.shape, y.dtype.str, int(sr), int(hop_length), head, tail, float(np.sum(y[::997], dtype=np.float64)))


def detect_onsets(y: np.ndarray, sr: int, hop_length: int = HOP_LENGTH) -> np.ndarray:
    """Backtracked onset times in seconds (float64 array, ascending). Never raises; empty on silence."""
    y = np.ascontiguousarray(np.asarray(y, dtype=np.float32))
    if y.size == 0 or not np.isfinite(y).all() or not np.any(y):
        return np.zeros(0)
    key = _key(y, sr, hop_length)
    hit = _memo.get("last")
    if hit is not None and hit[0] == key:
        return hit[1].copy()
    try:
        import librosa

        times = librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop_length, backtrack=True, units="time")
        out = np.sort(np.asarray(times, dtype=float))
        if _starts_loud(y, sr):
            out = out[out > MERGE_TOL_S]
            out = np.concatenate([[0.0], out])
    except Exception:
        out = np.zeros(0)
    _memo["last"] = (key, out.copy())
    return out


def _starts_loud(y: np.ndarray, sr: int) -> bool:
    n = max(1, int(START_WINDOW_S * sr))
    if y.size < 2 * n:
        return False
    head = float(np.sqrt(np.mean(y[:n].astype(np.float64) ** 2)))
    frames = y[: (y.size // n) * n].reshape(-1, n).astype(np.float64)
    peak = float(np.sqrt(np.mean(frames ** 2, axis=1)).max())
    return peak > 0 and head >= START_RMS_FRACTION * peak


def run(y: np.ndarray, sr: int, ctx) -> Onsets:
    """Onset times and count. No confidence field in the schema; nothing to derive."""
    times = detect_onsets(y, sr)
    times_list = [round(float(t), 4) for t in times]
    return Onsets(times_s=times_list, method=METHOD, count=len(times_list))


__all__ = ["HOP_LENGTH", "METHOD", "detect_onsets", "run"]
