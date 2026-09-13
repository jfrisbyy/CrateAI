"""Signals built so the failure modes are visible.

Ordinary synthetic loops are not a good test of a stretcher: their hits are
already soft, so smearing them costs little and every engine scores the same.
``transient_bed`` is the opposite - broadband hits with a 12 ms decay over a
sustained tonal bed reaching to 11 kHz - which is both the hardest case for a
phase vocoder and exactly what this product does all day, a break under a
melodic sample.

``lossy_copy`` is the other half: a brickwall lowpass, which is what a weak
separator and a low-bitrate encode both leave behind. It is what the harness
uses to prove it can still see the bug it was written for.
"""

from __future__ import annotations

import numpy as np

DEFAULT_SR = 44100
HIT_DECAY_S = 0.012
BODY_DECAY_S = 0.05
BODY_HZ = 180.0
BED_HZ = (220.0, 330.0, 440.0, 6000.0, 11000.0)
BED_GAIN = 0.08


def transient_bed(sr: int = DEFAULT_SR, seconds: float = 4.0, bpm: float = 90.0,
                  seed: int = 0) -> tuple[np.ndarray, list[float]]:
    """Broadband hits on every eighth over a tonal bed. Returns ``(mono signal, onset times)``.

    The onsets are returned rather than detected, so a measurement made with
    them is exact and does not inherit an onset detector's opinion.
    """
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    y = np.zeros(n, dtype=np.float64)
    onsets: list[float] = []
    step = 60.0 / bpm / 2.0
    hit_len = int(0.12 * sr)
    t = 0.05
    while t < seconds - 0.4:
        start = int(t * sr)
        onsets.append(float(t))
        idx = np.arange(hit_len)
        y[start:start + hit_len] += 0.6 * rng.standard_normal(hit_len) * np.exp(-idx / (HIT_DECAY_S * sr))
        y[start:start + hit_len] += 0.5 * np.sin(2 * np.pi * BODY_HZ * idx / sr) * np.exp(-idx / (BODY_DECAY_S * sr))
        t += step
    times = np.arange(n) / sr
    for freq in BED_HZ:
        y += BED_GAIN * np.sin(2 * np.pi * freq * times)
    peak = float(np.max(np.abs(y))) or 1.0
    return (y / (peak * 1.05)).astype(np.float32), onsets


def lossy_copy(y: np.ndarray, sr: int, cutoff_hz: float, floor_db: float = -96.0) -> np.ndarray:
    """A brickwall lowpass at ``cutoff_hz``: what an encoder, or a weak separator, leaves."""
    mono = np.asarray(y, dtype=np.float64).reshape(-1)
    spectrum = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(mono.size, 1.0 / sr)
    spectrum[freqs > cutoff_hz] *= 10 ** (floor_db / 20.0)
    return np.fft.irfft(spectrum, n=mono.size).astype(np.float32)


__all__ = ["DEFAULT_SR", "lossy_copy", "transient_bed"]
