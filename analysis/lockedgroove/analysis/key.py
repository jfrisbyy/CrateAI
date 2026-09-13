"""Key: mean ``chroma_cqt`` correlated with the 24 Krumhansl-Schmuckler profiles.

Method
------
``librosa.feature.chroma_cqt`` (hop 512, per-frame max-normalized) averaged over time
gives a 12-bin pitch-class profile. It is Pearson-correlated with the Krumhansl-Kessler
major and minor key profiles rotated to every tonic (24 candidates). The best
correlation is the key (tonic spelled with sharps, ``report.PITCH_CLASSES``); the
second best is the ``alternate`` with its correlation. Frames are equally weighted, so
the estimate is a pitch-class-set estimate: a Dorian vamp whose most frequent pitch
class is the fifth (Fm-Ab-Bb-Cm) reads as its Aeolian relative (C minor); see
HANDOFF_dsp.md.

Confidence
----------
Normalized gap between the best and second-best profile correlation:
``confidence = min(1, (r1 - r2) / GAP_FULL) * min(1, r1 / STRENGTH_FULL)`` with
``GAP_FULL`` = 0.25 (a gap that large is a clear win) and ``STRENGTH_FULL`` = 0.6 (below
that the best profile itself fits poorly, e.g. drums-only material). Silence or
un-tonal input returns C major with confidence 0.
"""

from __future__ import annotations

import numpy as np

from ..report import PITCH_CLASSES, Key, KeyAlternate

HOP_LENGTH = 512
GAP_FULL = 0.25
STRENGTH_FULL = 0.6
METHOD = "krumhansl-schmuckler on mean chroma_cqt of the harmonic component from C2 (hop 512)"

# Krumhansl & Kessler (1982) tonal hierarchies, C-rooted
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

_memo: dict[str, tuple[tuple, np.ndarray]] = {}


def _key(y: np.ndarray, sr: int, hop_length: int) -> tuple:
    head = float(np.sum(y[:4096], dtype=np.float64))
    tail = float(np.sum(y[-4096:], dtype=np.float64))
    return (y.ctypes.data, y.shape, y.dtype.str, int(sr), int(hop_length), head, tail, float(np.sum(y[::997], dtype=np.float64)))


HPSS_MARGIN = 3.0
CHROMA_FMIN_NOTE = "C2"


def chroma_cqt(y: np.ndarray, sr: int, hop_length: int = HOP_LENGTH) -> np.ndarray:
    """Chroma of the harmonic component (HPSS, margin 3) from C2 up, memoized for one pipeline run.

    Drums leak into a plain chroma: a kick's tail sits on one pitch class and a snare's body on
    another, which biased whole-mix key estimates toward those notes. Harmonic separation plus a
    C2 floor took exact key accuracy on the synthetic set from 0.58 to 0.85; the misses left are
    relative-major readings. Structure and downbeat phase share this chroma.
    """
    import librosa

    y = np.ascontiguousarray(np.asarray(y, dtype=np.float32))
    key = _key(y, sr, hop_length)
    hit = _memo.get("last")
    if hit is not None and hit[0] == key:
        return hit[1].copy()
    try:
        harmonic = librosa.effects.harmonic(y, margin=HPSS_MARGIN) if y.size >= 4096 else y
    except Exception:
        harmonic = y
    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=hop_length, fmin=librosa.note_to_hz(CHROMA_FMIN_NOTE))
    _memo["last"] = (key, chroma.copy())
    return chroma


def correlations(profile: np.ndarray) -> np.ndarray:
    """Pearson correlation of a 12-bin profile with the 24 keys: index = mode * 12 + tonic (0 = major)."""
    out = np.full(24, -1.0)
    if profile.std() <= 0:
        return out
    for m, template in enumerate((MAJOR_PROFILE, MINOR_PROFILE)):
        for k in range(12):
            out[m * 12 + k] = float(np.corrcoef(profile, np.roll(template, k))[0, 1])
    return np.nan_to_num(out, nan=-1.0)


def _default(notes: str) -> Key:
    return Key(tonic="C", mode="major", confidence=0.0, method=METHOD, alternate=None, notes=notes)


def run(y: np.ndarray, sr: int, ctx) -> Key:
    """Key section. Confidence: normalized gap between the best and second-best profile correlation
    (``(r1 - r2) / 0.25``), scaled down when the best correlation is below 0.6."""
    y = np.asarray(y, dtype=np.float32)
    if y.size < 2048 or not np.isfinite(y).all() or not np.any(y):
        return _default("no tonal content (silent or too short)")
    try:
        chroma = chroma_cqt(y, sr)
    except Exception as exc:
        return _default(f"chroma failed: {type(exc).__name__}")
    profile = np.nan_to_num(chroma.mean(axis=1))
    if profile.sum() <= 0 or profile.std() <= 0:
        return _default("flat chroma")
    corr = correlations(profile)
    order = np.argsort(corr)[::-1]
    best, second = int(order[0]), int(order[1])
    r1, r2 = float(corr[best]), float(corr[second])
    confidence = min(1.0, max(0.0, r1 - r2) / GAP_FULL) * min(1.0, max(0.0, r1) / STRENGTH_FULL)
    tonic, mode = PITCH_CLASSES[best % 12], "major" if best < 12 else "minor"
    alt = KeyAlternate(tonic=PITCH_CLASSES[second % 12], mode="major" if second < 12 else "minor", correlation=round(r2, 4))
    return Key(tonic=tonic, mode=mode, confidence=round(float(np.clip(confidence, 0.0, 1.0)), 4), method=METHOD,
               alternate=alt, notes=None)


__all__ = ["GAP_FULL", "HOP_LENGTH", "MAJOR_PROFILE", "METHOD", "MINOR_PROFILE", "STRENGTH_FULL", "chroma_cqt", "correlations", "run"]
