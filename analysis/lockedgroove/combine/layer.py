"""Sum aligned lanes with gain, per-lane filters, and a soft limiter.

Not a sequencer: "these together, like this" (BUILD_PACKET section 9).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.signal import butter, sosfilt


@dataclass
class Lane:
    y: np.ndarray            # (channels, n) at ``sr``
    offset_s: float = 0.0    # where the lane starts on the layer timeline (may be negative)
    gain_db: float = 0.0
    muted: bool = False
    highpass_hz: Optional[float] = None
    lowpass_hz: Optional[float] = None
    name: str = ""


def _filter(y: np.ndarray, sr: int, highpass_hz: Optional[float], lowpass_hz: Optional[float]) -> np.ndarray:
    out = y
    nyq = sr / 2.0
    if highpass_hz and 0 < highpass_hz < nyq:
        sos = butter(2, highpass_hz / nyq, btype="highpass", output="sos")
        out = sosfilt(sos, out, axis=-1)
    if lowpass_hz and 0 < lowpass_hz < nyq:
        sos = butter(2, lowpass_hz / nyq, btype="lowpass", output="sos")
        out = sosfilt(sos, out, axis=-1)
    return np.asarray(out, dtype=np.float32)


def soft_limit(y: np.ndarray, ceiling: float = 0.98, knee: float = 0.7) -> np.ndarray:
    """Transparent below ``knee``, smooth compression to ``ceiling`` above it."""
    a = np.abs(y)
    over = a > knee
    if not np.any(over):
        return y.astype(np.float32)
    out = y.copy()
    span = ceiling - knee
    # tanh knee: maps [knee, inf) -> [knee, ceiling)
    out[over] = np.sign(y[over]) * (knee + span * np.tanh((a[over] - knee) / span))
    return out.astype(np.float32)


def render_layer(lanes: list[Lane], sr: int, length_s: Optional[float] = None, limiter: bool = True,
                 channels: int = 2) -> np.ndarray:
    """Return (channels, n). Lanes with negative offsets are cropped at t = 0."""
    active = [ln for ln in lanes if not ln.muted and ln.y.size]
    if length_s is None:
        ends = [ln.offset_s + ln.y.shape[-1] / sr for ln in active] or [0.0]
        length_s = max(max(ends), 0.0)
    n = int(round(length_s * sr))
    out = np.zeros((channels, n), dtype=np.float32)
    for ln in active:
        y = ln.y if ln.y.ndim == 2 else ln.y[None, :]
        if y.shape[0] == 1 and channels == 2:
            y = np.repeat(y, 2, axis=0)
        elif y.shape[0] > channels:
            y = y[:channels]
        y = _filter(y, sr, ln.highpass_hz, ln.lowpass_hz) * (10 ** (ln.gain_db / 20.0))
        start = int(round(ln.offset_s * sr))
        src_from = max(0, -start)
        dst_from = max(0, start)
        count = min(y.shape[1] - src_from, n - dst_from)
        if count > 0:
            out[:, dst_from:dst_from + count] += y[:y.shape[0], src_from:src_from + count]
    if limiter:
        out = soft_limit(out)
    return out


__all__ = ["Lane", "render_layer", "soft_limit"]
