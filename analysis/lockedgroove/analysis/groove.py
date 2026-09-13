"""Groove: swing from the off-beat 8th position, timing deviation from the 16th grid.

Method
------
Beats come from ``effective(ctx.report).beats`` (user edits respected), onsets from
``ctx.report.onsets`` (or ``onsets.detect_onsets`` when that section is absent).

- ``swing_pct``: for every beat interval, the onsets whose position in the beat falls in
  the off-beat 8th region (``OFF8_LO``..``OFF8_HI`` = 40..72 % of the beat; the straight
  16ths at 25 % and 75 % stay outside) give a per-beat median position; the median of
  those over all beats, times 100, is the swing (50 = straight, 66.7 = triplet). At least
  ``MIN_SWING_BEATS`` beats must carry an off-beat 8th, otherwise the swing is reported as
  50 (unmeasurable) and the confidence is scaled by ``UNMEASURED_SWING_FACTOR``.
- ``timing_deviation_ms``: signed offset (positive = late) of every onset from the nearest
  point of the *swing-adjusted* 16th grid (``grid.sixteenth_grid`` with the measured
  swing), so a tight but swung loop reads as tight and the deviation measures looseness,
  not swing. Mean and standard deviation in milliseconds.
- ``feel``: ``swung`` when swing > ``SWUNG_MIN`` (54); else ``loose`` when the deviation
  std exceeds ``LOOSE_STD_MS`` (20 ms); else ``straight`` (swing within 50 ± 4 and tight).

Confidence
----------
Inverse of onset-timing variance once beats are trusted:
``confidence = beats.confidence * 1 / (1 + (std_ms / VAR0_MS) ** 2) * min(1, n_onsets / 16)``
(``VAR0_MS`` = 20 ms: a 20 ms deviation std halves the confidence), times 0.8 when the
swing could not be measured. No beats or fewer than four onsets gives confidence 0.
"""

from __future__ import annotations

import numpy as np

from ..report import Groove, TimingDeviation, effective
from . import grid
from .onsets import detect_onsets

OFF8_LO = 0.40
OFF8_HI = 0.72
MIN_SWING_BEATS = 4
SWUNG_MIN = 54.0
LOOSE_STD_MS = 20.0
VAR0_MS = 20.0
UNMEASURED_SWING_FACTOR = 0.8
MIN_ONSETS = 4
METHOD = "off-beat 8th position (median over beats) for swing; onset offsets from the swing-adjusted 16th grid"


def measure_swing(beats: np.ndarray, onsets: np.ndarray) -> tuple[float, int]:
    """Swing percentage and the number of beats that carried an off-beat 8th onset."""
    if beats.size < 2 or onsets.size == 0:
        return 50.0, 0
    inside = onsets[(onsets >= beats[0]) & (onsets < beats[-1])]
    if inside.size == 0:
        return 50.0, 0
    bidx, frac = grid.beat_positions(inside, beats)
    per_beat = []
    for i in np.unique(bidx):
        f = frac[bidx == i]
        f = f[(f >= OFF8_LO) & (f <= OFF8_HI)]
        if f.size:
            per_beat.append(float(np.median(f)))
    if len(per_beat) < MIN_SWING_BEATS:
        return 50.0, len(per_beat)
    return float(100.0 * np.median(per_beat)), len(per_beat)


def _default(confidence: float = 0.0) -> Groove:
    return Groove(swing_pct=50.0, timing_deviation_ms=TimingDeviation(mean=0.0, std=0.0), feel="straight",
                  method=METHOD, confidence=confidence)


def run(y: np.ndarray, sr: int, ctx) -> Groove:
    """Groove section. Confidence: beats confidence times the inverse of the onset-timing variance
    (``1 / (1 + (std / 20 ms)^2)``), scaled by the amount of evidence; see the module docstring."""
    report = effective(ctx.report)
    beats = np.asarray(report.beats.times_s, dtype=float) if report.beats is not None else np.zeros(0)
    beats_conf = float(report.beats.confidence) if report.beats is not None else 0.0
    if report.onsets is not None:
        onsets = np.asarray(report.onsets.times_s, dtype=float)
    else:
        onsets = detect_onsets(y, sr)
    onsets = np.sort(onsets[np.isfinite(onsets)])
    if beats.size < 2 or onsets.size < MIN_ONSETS:
        return _default()
    try:
        swing, n_swing = measure_swing(beats, onsets)
        measured = n_swing >= MIN_SWING_BEATS
        duration = float(len(y) / sr) if sr else float(beats[-1])
        sixteenths = grid.sixteenth_grid(beats, swing_pct=swing, extend_to_s=max(duration, float(beats[-1])))
        offsets, _ = grid.nearest_grid_offsets_ms(onsets, sixteenths)
    except Exception:
        return _default()
    if offsets.size == 0:
        return _default()
    mean_ms = float(np.mean(offsets))
    std_ms = float(np.std(offsets))
    if measured and swing > SWUNG_MIN:
        feel = "swung"
    elif std_ms > LOOSE_STD_MS:
        feel = "loose"
    else:
        feel = "straight"
    confidence = beats_conf * (1.0 / (1.0 + (std_ms / VAR0_MS) ** 2)) * min(1.0, onsets.size / 16.0)
    if not measured:
        confidence *= UNMEASURED_SWING_FACTOR
    return Groove(
        swing_pct=round(float(swing), 2),
        timing_deviation_ms=TimingDeviation(mean=round(mean_ms, 2), std=round(std_ms, 2)),
        feel=feel,
        method=METHOD,
        confidence=round(float(np.clip(confidence, 0.0, 1.0)), 4),
    )


__all__ = ["LOOSE_STD_MS", "METHOD", "OFF8_HI", "OFF8_LO", "SWUNG_MIN", "measure_swing", "run"]
