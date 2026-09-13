"""Drums: hit detection and classification, per-section 16th-grid patterns, sampled-vs-programmed.

Runs on the ``drums`` stem when present (``ctx.stems``), else on the mix with
a note that accuracy is lower.

Hit classes are rule-based on three cues so the result is explainable:
  kick   energy below 120 Hz dominates
  hat    no body (120-500 Hz) and a bright centroid
  snare  a body plus noise, centroid in the 1-8 kHz range
  other  everything else (toms, percussion, clicks)

Known limitation: a hat stacked with a kick is recovered from the band above
5 kHz (a kick has none there); a hat stacked under a snare is not separable
from the snare's own noise by rules. The pattern then shows the hat missing
on those steps; the narration rounds hat density to 8ths/16ths so the
description stays right.

Source estimate confidence: programmed drums have near-zero timing variance
and near-identical hit spectra; sampled breaks drift and vary. Two scores
are formed from the robust timing spread (ms) and the mean pairwise spectral
similarity of same-class hits; the estimate is the larger score and the
confidence is their normalized separation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ..beatbox.features import decay_ms_of, detect_onsets
from ..report import DrumHit, DrumPattern, Drums
from .. import pipeline as _p
from ._beatgrid import section_bounds, sixteenth_grid

MIN_GAP_MS = 30.0
SEGMENT_MS = 100.0
OPEN_HAT_DECAY_MS = 90.0
GHOST_VELOCITY = 0.45
ACCENT_VELOCITY = 0.8
PROGRAMMED_TIMING_MS = 5.0
BREAK_TIMING_MS = 7.0
PROGRAMMED_SIM = 0.95
BREAK_SIM = 0.85


@dataclass
class HitEvent:
    time_s: float
    cls: str
    velocity: float
    centroid_hz: float
    low_ratio: float
    mid_ratio: float
    decay_ms: float
    spectrum: np.ndarray = field(repr=False)


def _power_spectrum(x: np.ndarray, sr: int, n_fft: int) -> np.ndarray:
    """Mean power per sample of a Hann-windowed, zero-padded segment (length-independent scale)."""
    x = np.asarray(x[:n_fft], dtype=np.float64)
    if len(x) < 32:
        return np.zeros(n_fft // 2 + 1)
    win = np.hanning(len(x))
    padded = np.zeros(n_fft)
    padded[: len(x)] = x * win
    return np.abs(np.fft.rfft(padded)) ** 2 / float(np.sum(win ** 2))


HAT_BAND_HZ = 5000.0
STACKED_HAT_RATIO_OF_HAT = 0.4   # hat-band peak relative to this file's own hats


def _segment_features(seg: np.ndarray, sr: int, pre: np.ndarray | None = None
                      ) -> tuple[float, float, float, float, np.ndarray, float]:
    """Cues from the energy that is NEW at the onset: post-onset spectrum minus the pre-onset spectrum.

    The tail of the previous hit is present on both sides of the onset and
    cancels, so a ghost snare inside a kick's tail still reads as a snare.
    """
    import librosa

    n_fft = min(2048, max(256, len(seg)))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    post = _power_spectrum(seg, sr, n_fft)
    if pre is not None and len(pre) >= 32:
        pre_spec = _power_spectrum(pre, sr, n_fft)
        spec = np.maximum(post - pre_spec, 0.0) + 1e-12
        if spec.sum() < 1e-6 * (post.sum() + 1e-12):
            spec = post + 1e-12
    else:
        spec = post + 1e-12
    total = float(spec.sum())
    centroid = float(np.sum(freqs * spec) / total)
    low = float(spec[freqs < 120.0].sum() / total)
    mid = float(spec[(freqs >= 120.0) & (freqs < 500.0)].sum() / total)
    decay_ms = decay_ms_of(seg, sr)
    high_ratio = float(spec[freqs >= HAT_BAND_HZ].sum() / total)
    mel = librosa.feature.melspectrogram(S=spec[:, None], sr=sr, n_mels=40, n_fft=n_fft).mean(axis=1)
    logmel = np.log(mel + 1e-9)
    logmel = logmel - logmel.mean()
    logmel = logmel / (np.linalg.norm(logmel) + 1e-9)
    return centroid, low, mid, decay_ms, logmel, high_ratio


def _hat_band_peaks(mono: np.ndarray, sr: int, times: list[float], window_ms: float = 15.0
                    ) -> tuple[np.ndarray, np.ndarray]:
    """(peak, decay_ms) of the > HAT_BAND_HZ envelope after each onset: peak in the first ``window_ms``,
    decay measured on the high band alone so a stacked hat isn't given the kick's tail."""
    from scipy.signal import butter, sosfiltfilt

    cutoff = min(HAT_BAND_HZ, sr / 2 * 0.9)
    sos = butter(4, cutoff / (sr / 2), btype="highpass", output="sos")
    hp = sosfiltfilt(sos, mono).astype(np.float32)
    n = int(window_ms / 1000 * sr)
    peaks = np.zeros(len(times))
    decays = np.zeros(len(times))
    for i, t in enumerate(times):
        a = int(round(t * sr))
        if a >= len(hp):
            continue
        peaks[i] = float(np.max(np.abs(hp[a: a + n])))
        tail = hp[a: a + int(0.3 * sr)]
        decays[i] = decay_ms_of(tail, sr) if len(tail) > 32 else 0.0
    return peaks, decays


def classify(centroid_hz: float, low_ratio: float, mid_ratio: float) -> str:
    if low_ratio >= 0.4:
        return "kick"
    if mid_ratio < 0.05 and centroid_hz > 3000:
        return "hat"
    if mid_ratio >= 0.05 and 800 <= centroid_hz <= 9000:
        return "snare"
    return "other"


def detect_hits(y: np.ndarray, sr: int) -> list[HitEvent]:
    mono = np.asarray(y, dtype=np.float32)
    if mono.ndim == 2:
        mono = mono.mean(axis=0)
    peak_global = float(np.max(np.abs(mono))) if mono.size else 0.0
    if peak_global <= 0:
        return []
    seg_n = int(SEGMENT_MS / 1000 * sr)
    onsets = [float(t) for t in detect_onsets(mono, sr, MIN_GAP_MS)]
    primary: list[HitEvent] = []
    for t in onsets:
        a = int(round(t * sr))
        seg = mono[a: a + seg_n]
        if len(seg) < int(0.02 * sr):
            continue
        pre = mono[max(0, a - int(0.04 * sr)): max(0, a - int(0.002 * sr))]
        centroid, low, mid, decay_ms, spectrum, _high = _segment_features(seg, sr, pre if len(pre) >= 32 else None)
        vel = float(np.clip(np.max(np.abs(seg)) / peak_global, 0.02, 1.0))
        primary.append(HitEvent(t, classify(centroid, low, mid), vel, centroid, low, mid, decay_ms, spectrum))
    if not primary:
        return []
    # Second pass: a hat stacked on a kick shows up in the band above HAT_BAND_HZ, where a kick has nothing.
    # The reference is what this file's own (unstacked) hats look like up there.
    hp_peaks, hp_decays = _hat_band_peaks(mono, sr, [h.time_s for h in primary])
    pure_hats = [p for p, h in zip(hp_peaks, primary) if h.cls == "hat"]
    hits: list[HitEvent] = []
    ref = float(np.median(pure_hats)) if len(pure_hats) >= 2 else None
    for p, dec, h in zip(hp_peaks, hp_decays, primary):
        hits.append(h)
        if h.cls == "kick" and ref is not None and p >= STACKED_HAT_RATIO_OF_HAT * ref:
            hits.append(HitEvent(h.time_s, "hat", float(np.clip(p / ref, 0.05, 1.0)) * h.velocity, h.centroid_hz,
                                 0.0, 0.0, float(dec), h.spectrum))
    return hits


def patterns_for(hits: list[HitEvent], report, duration_s: float) -> list[DrumPattern]:
    grid, spb = sixteenth_grid(report, duration_s)
    if len(grid) == 0:
        return []
    patterns: list[DrumPattern] = []
    for idx, start_s, end_s in section_bounds(report, duration_s):
        sec_hits = [h for h in hits if start_s <= h.time_s < end_s]
        g0 = int(np.searchsorted(grid, start_s))
        g1 = int(np.searchsorted(grid, end_s))
        bars_in_section = max(1, int(round((g1 - g0) / spb)))
        per_class: dict[str, dict[int, list[tuple[float, float]]]] = {"kick": {}, "snare": {}, "hat": {}, "other": {}}
        hat_open = 0
        for h in sec_hits:
            g = int(np.argmin(np.abs(grid - h.time_s)))
            step = g % spb
            offset_ms = float((h.time_s - grid[g]) * 1000.0)
            per_class.setdefault(h.cls, {}).setdefault(step, []).append((h.velocity, offset_ms))
            if h.cls == "hat" and h.decay_ms > OPEN_HAT_DECAY_MS:
                hat_open += 1

        def rows(cls: str) -> list[DrumHit]:
            out = []
            for step, vals in sorted(per_class.get(cls, {}).items()):
                vel = float(np.mean([v for v, _ in vals]))
                off = float(np.mean([o for _, o in vals]))
                freq = float(min(1.0, len(vals) / bars_in_section))
                out.append(DrumHit(step=step, velocity=round(vel, 3), frequency=round(freq, 3), offset_ms=round(off, 2)))
            return out

        kick, snare, hat, other = rows("kick"), rows("snare"), rows("hat"), rows("other")
        accents = sorted({h.step for h in kick + snare if h.velocity >= ACCENT_VELOCITY and h.frequency >= 0.5})
        ghosts = sorted({h.step for h in snare if h.velocity < GHOST_VELOCITY and h.frequency >= 0.5})
        n_hats = sum(len(v) for v in per_class.get("hat", {}).values())
        patterns.append(DrumPattern(
            section_index=idx, kick=kick, snare=snare, hat=hat, other=other, accents=accents,
            density_per_bar=round(len(sec_hits) / bars_in_section, 2),
            hat_open_ratio=round(hat_open / n_hats, 3) if n_hats else None, ghost_notes=ghosts,
        ))
    return patterns


def source_estimate(hits: list[HitEvent], report, duration_s: float) -> tuple[str, float, dict]:
    grid, _ = sixteenth_grid(report, duration_s)
    if len(hits) < 8 or len(grid) == 0:
        return "unknown", 0.0, {"reason": "too few hits"}
    offsets = np.asarray([(h.time_s - grid[int(np.argmin(np.abs(grid - h.time_s)))]) * 1000.0 for h in hits])
    med = float(np.median(offsets))
    timing_ms = float(1.4826 * np.median(np.abs(offsets - med)))  # robust spread
    # spectral similarity between hits of the same class AT THE SAME STEP across bars: a programmed
    # loop repeats the same stack per step; a break varies even there
    _, spb = sixteenth_grid(report, duration_s)
    groups: dict[tuple[str, int], list[np.ndarray]] = {}
    for h in hits:
        g = int(np.argmin(np.abs(grid - h.time_s)))
        groups.setdefault((h.cls, g % spb), []).append(h.spectrum)
    sims: list[float] = []
    weights: list[int] = []
    for specs in groups.values():
        if len(specs) < 2:
            continue
        M = np.stack(specs)
        S = M @ M.T
        n = len(specs)
        sims.append(float((S.sum() - np.trace(S)) / (n * (n - 1))))
        weights.append(n)
    sim = float(np.average(sims, weights=weights)) if sims else 0.9
    programmed = float(np.clip((BREAK_TIMING_MS + 1 - timing_ms) / (BREAK_TIMING_MS + 1), 0, 1)) * float(np.clip((sim - BREAK_SIM) / (1 - BREAK_SIM), 0, 1))
    sampled = max(float(np.clip((timing_ms - 3.0) / 8.0, 0, 1)), float(np.clip((PROGRAMMED_SIM - sim) / 0.15, 0, 1)))
    detail = {"timing_spread_ms": round(timing_ms, 2), "spectral_similarity": round(sim, 3),
              "score_programmed": round(programmed, 3), "score_sampled": round(sampled, 3)}
    if programmed >= sampled and programmed > 0.3:
        est = "programmed"
    elif sampled > programmed and sampled > 0.3:
        est = "sampled_break"
    elif programmed > 0 and sampled > 0:
        est = "mixed"
    else:
        est = "unknown"
    conf = float(np.clip(abs(programmed - sampled), 0, 1)) if est in ("programmed", "sampled_break") else 0.3
    return est, conf, detail


def run(y: np.ndarray, sr: int, ctx: "_p.Context") -> Drums:
    if ctx.stems and "drums" in ctx.stems:
        src = ctx.stems["drums"]
        method = "onset hit classification on drums stem"
        note = None
    else:
        src = y
        method = "onset hit classification on mix"
        note = "measured on the mix; separate stems for a cleaner read"
    duration_s = len(y) / sr
    hits = detect_hits(src, sr)
    patterns = patterns_for(hits, ctx.report, duration_s)
    est, conf, detail = source_estimate(hits, ctx.report, duration_s)
    notes = "; ".join(x for x in [note, f"timing spread {detail.get('timing_spread_ms', 'n/a')} ms",
                                  f"hit similarity {detail.get('spectral_similarity', 'n/a')}"] if x)
    return Drums(source_estimate=est, source_confidence=round(conf, 3), patterns=patterns, layered_kick=None,
                 method=method, notes=notes)


__all__ = ["HitEvent", "classify", "detect_hits", "patterns_for", "run", "source_estimate"]
