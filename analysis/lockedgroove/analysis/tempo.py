"""Tempo: onset-strength autocorrelation tempogram with a 95 BPM prior, cross-checked by beat_track.

Method
------
1. Onset strength envelope (librosa, hop 256 at 22050 Hz).
2. Local autocorrelation tempogram: 8.9 s Hann windows, each detrended (window mean
   removed so unrhythmic energy does not look periodic) and normalized by its lag-0
   value, averaged over the file (windows hop a quarter window; the same estimate as
   ``librosa.feature.tempogram(...).mean(axis=1)`` at a fraction of the cost).
3. Log-normal prior centered at ``PRIOR_BPM`` (95, OPEN_QUESTIONS 14) with one octave
   standard deviation, restricted to ``[MIN_BPM, MAX_BPM]`` = 50-200 BPM.
4. The strongest prior-weighted peak, refined by parabolic interpolation in the lag
   domain (bin resolution alone is ~1.5 BPM at 90 BPM).
5. Cross-check: ``librosa.beat.beat_track(start_bpm=estimate)`` re-estimates the tempo
   with librosa's own tempogram; if the two disagree by more than 8 % and are not an
   octave apart, the confidence is halved and the disagreement goes in ``notes``.

``alternates_bpm`` is always ``[bpm / 2, bpm * 2]``.

Confidence
----------
Strongest tempogram peak over the second, squashed to [0, 1]:
``confidence = (1 - runner_up / best) * min(1, best / STRENGTH_FULL)``, where ``best``
is the prior-weighted strength of the winning peak and ``runner_up`` the strongest
peak that is *not* a metrical relative of the winner. Metrical relatives are peaks whose
lag is an integer number of 16ths or of 8th-note triplets at the winning tempo (within
``RELATED_TOL`` of a subdivision); they are the alternates, not competitors. The
``best / STRENGTH_FULL`` factor removes confidence when even the best peak is weak
(silence, noise). Silent or too-short audio returns the prior with confidence 0.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from ..report import Tempo

HOP_LENGTH = 256
WINDOW_S = 8.9
PRIOR_BPM = 95.0
PRIOR_STD_OCTAVES = 1.0
MIN_BPM = 50.0
MAX_BPM = 200.0
RELATED_TOL = 0.25
STRENGTH_FULL = 0.3
CROSS_CHECK_TOL = 0.08
METHOD = "autocorrelation tempogram with a Fourier-tempogram family check, prior 95 BPM (50-200), parabolic peak; beat_track cross-check"


def _windowed_autocorrelation(oenv: np.ndarray, win: int, hop: int) -> np.ndarray:
    """Mean of per-window, detrended, lag-0-normalized autocorrelations of the onset envelope."""
    import librosa
    import scipy.signal

    pad = win // 2
    x = np.pad(oenv.astype(np.float64), pad, mode="linear_ramp")
    if x.size < win:
        x = np.pad(x, (0, win - x.size))
    frames = librosa.util.frame(x, frame_length=win, hop_length=hop)
    frames = frames - frames.mean(axis=0, keepdims=True)
    w = scipy.signal.get_window("hann", win, fftbins=True)[:, None]
    ac = librosa.autocorrelate(frames * w, axis=0)
    ac = librosa.util.normalize(ac, norm=np.inf, axis=0)
    return ac.mean(axis=1)


def _fourier_strength(oenv: np.ndarray, sr: int, win: int, bpms: np.ndarray) -> np.ndarray:
    """Time-averaged Fourier tempogram magnitude, resampled onto the autocorrelation's BPM axis, max 1.

    The autocorrelation of a beat pattern peaks at every multiple of the beat period (the half
    tempo is as strong as the tempo); the Fourier tempogram peaks at the pulse rate and its
    harmonics (the double tempo). Their product keeps only what both agree on, which pins the
    octave family so the truth is always the pick or an alternate.
    """
    import librosa

    F = np.abs(librosa.feature.fourier_tempogram(onset_envelope=oenv, sr=sr, hop_length=HOP_LENGTH, win_length=win))
    F = F.mean(axis=1)
    fbpm = librosa.fourier_tempo_frequencies(sr=sr, hop_length=HOP_LENGTH, win_length=win)
    finite = np.isfinite(bpms)
    out = np.zeros_like(bpms, dtype=np.float64)
    out[finite] = np.interp(bpms[finite], fbpm, F)
    band = finite & (bpms >= MIN_BPM) & (bpms <= MAX_BPM)
    peak = float(out[band].max()) if band.any() else 0.0
    return out / peak if peak > 0 else np.ones_like(out)


def _metrically_related(lag: float, lag_best: float, tol: float = RELATED_TOL) -> bool:
    for subdivisions in (4, 3):  # 16ths and 8th-note triplets
        unit = lag_best / subdivisions
        r = lag / unit
        if round(r) >= 1 and abs(r - round(r)) < tol:
            return True
    return False


def estimate(y: np.ndarray, sr: int) -> Optional[tuple[float, float, float, Optional[str]]]:
    """Return ``(bpm, confidence, best_strength, notes)`` or ``None`` when nothing periodic was found."""
    import librosa
    import scipy.signal

    y = np.asarray(y, dtype=np.float32)
    if y.size < int(2 * 60.0 / MIN_BPM * sr) or not np.any(y):
        return None
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    if oenv.size < 4 or not np.isfinite(oenv).all() or oenv.max() <= 0:
        return None
    win = int(round(WINDOW_S * sr / HOP_LENGTH))
    ac = _windowed_autocorrelation(oenv, win, max(1, win // 4))
    bpms = librosa.tempo_frequencies(ac.size, hop_length=HOP_LENGTH, sr=sr)
    with np.errstate(divide="ignore", invalid="ignore"):
        log_ratio = np.log2(np.maximum(bpms, 1e-9) / PRIOR_BPM)
    prior = np.exp(-0.5 * (log_ratio / PRIOR_STD_OCTAVES) ** 2)
    ac_pos = np.maximum(ac, 0.0)
    band = np.isfinite(bpms) & (bpms >= MIN_BPM) & (bpms <= MAX_BPM)
    ac_peak = float(ac_pos[band].max()) if band.any() else 0.0
    ac_norm = ac_pos / ac_peak if ac_peak > 0 else ac_pos
    strength = np.nan_to_num(np.where(band, ac_norm * prior, 0.0))
    if not np.any(strength > 0):
        return None
    # 1. the tempo family: where the autocorrelation and the Fourier tempogram agree (no prior)
    fourier = _fourier_strength(oenv, sr, win, bpms)
    family = np.nan_to_num(np.where(band, ac_norm * fourier, 0.0))
    fam_lag = float(np.argmax(family)) if np.any(family > 0) else float(np.argmax(strength))
    # 2. the octave inside the family: the prior-weighted autocorrelation at half, same and double
    candidates = [fam_lag * 2.0, fam_lag, fam_lag / 2.0]
    best_idx, best_val = -1, -1.0
    for cand in candidates:
        c = int(round(cand))
        if c < 1 or c >= strength.size - 1 or not band[c]:
            continue
        lo, hi = max(1, c - 2), min(strength.size - 1, c + 3)
        local = lo + int(np.argmax(strength[lo:hi]))
        if strength[local] > best_val:
            best_idx, best_val = local, float(strength[local])
    if best_idx < 0:
        best_idx = int(np.argmax(strength))
    p = best_idx
    best = float(strength[p])
    a, b, c = strength[p - 1], strength[p], strength[p + 1]
    denom = a - 2 * b + c
    delta = 0.5 * (a - c) / denom if denom != 0 else 0.0
    lag = p + float(np.clip(delta, -0.5, 0.5))
    bpm = 60.0 * sr / (HOP_LENGTH * lag)
    bpm = float(np.clip(bpm, MIN_BPM, MAX_BPM))
    peaks, props = scipy.signal.find_peaks(strength, height=0.0)
    heights = props["peak_heights"] if peaks.size else np.zeros(0)
    order = np.argsort(heights)[::-1]
    runner_up = 0.0
    for o in order:
        if abs(float(peaks[o]) - p) <= 2 or _metrically_related(float(peaks[o]), lag):
            continue
        runner_up = float(heights[o])
        break
    confidence = (1.0 - runner_up / best) * min(1.0, best / STRENGTH_FULL)
    notes = None
    # cross-check with librosa's own tempo estimate inside beat_track
    try:
        est, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=HOP_LENGTH, start_bpm=bpm,
                                             units="time", trim=False)
        est = float(np.atleast_1d(est)[0])
        if est > 0:
            ratio = est / bpm
            octave = any(abs(ratio - k) / k <= CROSS_CHECK_TOL for k in (0.5, 1.0, 2.0))
            if not octave:
                confidence *= 0.5
                notes = f"beat_track prefers {est:.1f} BPM"
    except Exception:
        pass
    return bpm, float(np.clip(confidence, 0.0, 1.0)), best, notes


def run(y: np.ndarray, sr: int, ctx) -> Tempo:
    """Tempo section. Confidence: strongest tempogram peak over the second (metrical relatives excluded),
    squashed to [0, 1] and scaled by the peak strength; see the module docstring."""
    try:
        result = estimate(y, sr)
    except Exception as exc:  # never sink the report on odd input
        result = None
        notes = f"estimate failed: {type(exc).__name__}"
    else:
        notes = None
    if result is None:
        bpm = PRIOR_BPM
        return Tempo(bpm=bpm, confidence=0.0, method=METHOD, alternates_bpm=[bpm / 2, bpm * 2],
                     notes=notes or "no periodic onset structure (silent or too short); prior returned")
    bpm, confidence, _best, notes = result
    bpm = round(bpm, 3)
    return Tempo(bpm=bpm, confidence=round(confidence, 4), method=METHOD, alternates_bpm=[bpm / 2, bpm * 2], notes=notes)


__all__ = ["HOP_LENGTH", "MAX_BPM", "METHOD", "MIN_BPM", "PRIOR_BPM", "estimate", "run"]
