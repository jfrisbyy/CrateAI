"""Sample use: is it loop-based, how many chops, reordered, pitched (BUILD_PACKET section 6).

Works on the ``other`` stem when present (that's where the sample lives),
else on the mix.

  loop period     strongest lag of a beat-synchronous recurrence matrix, in bars
  is_loop_based   repetition strength at that lag (mean similarity of beats one
                  period apart) above LOOP_STRENGTH
  chops           within one period, units (bar, half-bar, beat) are clustered
                  by similarity; the largest unit size showing a repeat gives the
                  chop size. A repeat means a chop was played twice.
  reordering      a repeated unit, or hard seams at unit boundaries (sample
                  discontinuities far larger than the material's own motion)
  pitch shift     best circular chroma rotation against library candidates
                  flagged as possible sources (ctx.library_candidates)

Confidence: the loop strength margin over non-period lags, multiplied by the
chop evidence strength when chops are reported.
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage

from ..report import SampleUse
from .. import pipeline as _p
from ._beatgrid import bar_times, beats_per_bar

LOOP_STRENGTH = 0.6
UNIT_SIM = 0.88
SEAM_RATIO = 0.35        # interior-boundary click ratio
SEAM_CONTRAST = 3.0      # ...and at least this many times the mid-unit reference
MAX_PERIOD_BARS = 16


def beat_features(y: np.ndarray, sr: int, beat_times: list[float], hop: int = 512) -> np.ndarray:
    """Per-beat feature vectors: L2-normalized [chroma(12), mfcc(12)]."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)[1:]
    frames = np.clip(librosa.time_to_frames(np.asarray(beat_times), sr=sr, hop_length=hop), 0, chroma.shape[1])
    feats = []
    for a, b in zip(frames[:-1], frames[1:]):
        if b <= a:
            b = min(a + 1, chroma.shape[1])
        c = np.median(chroma[:, a:b], axis=1) if b > a else np.zeros(12)
        m = np.median(mfcc[:, a:b], axis=1) if b > a else np.zeros(12)
        c = c / (np.linalg.norm(c) + 1e-9)
        m = (m - m.mean()) / (np.linalg.norm(m - m.mean()) + 1e-9)
        v = np.concatenate([c, 0.7 * m])
        feats.append(v / (np.linalg.norm(v) + 1e-9))
    return np.stack(feats) if feats else np.zeros((0, 24))


def lag_profile(F: np.ndarray) -> np.ndarray:
    n = len(F)
    R = F @ F.T
    prof = np.zeros(n)
    for lag in range(1, n):
        prof[lag] = float(np.mean(np.diag(R, lag)))
    return prof


