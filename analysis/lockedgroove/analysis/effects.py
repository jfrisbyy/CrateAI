"""Effects estimates, all labeled rough and capped at 0.6 confidence by design.

reverb_tail_s:       decay slope of the dB envelope after isolated transients -> RT60-style time
sidechain_ducking:   dip of the sustained material's envelope right after each kick
saturation_above_hz: harmonic energy above a spectral-envelope extrapolation
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from ..report import EffectsEstimates, Estimate, SidechainEstimate
from .. import pipeline as _p

CONF_CAP = 0.6


def _env_db(y: np.ndarray, sr: int, frame_ms: float = 10.0, hop_ms: float | None = None) -> tuple[np.ndarray, float]:
    """RMS envelope in dB. ``frame_ms`` must span several periods of the lowest tone to be smooth."""
    n = max(1, int(sr * frame_ms / 1000))
    hop = n if hop_ms is None else max(1, int(sr * hop_ms / 1000))
    if len(y) < n:
        return np.array([-120.0]), hop / sr
    starts = np.arange(0, len(y) - n + 1, hop)
    idx = starts[:, None] + np.arange(n)[None, :]
    frames = y[idx].astype(np.float64)
    rms = np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-9
    return 20 * np.log10(rms), hop / sr


def reverb_tail(y: np.ndarray, sr: int, onsets_s: Optional[list[float]] = None, min_gap_s: float = 0.8) -> Estimate:
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if onsets_s is None:
        onsets_s = list(librosa.onset.onset_detect(y=y, sr=sr, units="time"))
    onsets = sorted(onsets_s)
    env, dt = _env_db(y, sr)
    estimates: list[float] = []
    fits: list[float] = []
    for i, t in enumerate(onsets):
        nxt = onsets[i + 1] if i + 1 < len(onsets) else len(y) / sr
        if nxt - t < min_gap_s:
            continue
        a = int((t + 0.05) / dt)
        b = int(min(nxt - 0.02, t + 3.0) / dt)
        if b - a < 8:
            continue
        seg = env[a:b]
        peak = float(seg[:3].max())
        floor = float(np.percentile(env, 5))
        lo, hi = peak - 5.0, max(peak - 25.0, floor + 6.0)
        mask = (seg <= lo) & (seg >= hi)
        if mask.sum() < 5:
            continue
        x = np.arange(len(seg))[mask] * dt
        slope, intercept = np.polyfit(x, seg[mask], 1)
        if slope >= -1.0:
            continue
        pred = slope * x + intercept
        ss_res = float(np.sum((seg[mask] - pred) ** 2))
        ss_tot = float(np.sum((seg[mask] - seg[mask].mean()) ** 2)) + 1e-9
        r2 = max(0.0, 1 - ss_res / ss_tot)
        estimates.append(60.0 / abs(slope))
        fits.append(r2)
    if not estimates:
        return Estimate(value=None, confidence=0.0, method="decay slope after isolated transients", notes="no isolated transients")
    value = float(np.median(estimates))
    conf = min(CONF_CAP, float(np.mean(fits)) * min(1.0, len(estimates) / 4))
    return Estimate(value=round(value, 2), confidence=conf, method="decay slope after isolated transients",
                    notes=f"rough; {len(estimates)} transients")


def sidechain(sustain: np.ndarray, sr: int, kick_times_s: list[float], method_note: str) -> SidechainEstimate:
    if len(kick_times_s) < 4:
        return SidechainEstimate(detected=False, depth_db=None, confidence=0.0, method=method_note)
    env, dt = _env_db(np.asarray(sustain, dtype=np.float32), sr, frame_ms=30.0, hop_ms=5.0)
    dips: list[float] = []
    for t in kick_times_s:
        i = int(t / dt)  # frame whose window starts at the kick
        pre = env[max(0, i - 16): max(1, i - 2)]          # 80..10 ms before
        post = env[i + 2: i + 20]                          # 10..100 ms after
        if len(pre) < 3 or len(post) < 3 or pre.max() < -60:
            continue
        dips.append(float(np.median(pre) - np.percentile(post, 10)))
    if len(dips) < 4:
        return SidechainEstimate(detected=False, depth_db=None, confidence=0.0, method=method_note)
    dips_arr = np.asarray(dips)
    consistency = float(np.mean(dips_arr >= 1.5))
    depth = float(np.median(dips_arr))
    detected = depth >= 2.0 and consistency >= 0.6
    conf = min(CONF_CAP, consistency * min(1.0, depth / 6.0)) if detected else min(CONF_CAP, 0.5 * (1 - consistency))
    return SidechainEstimate(detected=detected, depth_db=round(depth, 1) if detected else None,
                             confidence=conf, method=method_note)


def saturation_above(y: np.ndarray, sr: int) -> Estimate:
    """Odd-harmonic excess over the strongest low fundamental.

    Symmetric saturation (tape, tubes, clippers) adds mostly odd harmonics.
    When the odd series (3, 5, 7, 9) beats the even series (2, 4, 6, 8) by more
    than 10 dB and the 3rd harmonic sits within 25 dB of the fundamental, the
    value is 3·f0: the frequency above which distortion products appear.
    Rough by design; confidence is fixed at 0.3.
    """
    import librosa

    method = "odd/even harmonic excess over the strongest fundamental"
    y = np.asarray(y, dtype=np.float32)
    if len(y) < sr // 2:
        return Estimate(value=None, confidence=0.0, method=method, notes="too short")
    n_fft = 8192
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=2048)) ** 2
    spec = S.mean(axis=1) + 1e-12
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    low = (freqs >= 50) & (freqs <= 1000)
    if not low.any():
        return Estimate(value=None, confidence=0.0, method=method)
    f0 = float(freqs[low][int(np.argmax(spec[low]))])
    bin_w = freqs[1] - freqs[0]

    def level(f: float) -> float:
        m = np.abs(freqs - f) <= max(bin_w * 2, f * 0.01)
        return 10 * np.log10(spec[m].max()) if m.any() else -200.0

    base = level(f0)
    odd = [level(k * f0) for k in (3, 5, 7, 9) if k * f0 < sr / 2]
    even = [level(k * f0) for k in (2, 4, 6, 8) if k * f0 < sr / 2]
    if not odd or not even:
        return Estimate(value=None, confidence=0.3, method=method, notes="rough; none found")
    odd_db, even_db = float(np.mean(odd)), float(np.mean(even))
    third = odd[0]
    if odd_db - even_db > 10.0 and third > base - 25.0:
        return Estimate(value=round(3 * f0), confidence=0.3, method=method, notes="rough")
    return Estimate(value=None, confidence=0.3, method=method, notes="rough; none found")


def run(y: np.ndarray, sr: int, ctx: "_p.Context") -> EffectsEstimates:
    import librosa

    stems = ctx.stems or {}
    onsets = ctx.report.onsets.times_s if ctx.report.onsets else None
    reverb_src = stems.get("drums", y)
    rv = reverb_tail(reverb_src, sr, onsets if reverb_src is y else None)
    if "drums" in stems:
        kick_src = stems["drums"]
        sustain = sum(v for k, v in stems.items() if k != "drums") if len(stems) > 1 else y
        note = "envelope dip after kicks (stems)"
    else:
        kick_src = y
        sustain = y
        note = "envelope dip after low-band onsets (mix)"
    # kick times: onsets of the low band
    from scipy.signal import butter, sosfilt

    sos = butter(2, min(150.0, sr / 2 - 1) / (sr / 2), btype="lowpass", output="sos")
    low = sosfilt(sos, np.asarray(kick_src, dtype=np.float32)).astype(np.float32)
    kicks = list(librosa.onset.onset_detect(y=low, sr=sr, units="time", backtrack=False))
    if "drums" not in stems:
        # on a mix, the kick's own energy above the low band would read as the opposite of a dip; look above 300 Hz
        sos_hp = butter(2, min(300.0, sr / 2 - 1) / (sr / 2), btype="highpass", output="sos")
        sustain = sosfilt(sos_hp, np.asarray(y, dtype=np.float32)).astype(np.float32)
    sc = sidechain(np.asarray(sustain, dtype=np.float32), sr, kicks, note)
    if "drums" not in stems:
        sc.confidence = min(sc.confidence, 0.4)
    sat = saturation_above(y, sr)
    return EffectsEstimates(reverb_tail_s=rv, sidechain_ducking=sc, saturation_above_hz=sat)


__all__ = ["reverb_tail", "run", "saturation_above", "sidechain"]
