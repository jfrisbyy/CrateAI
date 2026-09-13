"""Onset segmentation and per-hit features shared by enrollment and transcription."""

from __future__ import annotations

import numpy as np

FEATURE_NAMES = [f"mfcc{i}_mean" for i in range(13)] + [f"mfcc{i}_std" for i in range(13)] + [
    "centroid_hz", "zcr", "low_band_ratio", "decay_ms", "rms_db", "bandwidth_hz", "flatness",
]
MIN_GAP_MS_TRANSCRIBE = 60.0
SEGMENT_MS = 120.0


def _mono(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    return y if y.ndim == 1 else y.mean(axis=0)


def detect_onsets(y: np.ndarray, sr: int, min_gap_ms: float = MIN_GAP_MS_TRANSCRIBE) -> np.ndarray:
    """Onset times (s) with a minimum gap; robust to an onset at t = 0."""
    import librosa

    mono = _mono(y)
    pad = int(0.1 * sr)
    padded = np.concatenate([np.zeros(pad, dtype=np.float32), mono])
    env = librosa.onset.onset_strength(y=padded, sr=sr)
    peaks = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="frames", backtrack=False)
    strengths = env[peaks] if len(peaks) else np.zeros(0)
    # backtrack to the attack so timing (and offsets) measure where the hit starts
    starts = librosa.onset.onset_backtrack(peaks, env) if len(peaks) else peaks
    times = librosa.frames_to_time(starts, sr=sr) - pad / sr
    peak_times = librosa.frames_to_time(peaks, sr=sr) - pad / sr
    times = np.asarray([_refine_attack(mono, sr, t0, t1) for t0, t1 in zip(times, peak_times)], dtype=float)
    kept: list[tuple[float, float]] = []
    for t, s in zip(times, strengths):
        t = max(0.0, float(t))
        if kept and (t - kept[-1][0]) * 1000 < min_gap_ms:
            if s > kept[-1][1]:
                kept[-1] = (t, float(s))
            continue
        kept.append((t, float(s)))
    return np.asarray([t for t, _ in kept], dtype=float)


def _envelope(x: np.ndarray, sr: int, ms: float = 2.0) -> np.ndarray:
    """Moving-maximum envelope of |x| over ``ms`` windows (a raw |x| dips to zero every half cycle)."""
    from scipy.ndimage import maximum_filter1d

    n = max(1, int(sr * ms / 1000))
    return maximum_filter1d(np.abs(x), size=n, mode="nearest")


def decay_ms_of(seg: np.ndarray, sr: int, db: float = 20.0) -> float:
    env = _envelope(seg, sr)
    peak = int(np.argmax(env))
    thresh = env[peak] * 10 ** (-db / 20)
    below = np.where(env[peak:] < thresh)[0]
    return float((below[0] if len(below) else len(env) - peak) / sr * 1000.0)


def _refine_attack(mono: np.ndarray, sr: int, t_start: float, t_peak: float, fraction: float = 0.3) -> float:
    """Sample-accurate attack: where the envelope first climbs ``fraction`` of the way from the
    pre-onset level to the local peak.

    Frame-based onsets are quantized to the hop (23 ms at 22050 Hz); offsets
    measured from them would be noise. Measuring against the pre-onset level
    keeps the tail of the previous hit from triggering early.
    """
    a = max(0, int(round(t_start * sr)))
    b = min(len(mono), int(round(t_peak * sr)) + int(0.03 * sr))
    if b <= a + 1:
        return max(0.0, float(t_start))
    pre_a = max(0, a - int(0.01 * sr))
    env = _envelope(mono[pre_a:b], sr)
    pre = float(np.percentile(env[: max(1, a - pre_a)], 90)) if a > pre_a else 0.0
    win = env[a - pre_a:]
    peak = float(np.max(win))
    if peak <= 0 or peak <= pre:
        return max(0.0, float(t_start))
    thresh = pre + fraction * (peak - pre)
    idx = int(np.argmax(win >= thresh))
    return max(0.0, (a + idx) / sr)


def segment(y: np.ndarray, sr: int, onset_s: float, length_ms: float = SEGMENT_MS) -> np.ndarray:
    mono = _mono(y)
    a = max(0, int(round(onset_s * sr)) - int(0.002 * sr))
    b = min(len(mono), a + int(length_ms / 1000 * sr))
    seg = mono[a:b]
    if len(seg) < int(0.02 * sr):
        seg = np.pad(seg, (0, int(0.02 * sr) - len(seg)))
    return seg


def hit_features(seg: np.ndarray, sr: int) -> np.ndarray:
    """MFCC stats, centroid, ZCR, low-band ratio, decay time, level, bandwidth, flatness."""
    import librosa

    seg = np.asarray(seg, dtype=np.float32)
    if np.max(np.abs(seg)) > 0:
        seg = seg / np.max(np.abs(seg))
    n_fft = min(1024, max(256, len(seg)))
    hop = max(64, n_fft // 4)
    mfcc = librosa.feature.mfcc(y=seg, sr=sr, n_mfcc=13, n_fft=n_fft, hop_length=hop)
    S = np.abs(librosa.stft(seg, n_fft=n_fft, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    spec = S.mean(axis=1) + 1e-12
    centroid = float(np.sum(freqs * spec) / np.sum(spec))
    bandwidth = float(np.sqrt(np.sum(((freqs - centroid) ** 2) * spec) / np.sum(spec)))
    flatness = float(np.exp(np.mean(np.log(spec))) / np.mean(spec))
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(seg, frame_length=n_fft, hop_length=hop)))
    low = float(np.sum(spec[freqs < 200.0]) / np.sum(spec))
    decay_ms = decay_ms_of(seg, sr)
    rms_db = float(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9))
    return np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1),
                           [centroid, zcr, low, decay_ms, rms_db, bandwidth, flatness]]).astype(np.float32)


__all__ = ["FEATURE_NAMES", "decay_ms_of", "MIN_GAP_MS_TRANSCRIBE", "SEGMENT_MS", "detect_onsets", "hit_features", "segment"]
