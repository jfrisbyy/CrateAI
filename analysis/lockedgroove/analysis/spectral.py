"""Spectral: centroid, mid/side stereo width, low/high band ratio, true bandwidth.

Runs on the native signal (``ctx.native``) so the centroid sees content above the
analysis rate's 11 kHz and the width reads the real channels. Bandwidth *depends*
on that: the analysis rate's ceiling is 11.025 kHz and every real upload measured
so far sits above it, so measured on the working copy the answer would always be
the same wrong number. When the native signal is missing the estimate says so and
drops its confidence rather than reporting the working copy's Nyquist as a fact.

- ``centroid_hz_mean``: mean of the per-frame spectral centroid (magnitude STFT, 2048 /
  512) over frames with energy within ``SILENCE_DB`` of the loudest frame, so silence
  does not drag the mean down. 0 for silence.
- ``stereo_width``: from mid/side energy, ``2 * E_side / (E_mid + E_side)`` clipped to
  [0, 1]. Identical channels (or mono) give 0; fully decorrelated channels of equal
  level give 1 (the same quantity as ``1 - correlation(L, R)`` for balanced channels).
- ``low_high_ratio_db``: ``10 * log10(energy below 250 Hz / energy above 4 kHz)`` from the
  summed power spectrum, clamped to ±``RATIO_CLAMP_DB``; 0 when either band is empty.
- ``bandwidth``: the highest frequency still carrying real energy, with the method
  and confidence every estimated value carries (``quality.bandwidth``). This is
  what lets the product say "this flip is limited by the record, not by us".

The first three carry no confidence; those measurements are deterministic.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from ..quality.bandwidth import measure_bandwidth
from ..report import Estimate, Spectral

N_FFT = 2048
HOP_LENGTH = 512
LOW_HZ = 250.0
HIGH_HZ = 4000.0
RATIO_CLAMP_DB = 60.0
SILENCE_DB = 60.0
METHOD = "stft centroid (energy-weighted frames); mid/side energy width; 250 Hz / 4 kHz band ratio"


def _as_channels_first(signal: np.ndarray) -> np.ndarray:
    a = np.asarray(signal, dtype=np.float64)
    if a.ndim == 1:
        a = a[None, :]
    elif a.ndim == 2 and a.shape[0] > a.shape[1] and a.shape[1] <= 8:
        a = a.T
    elif a.ndim != 2:
        a = a.reshape(1, -1)
    return np.nan_to_num(a)


def stereo_width(channels: np.ndarray) -> float:
    if channels.shape[0] < 2:
        return 0.0
    left, right = channels[0], channels[1]
    mid = 0.5 * (left + right)
    side = 0.5 * (left - right)
    e_mid = float(np.sum(mid ** 2))
    e_side = float(np.sum(side ** 2))
    if e_mid + e_side <= 0:
        return 0.0
    return float(np.clip(2.0 * e_side / (e_mid + e_side), 0.0, 1.0))


def centroid_and_ratio(mono: np.ndarray, rate: int) -> tuple[float, float]:
    import librosa

    if mono.size == 0 or not np.any(mono):
        return 0.0, 0.0
    mag = np.abs(librosa.stft(mono.astype(np.float32), n_fft=N_FFT, hop_length=HOP_LENGTH))
    power = mag ** 2
    frame_energy = power.sum(axis=0)
    if frame_energy.max() <= 0:
        return 0.0, 0.0
    keep = frame_energy > frame_energy.max() * 10 ** (-SILENCE_DB / 10)
    centroids = librosa.feature.spectral_centroid(S=mag, sr=rate, n_fft=N_FFT, hop_length=HOP_LENGTH)[0]
    centroid = float(np.mean(centroids[keep])) if np.any(keep) else 0.0
    freqs = librosa.fft_frequencies(sr=rate, n_fft=N_FFT)
    spectrum = power.sum(axis=1)
    low = float(spectrum[freqs < LOW_HZ].sum())
    high = float(spectrum[freqs > HIGH_HZ].sum())
    if low <= 0 or high <= 0:
        ratio = 0.0 if (low <= 0 and high <= 0) else (RATIO_CLAMP_DB if high <= 0 else -RATIO_CLAMP_DB)
    else:
        ratio = float(np.clip(10.0 * np.log10(low / high), -RATIO_CLAMP_DB, RATIO_CLAMP_DB))
    return centroid, ratio


def bandwidth_estimate(channels: np.ndarray, rate: int, *, native: bool) -> Optional[Estimate]:
    """``quality.bandwidth`` as the report's ``Estimate``; ``None`` if it cannot run at all."""
    try:
        measured = measure_bandwidth(channels.mean(axis=0), rate, rate_is_native=native)
    except Exception:
        return None
    return Estimate(**measured.to_json())


def run(y: np.ndarray, sr: int, ctx) -> Spectral:
    """Spectral section (see the module docstring for what does and does not carry confidence)."""
    native = ctx.native is not None
    signal, rate = ctx.native if native else (y, sr)
    rate = int(rate) if rate else int(sr)
    channels = _as_channels_first(signal)
    if channels.shape[1] == 0 or rate <= 0:
        return Spectral(centroid_hz_mean=0.0, stereo_width=0.0, low_high_ratio_db=0.0, method=METHOD)
    try:
        width = stereo_width(channels)
    except Exception:
        width = 0.0
    try:
        centroid, ratio = centroid_and_ratio(channels.mean(axis=0), rate)
    except Exception:
        centroid, ratio = 0.0, 0.0
    return Spectral(centroid_hz_mean=round(float(centroid), 2), stereo_width=round(float(width), 4),
                    low_high_ratio_db=round(float(ratio), 2), method=METHOD,
                    bandwidth=bandwidth_estimate(channels, rate, native=native))


__all__ = ["HIGH_HZ", "LOW_HZ", "METHOD", "RATIO_CLAMP_DB", "bandwidth_estimate", "centroid_and_ratio",
           "run", "stereo_width"]