def loop_period(F: np.ndarray, bpb: int) -> tuple[Optional[int], float, float]:
    """(period in bars, strength, margin) from the lag profile at bar multiples."""
    n = len(F)
    if n < 2 * bpb:
        return None, 0.0, 0.0
    prof = lag_profile(F)
    candidates = [k for k in range(1, MAX_PERIOD_BARS + 1) if k * bpb <= n // 2]
    if not candidates:
        return None, 0.0, 0.0
    strengths = {k: prof[k * bpb] for k in candidates}
    best = max(strengths.values())
    # the smallest period within 90 % of the best explains the repetition most simply
    period = next(k for k in candidates if strengths[k] >= 0.9 * best)
    others = [prof[lag] for lag in range(1, n // 2) if lag % (period * bpb) != 0]
    margin = float(strengths[period] - (np.mean(others) if others else 0.0))
    return period, float(strengths[period]), margin


def _cluster_units(units: np.ndarray) -> list[int]:
    if len(units) == 1:
        return [0]
    D = 1.0 - units @ units.T
    iu = np.triu_indices(len(units), 1)
    Z = linkage(np.clip(D[iu], 0, 2), method="average")
    raw = fcluster(Z, t=1.0 - UNIT_SIM, criterion="distance")
    labels: list[int] = []
    seen: dict[int, int] = {}
    for r in raw:
        if r not in seen:
            seen[r] = len(seen)
        labels.append(seen[r])
    return labels


def seam_hardness(y: np.ndarray, sr: int, boundaries_s: list[float], unit_len_s: float) -> float:
    """Broadband click energy at boundaries relative to the material's own high band.

    A raw cut in sustained material is a phase discontinuity, which shows up as
    an impulse above the harmonic content. Measured on a 6 kHz high-pass:
    peak within ±1 ms of the boundary over the 99th percentile elsewhere in
    the neighbouring units. Cuts at zero crossings or with fades are quieter,
    so this is evidence, not proof.
    """
    from scipy.signal import butter, sosfiltfilt

    y = np.asarray(y, dtype=np.float32)
    if len(y) < sr // 10:
        return 0.0
    cutoff = min(6000.0, sr / 2 * 0.9)
    sos = butter(4, cutoff / (sr / 2), btype="highpass", output="sos")
    hp = np.abs(sosfiltfilt(sos, y))
    w = max(1, int(0.001 * sr))
    ratios = []
    for t in boundaries_s:
        i = int(round(t * sr))
        if i <= w or i >= len(hp) - w:
            continue
        seam = float(np.max(hp[i - w: i + w]))
        a, b = max(0, i - int(unit_len_s * sr)), min(len(hp), i + int(unit_len_s * sr))
        inner = np.concatenate([hp[a: max(a, i - 20 * w)], hp[min(b, i + 20 * w): b]])
        typical = float(np.percentile(inner, 99)) + 1e-6 if inner.size else 1e-6
        ratios.append(seam / typical)
    return float(np.median(ratios)) if ratios else 0.0


def chop_analysis(y: np.ndarray, sr: int, F: np.ndarray, beat_times: list[float], period_bars: int, bpb: int
                  ) -> dict:
    """Chop count, order and reordering evidence within one loop period."""
    n_period = period_bars * bpb
    n_periods = len(F) // n_period
    if n_periods < 1:
        return {"chop_count": None, "order": [], "reordering": None, "evidence": 0.0, "unit_beats": None}
    best = None
    for unit_beats in sorted({bpb, max(1, bpb // 2), 1}, reverse=True):
        if n_period % unit_beats:
            continue
        n_units = n_period // unit_beats
        if n_units < 2:
            continue
        # average each unit position across periods so a stable loop gives clean unit fingerprints
        units = []
        for u in range(n_units):
            vecs = [F[p * n_period + u * unit_beats:(p * n_period + (u + 1) * unit_beats)].mean(axis=0)
                    for p in range(n_periods)]
            v = np.mean(vecs, axis=0)
            units.append(v / (np.linalg.norm(v) + 1e-9))
        labels = _cluster_units(np.stack(units))
        # a chop played again later in the period; adjacent identical units are just sustained material
        repeats = sum(1 for i in range(len(labels)) for j in range(i + 2, len(labels))
                      if labels[i] == labels[j] and any(labels[k] != labels[i] for k in range(i + 1, j)))
        boundaries = [beat_times[p * n_period + u * unit_beats] for p in range(n_periods) for u in range(1, n_units)
                      if p * n_period + u * unit_beats < len(beat_times)]
        unit_len_s = unit_beats * float(np.median(np.diff(beat_times))) if len(beat_times) > 1 else 1.0
        hardness = seam_hardness(y, sr, boundaries, unit_len_s)
        # reference: the same measure half a unit away from every boundary (inside the units)
        reference = seam_hardness(y, sr, [b_ + unit_len_s / 2 for b_ in boundaries], unit_len_s)
        hard = hardness >= SEAM_RATIO and hardness >= SEAM_CONTRAST * max(reference, 1e-3)
        if repeats > 0 or hard:
            evidence = min(1.0, 0.5 * min(1.0, repeats / 1.0) + 0.5 * (min(1.0, hardness / (2 * SEAM_RATIO)) if hard else 0.0))
            best = {"chop_count": n_units, "order": labels, "reordering": True, "evidence": max(0.5, evidence),
                    "unit_beats": unit_beats, "seam_hardness": round(hardness, 2), "seam_reference": round(reference, 2),
                    "repeats": repeats}
            break
    if best is None:
        return {"chop_count": None, "order": [], "reordering": False, "evidence": 0.0, "unit_beats": None}
    return best


def pitch_shift_estimate(chroma_mean: np.ndarray, candidates: list[dict]) -> tuple[Optional[float], Optional[str], float]:
    """Best circular rotation of the candidate's chroma onto ours -> semitones in [-5, 6]."""
    best_corr, best_shift, best_id = -1.0, 0, None
    c = chroma_mean - chroma_mean.mean()
    if np.linalg.norm(c) < 1e-9:
        return None, None, 0.0
    for cand in candidates:
        ref = cand.get("chroma")
        if ref is None or len(ref) != 12:
            continue
        r = np.asarray(ref, dtype=float)
        r = r - r.mean()
        if np.linalg.norm(r) < 1e-9:
            continue
        for shift in range(12):
            corr = float(np.dot(c, np.roll(r, shift)) / (np.linalg.norm(c) * np.linalg.norm(r)))
            if corr > best_corr:
                best_corr, best_shift, best_id = corr, shift, cand.get("file_id")
    if best_id is None or best_corr < 0.6:
        return None, None, 0.0
    semis = best_shift - 12 if best_shift > 6 else best_shift
    return float(semis), best_id, float(np.clip((best_corr - 0.6) / 0.4, 0, 1))


def run(y: np.ndarray, sr: int, ctx: "_p.Context") -> SampleUse:
    import librosa

    stems = ctx.stems or {}
    src = stems.get("other", y)
    where = "other stem" if "other" in stems else "mix"
    duration_s = len(y) / sr
    b = ctx.report.beats
    bpb = beats_per_bar(b.meter if b else None)
    if b and len(b.times_s) >= 2 * bpb:
        beats = list(b.times_s)
    else:
        bpm = ctx.report.tempo.bpm if ctx.report.tempo else 120.0
        beats = list(np.arange(0.0, duration_s, 60.0 / bpm))
    if b and b.downbeats_s:
        # start the beat list on a downbeat so bars line up with units
        first = b.downbeats_s[0]
        beats = [t for t in beats if t >= first - 1e-6]
    F = beat_features(src, sr, beats)
    method = f"beat-synchronous recurrence lag + unit clustering on {where}"
    if len(F) < 2 * bpb:
        return SampleUse(is_loop_based=None, confidence=0.0, method=method, notes="too short to measure repetition")
    period, strength, margin = loop_period(F, bpb)
    is_loop = bool(period is not None and strength >= LOOP_STRENGTH)
    loop_conf = float(np.clip(margin / 0.4, 0, 1)) * float(np.clip(strength, 0, 1))
    chops = chop_analysis(src, sr, F, beats, period, bpb) if is_loop and period else {
        "chop_count": None, "order": [], "reordering": None, "evidence": 0.0}
    chroma_mean = librosa.feature.chroma_cqt(y=np.asarray(src, dtype=np.float32), sr=sr).mean(axis=1)
    semis, source_id, pitch_conf = pitch_shift_estimate(chroma_mean, ctx.library_candidates)
    sample_bars: list[int] = []
    if "other" in stems:
        bars = bar_times(ctx.report, duration_s)
        edges = bars + [duration_s]
        lv = []
        for i in range(len(bars)):
            seg = src[int(edges[i] * sr): int(edges[i + 1] * sr)]
            lv.append(20 * np.log10(np.sqrt(np.mean(seg.astype(np.float64) ** 2)) + 1e-9) if len(seg) else -120.0)
        lv_arr = np.asarray(lv)
        thr = max(-45.0, float(lv_arr.max()) - 30.0)
        sample_bars = [i for i, v in enumerate(lv_arr) if v >= thr]
    conf = loop_conf if chops["chop_count"] is None else min(loop_conf, max(chops["evidence"], 0.4))
    notes = f"loop strength {strength:.2f}, margin {margin:.2f}"
    if chops.get("chop_count"):
        notes += f"; chop unit {chops['unit_beats']} beats, seams {chops.get('seam_hardness')}, repeats {chops.get('repeats')}"
    elif is_loop:
        notes += "; no chop evidence, plays as a continuous loop"
    return SampleUse(
        is_loop_based=is_loop if period is not None else None,
        chop_count_estimate=chops["chop_count"],
        chop_reordering_detected=chops["reordering"] if is_loop else None,
        chop_order=list(chops["order"]),
        pitch_shift_semitones_estimate=semis,
        pitch_shift_source_file_id=source_id,
        sample_bars=sample_bars,
        confidence=round(float(conf), 3),
        method=method,
        notes=notes,
    )


__all__ = ["beat_features", "chop_analysis", "lag_profile", "loop_period", "pitch_shift_estimate", "run",
           "seam_hardness"]
