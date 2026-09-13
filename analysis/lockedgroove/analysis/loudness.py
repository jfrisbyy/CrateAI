"""Loudness: BS.1770-4 integrated LUFS, 4x-oversampled true peak, EBU Tech 3342 loudness range.

Runs on the native signal (``ctx.native``: stereo ``(2, n)`` at the file's sample rate
when available) so channel summing and true peak follow the file as delivered; falls back
to the analysis signal.

- ``integrated_lufs``: ``pyloudnorm.Meter(rate).integrated_loudness`` (K-weighting, 400 ms
  blocks, absolute -70 LUFS and relative -10 LU gates). A file shorter than one block is
  zero-padded to 400 ms. Silence (-inf) is reported as ``LUFS_FLOOR`` = -70 so the report
  stays JSON.
- ``true_peak_dbtp``: per-channel 4x polyphase oversampling (``scipy.signal.resample_poly``),
  max absolute sample, in dBTP; digital silence is ``TRUE_PEAK_FLOOR`` = -100.
- ``loudness_range_lu``: short-term loudness on 3 s windows every 100 ms (K-weighted mean
  square via cumulative sums, same channel gains as BS.1770), absolute gate -70 LUFS,
  relative gate 20 LU below the power mean of the gated values, LRA = 95th - 10th
  percentile. Files shorter than 3 s (or fully gated) report 0.

``Loudness`` carries no confidence field; the measurement is deterministic.
"""

from __future__ import annotations

import numpy as np

from ..report import Loudness

LUFS_FLOOR = -70.0
TRUE_PEAK_FLOOR = -100.0
BLOCK_S = 0.4
SHORT_TERM_WIN_S = 3.0
SHORT_TERM_HOP_S = 0.1
ABSOLUTE_GATE_LUFS = -70.0
RELATIVE_GATE_LU = 20.0
CHANNEL_GAINS = (1.0, 1.0, 1.0, 1.41, 1.41)
METHOD = "pyloudnorm BS.1770-4 integrated; true peak 4x oversampled; loudness range EBU Tech 3342 (3 s / 100 ms)"


def _as_channels_last(signal: np.ndarray) -> np.ndarray:
    a = np.asarray(signal, dtype=np.float64)
    if a.ndim == 1:
        a = a[:, None]
    elif a.ndim == 2:
        if a.shape[0] <= 8 and a.shape[0] < a.shape[1]:
            a = a.T
        if a.shape[1] > len(CHANNEL_GAINS):
            a = a[:, : len(CHANNEL_GAINS)]
    else:
        a = a.reshape(-1, 1)
    return np.nan_to_num(a)


def integrated_lufs(data: np.ndarray, rate: int) -> float:
    import pyloudnorm as pyln

    n = data.shape[0]
    min_n = int(np.ceil(BLOCK_S * rate)) + 1
    if n < min_n:
        data = np.pad(data, ((0, min_n - n), (0, 0)))
    value = pyln.Meter(rate).integrated_loudness(data)
    if not np.isfinite(value):
        return LUFS_FLOOR
    return float(max(LUFS_FLOOR, value))


def true_peak_dbtp(data: np.ndarray, rate: int) -> float:
    import scipy.signal

    peak = 0.0
    for c in range(data.shape[1]):
        x = data[:, c]
        if x.size == 0:
            continue
        over = scipy.signal.resample_poly(x, 4, 1) if x.size >= 8 else x
        peak = max(peak, float(np.max(np.abs(over))), float(np.max(np.abs(x))))
    if peak <= 0:
        return TRUE_PEAK_FLOOR
    return float(max(TRUE_PEAK_FLOOR, 20.0 * np.log10(peak)))


def k_weight(x: np.ndarray, rate: int) -> np.ndarray:
    """Apply pyloudnorm's K-weighting stages (high shelf + high pass) to one channel."""
    import pyloudnorm as pyln

    out = np.asarray(x, dtype=np.float64).copy()
    for stage in pyln.Meter(rate)._filters.values():
        out = stage.apply_filter(out)
    return out


def short_term_lufs(data: np.ndarray, rate: int, win_s: float = SHORT_TERM_WIN_S, hop_s: float = SHORT_TERM_HOP_S) -> np.ndarray:
    n, ch = data.shape
    win = int(round(win_s * rate))
    hop = max(1, int(round(hop_s * rate)))
    if n < win or win <= 0:
        return np.zeros(0)
    starts = np.arange(0, n - win + 1, hop)
    power = np.zeros(starts.size)
    for c in range(ch):
        z = k_weight(data[:, c], rate) ** 2
        cs = np.concatenate([[0.0], np.cumsum(z)])
        power += CHANNEL_GAINS[c] * (cs[starts + win] - cs[starts]) / win
    with np.errstate(divide="ignore"):
        return -0.691 + 10.0 * np.log10(power)


def loudness_range_lu(short_term: np.ndarray) -> float:
    st = short_term[np.isfinite(short_term)]
    st = st[st > ABSOLUTE_GATE_LUFS]
    if st.size < 2:
        return 0.0
    relative = -0.691 + 10.0 * np.log10(np.mean(10.0 ** ((st + 0.691) / 10.0))) - RELATIVE_GATE_LU
    st = st[st > relative]
    if st.size < 2:
        return 0.0
    return float(max(0.0, np.percentile(st, 95) - np.percentile(st, 10)))


def run(y: np.ndarray, sr: int, ctx) -> Loudness:
    """Loudness section (no confidence field in the schema; see the module docstring)."""
    signal, rate = ctx.native if ctx.native is not None else (y, sr)
    rate = int(rate) if rate else int(sr)
    data = _as_channels_last(signal)
    if data.shape[0] == 0 or rate <= 0:
        return Loudness(integrated_lufs=LUFS_FLOOR, true_peak_dbtp=TRUE_PEAK_FLOOR, loudness_range_lu=0.0, method=METHOD)
    try:
        lufs = integrated_lufs(data, rate)
    except Exception:
        lufs = LUFS_FLOOR
    try:
        peak = true_peak_dbtp(data, rate)
    except Exception:
        peak = TRUE_PEAK_FLOOR
    try:
        lra = loudness_range_lu(short_term_lufs(data, rate))
    except Exception:
        lra = 0.0
    return Loudness(integrated_lufs=round(lufs, 2), true_peak_dbtp=round(peak, 2), loudness_range_lu=round(lra, 2), method=METHOD)


__all__ = ["LUFS_FLOOR", "METHOD", "TRUE_PEAK_FLOOR", "integrated_lufs", "loudness_range_lu", "run", "short_term_lufs", "true_peak_dbtp"]
