"""The measurements that catch a lossy processing chain.

One producer complaint ("muddy, muffled") turned out to be measurable: a weak
separator threw away 17.6 dB of 8-20 kHz energy that a strong one preserves
exactly, and every stage after it inherited a loss it could not undo. These are
the numbers that found that, written down so a test can run them on every
change.

Two quantities matter, and they fail in different ways:

- ``band_ratio_db`` - energy in a band relative to the whole signal. Air is
  8-20 kHz. A separator that dulls a stem drops it by tens of dB; a stretcher
  that sprays artefacts into the top octave *raises* it. Either direction is a
  defect, so the harness compares magnitudes against a budget.
- ``transient_concentration`` - how much of the energy around an onset sits in
  the first couple of milliseconds. A phase vocoder without phase locking
  spreads a drum hit over tens of milliseconds; the ear hears that as soft,
  washed-out, "not punchy". Position-free measures (crest factor over fixed
  windows) do not separate the engines - measured, they all land within 0.4 dB
  of each other on the same material - so this one works from onset positions.

Everything here is deterministic: no model, no randomness, no sample rate
assumptions beyond Nyquist.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Optional

import numpy as np

AIR_LO_HZ = 8000.0
AIR_HI_HZ = 20000.0
NEAR_MS = 2.0
FAR_MS = 30.0
SILENT_DB = -120.0


def to_mono(y: np.ndarray) -> np.ndarray:
    a = np.asarray(y, dtype=np.float64)
    if a.size == 0:
        return np.zeros(0)
    if a.ndim == 1:
        return np.nan_to_num(a)
    if a.ndim == 2:
        if a.shape[0] > a.shape[1]:
            a = a.T
        return np.nan_to_num(a.mean(axis=0))
    return np.nan_to_num(a.reshape(-1))


def power_spectrum(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """Welch-style averaged power spectrum: (frequencies, power). Empty for empty input."""
    mono = to_mono(y)
    if mono.size == 0 or sr <= 0:
        return np.zeros(0), np.zeros(0)
    n_fft = 4096 if mono.size >= 4096 else 1 << max(4, int(np.ceil(np.log2(mono.size))))
    hop = n_fft // 2
    win = np.hanning(n_fft)
    if mono.size < n_fft:
        mono = np.pad(mono, (0, n_fft - mono.size))
    starts = range(0, max(1, mono.size - n_fft + 1), hop)
    acc = np.zeros(n_fft // 2 + 1)
    frames = 0
    for s in starts:
        seg = mono[s:s + n_fft]
        if seg.size < n_fft:
            break
        acc += np.abs(np.fft.rfft(seg * win)) ** 2
        frames += 1
    if frames == 0:
        return np.zeros(0), np.zeros(0)
    return np.fft.rfftfreq(n_fft, 1.0 / sr), acc / frames


def band_ratio_db(y: np.ndarray, sr: int, lo_hz: float = AIR_LO_HZ, hi_hz: float = AIR_HI_HZ) -> float:
    """``10*log10(energy in [lo, hi] / total energy)``. ``SILENT_DB`` when either is empty.

    Relative, so it does not move when a stage only changes level - which is
    what makes it comparable across a separation, a stretch and a render.
    """
    freqs, power = power_spectrum(y, sr)
    if freqs.size == 0:
        return SILENT_DB
    total = float(power.sum())
    hi = min(hi_hz, sr / 2.0)
    band = float(power[(freqs >= lo_hz) & (freqs <= hi)].sum())
    if total <= 0.0 or band <= 0.0:
        return SILENT_DB
    return float(10.0 * np.log10(band / total))


def air_db(y: np.ndarray, sr: int) -> float:
    """8-20 kHz relative to the whole signal: the number in the bug report."""
    return band_ratio_db(y, sr, AIR_LO_HZ, AIR_HI_HZ)


def detect_onsets_s(y: np.ndarray, sr: int, max_onsets: int = 64) -> list[float]:
    """Onset times in seconds. Used when the caller has no ground truth."""
    mono = to_mono(y)
    if mono.size < sr // 10 or sr <= 0:
        return []
    try:
        import librosa

        times = librosa.onset.onset_detect(y=mono.astype(np.float32), sr=sr, units="time", backtrack=True)
    except Exception:
        return []
    return [float(t) for t in times[:max_onsets]]


def transient_concentration(y: np.ndarray, sr: int, onsets_s: Sequence[float],
                            near_ms: float = NEAR_MS, far_ms: float = FAR_MS) -> float:
    """Mean fraction of onset-local energy inside +-``near_ms`` of the local peak.

    1.0 would be an ideal impulse; a smeared hit trends to ``near_ms/far_ms``.
    The window is re-centred on the local maximum first, so an engine's own
    latency does not count against it.
    """
    mono = to_mono(y)
    if mono.size == 0 or sr <= 0 or not len(onsets_s):
        return 0.0
    near = max(1, int(near_ms * sr / 1000.0))
    far = max(near + 1, int(far_ms * sr / 1000.0))
    vals: list[float] = []
    for t in onsets_s:
        centre = int(round(float(t) * sr))
        if centre - far < 0 or centre + far >= mono.size:
            continue
        seg = mono[centre - far:centre + far]
        peak = int(np.argmax(np.abs(seg)))
        a, b = max(0, peak - near), min(seg.size, peak + near)
        e_far = float(np.sum(seg ** 2))
        if e_far <= 0.0:
            continue
        vals.append(float(np.sum(seg[a:b] ** 2)) / e_far)
    return float(np.mean(vals)) if vals else 0.0


def transient_retention(before: np.ndarray, after: np.ndarray, sr: int, ratio: float = 1.0,
                        onsets_s: Optional[Sequence[float]] = None) -> float:
    """How much of the source's onset sharpness survived. 1.0 = untouched, 0.5 = half smeared away.

    ``ratio`` is the speed-up applied between the two signals (>1 shorter), so
    an onset at ``t`` in ``before`` is expected at ``t / ratio`` in ``after``.
    """
    if onsets_s is None:
        onsets_s = detect_onsets_s(before, sr)
    if not onsets_s:
        return 1.0
    base = transient_concentration(before, sr, onsets_s)
    if base <= 0.0:
        return 1.0
    moved = [t / ratio for t in onsets_s] if ratio else list(onsets_s)
    return float(transient_concentration(after, sr, moved) / base)


@dataclass(frozen=True)
class StageLoss:
    """What one processing stage did to the signal."""

    stage: str
    air_db_before: float
    air_db_after: float
    transient_retention: float
    note: str = ""

    @property
    def air_delta_db(self) -> float:
        """Signed change in the 8-20 kHz ratio. Negative is dulling, positive is added fizz."""
        return self.air_db_after - self.air_db_before

    @property
    def air_loss_db(self) -> float:
        """Magnitude of the change: both directions are damage."""
        return abs(self.air_delta_db)

    def to_json(self) -> dict:
        return {"stage": self.stage, "air_db_before": round(self.air_db_before, 2),
                "air_db_after": round(self.air_db_after, 2), "air_delta_db": round(self.air_delta_db, 2),
                "transient_retention": round(self.transient_retention, 4), "note": self.note}


def measure_stage(stage: str, before: np.ndarray, after: np.ndarray, sr: int, ratio: float = 1.0,
                  onsets_s: Optional[Sequence[float]] = None, note: str = "",
                  band_scale: float = 1.0) -> StageLoss:
    """Measure one stage. ``band_scale`` follows a pitch shift: content that was at
    8 kHz is at ``8 kHz * band_scale`` afterwards, so comparing the fixed band
    either side of a transposition would read the move as damage."""
    return StageLoss(stage=stage, air_db_before=air_db(before, sr),
                     air_db_after=band_ratio_db(after, sr, AIR_LO_HZ * band_scale, AIR_HI_HZ * band_scale),
                     transient_retention=transient_retention(before, after, sr, ratio, onsets_s), note=note)


__all__ = ["AIR_HI_HZ", "AIR_LO_HZ", "SILENT_DB", "StageLoss", "air_db", "band_ratio_db", "detect_onsets_s",
           "measure_stage", "power_spectrum", "to_mono", "transient_concentration", "transient_retention"]
