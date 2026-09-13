"""Grid helpers shared by the analysis stages and by later phases (loops, chops, drums).

Pure functions over beat and downbeat times in seconds. Nothing here reads audio.

Conventions:
- ``beats_s`` / ``downbeats_s`` are ascending times in seconds (lists or arrays).
- A bar grid is an array of bar start times covering ``[0, duration_s]``. Audio before
  the first bar start (a pickup) belongs to bar 0, so bar indices count full bars from
  the first downbeat and never go negative.
- The 16th grid follows ``lockedgroove.testing.synth.step_time_in_beat``: with
  ``swing_pct`` = 50 the four 16ths of a beat sit at 0, 1/4, 1/2, 3/4 of the beat; with
  66.7 the off-beat 8th sits at 2/3 (triplet swing) and the 16ths halve the two halves.
- Grid offsets are signed milliseconds; positive means the event is late.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

__all__ = [
    "bar_grid", "bar_index", "bar_indices", "beat_period_s", "beat_positions", "beats_per_bar",
    "extend_beats", "nearest_grid_offsets_ms", "sixteenth_grid", "step_fraction",
]


def beats_per_bar(meter: str) -> int:
    """Beats per bar for a meter string, mirroring ``lockedgroove.report._beats_per_bar``.

    Compound meters with an /8 denominator divisible by 3 count dotted-quarter beats
    (6/8 -> 2, 9/8 -> 3). Anything unparseable falls back to 4.
    """
    try:
        num, den = str(meter).split("/")
        num_i, den_i = int(num), int(den)
    except (ValueError, AttributeError):
        return 4
    if den_i == 8 and num_i % 3 == 0:
        return max(1, num_i // 3)
    return max(1, num_i)


def step_fraction(step_in_beat: int, swing_pct: float = 50.0) -> float:
    """Fraction of the beat at which 16th ``step_in_beat`` (0..3) falls for a given swing."""
    s = swing_pct / 100.0
    if step_in_beat < 2:
        return step_in_beat / 2.0 * s
    return s + (step_in_beat - 2) / 2.0 * (1.0 - s)


def beat_period_s(beats_s: Sequence[float] | np.ndarray) -> float:
    """Median inter-beat interval in seconds; 0.0 when there are fewer than two beats."""
    b = np.asarray(beats_s, dtype=float)
    if b.size < 2:
        return 0.0
    d = np.diff(b)
    d = d[d > 0]
    return float(np.median(d)) if d.size else 0.0


def extend_beats(beats_s: Sequence[float] | np.ndarray, duration_s: float, period_s: float | None = None) -> np.ndarray:
    """Extrapolate a beat grid at both ends so it covers ``[0, duration_s]``.

    Backward extrapolation stops at the last grid point that is >= 0 (within 1 ns);
    forward extrapolation adds beats while they fall before ``duration_s``.
    """
    b = np.asarray(beats_s, dtype=float)
    p = float(period_s) if period_s and period_s > 0 else beat_period_s(b)
    if b.size == 0:
        if p > 0 and duration_s > 0:
            return np.arange(0.0, duration_s, p)
        return b
    if p <= 0:
        return b
    before = []
    t = b[0] - p
    while t >= -1e-9:
        before.append(max(t, 0.0))
        t -= p
    after = []
    t = b[-1] + p
    while t < duration_s - 1e-9:
        after.append(t)
        t += p
    return np.concatenate([np.asarray(before[::-1]), b, np.asarray(after)])


def bar_grid(beats_s: Sequence[float] | np.ndarray, downbeats_s: Sequence[float] | np.ndarray,
             meter: str = "4/4", duration_s: float | None = None) -> np.ndarray:
    """Bar start times covering the file.

    Downbeats anchor the grid. The bar length is the median downbeat spacing when there
    are at least two downbeats, else ``beats_per_bar(meter)`` times the beat period. Bars
    are extrapolated backwards (only starts >= 0 are kept; a start within half a beat of
    zero is clamped to 0) and forwards until the last bar reaches ``duration_s``. Without
    downbeats every ``beats_per_bar``-th beat from the first beat is a bar start. With no
    beats at all the whole file is bar 0 (``[0.0]``).
    """
    bpb = beats_per_bar(meter)
    beats = np.asarray(beats_s, dtype=float)
    downs = np.asarray(downbeats_s, dtype=float)
    period = beat_period_s(beats)
    if downs.size == 0:
        if beats.size == 0:
            return np.array([0.0])
        downs = beats[::bpb]
    if downs.size > 1:
        bar_len = float(np.median(np.diff(downs)))
    else:
        bar_len = bpb * period
    if bar_len <= 0:
        return np.array([float(downs[0])])
    before = []
    t = downs[0] - bar_len
    tol = 0.5 * period if period > 0 else 0.0
    while t >= -tol:
        before.append(max(t, 0.0))
        t -= bar_len
    after = []
    if duration_s is not None:
        t = downs[-1] + bar_len
        while t < duration_s - 1e-9:
            after.append(t)
            t += bar_len
    return np.concatenate([np.asarray(before[::-1]), downs, np.asarray(after)])


def bar_index(t_s: float, bar_starts_s: Sequence[float] | np.ndarray) -> int:
    """0-based index of the bar containing ``t_s``; times before the first bar map to 0."""
    bars = np.asarray(bar_starts_s, dtype=float)
    if bars.size == 0:
        return 0
    return int(max(0, np.searchsorted(bars, t_s, side="right") - 1))


def bar_indices(times_s: Sequence[float] | np.ndarray, bar_starts_s: Sequence[float] | np.ndarray) -> np.ndarray:
    """Vectorized ``bar_index``."""
    bars = np.asarray(bar_starts_s, dtype=float)
    t = np.asarray(times_s, dtype=float)
    if bars.size == 0:
        return np.zeros(t.shape, dtype=int)
    return np.maximum(0, np.searchsorted(bars, t, side="right") - 1).astype(int)


def sixteenth_grid(beats_s: Sequence[float] | np.ndarray, swing_pct: float = 50.0, subdivisions: int = 4,
                   extend_to_s: float | None = None) -> np.ndarray:
    """Subdivision grid (16ths by default) built from consecutive beats.

    Each beat interval is split at ``step_fraction`` positions (swing-aware for 4
    subdivisions; ``[0, swing]`` for 2; straight otherwise). One beat is extrapolated
    after the last beat so the final beat has subdivisions. With ``extend_to_s`` the beat
    grid is first extended to cover ``[0, extend_to_s]`` (one extra beat before the first
    grid point, so a pickup region is subdivided too) and grid points outside that range
    are dropped.
    """
    beats = np.asarray(beats_s, dtype=float)
    if beats.size == 0:
        return beats
    period = beat_period_s(beats)
    if period <= 0:
        return beats
    if extend_to_s is not None:
        beats = extend_beats(beats, extend_to_s, period)
        beats = np.concatenate([[beats[0] - period], beats, [beats[-1] + period]])
    else:
        beats = np.append(beats, beats[-1] + period)
    if subdivisions == 4:
        fracs = np.array([step_fraction(k, swing_pct) for k in range(4)])
    elif subdivisions == 2:
        fracs = np.array([0.0, swing_pct / 100.0])
    else:
        fracs = np.arange(max(1, subdivisions)) / max(1, subdivisions)
    starts = beats[:-1]
    lens = np.diff(beats)
    g = (starts[:, None] + fracs[None, :] * lens[:, None]).ravel()
    g = np.append(g, beats[-1])
    if extend_to_s is not None:
        g = g[(g >= -1e-9) & (g <= extend_to_s + 1e-9)]
        g = np.maximum(g, 0.0)
    return g


def nearest_grid_offsets_ms(times_s: Sequence[float] | np.ndarray, grid_s: Sequence[float] | np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Signed offset (ms, positive = late) of each time from its nearest grid point, plus that grid index."""
    t = np.asarray(times_s, dtype=float)
    g = np.asarray(grid_s, dtype=float)
    if t.size == 0 or g.size == 0:
        return np.zeros(0), np.zeros(0, dtype=int)
    if g.size == 1:
        idx = np.zeros(t.shape, dtype=int)
        return (t - g[0]) * 1000.0, idx
    right = np.clip(np.searchsorted(g, t), 1, g.size - 1)
    left = right - 1
    choose_right = np.abs(g[right] - t) < np.abs(t - g[left])
    idx = np.where(choose_right, right, left).astype(int)
    return (t - g[idx]) * 1000.0, idx


def beat_positions(times_s: Sequence[float] | np.ndarray, beats_s: Sequence[float] | np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For each time: the index of the beat it falls in and its fractional position in that beat.

    Times before the first beat map to beat 0 (negative fraction); times after the last
    beat map to the last beat with the last interval as the beat length.
    """
    t = np.asarray(times_s, dtype=float)
    b = np.asarray(beats_s, dtype=float)
    if t.size == 0 or b.size == 0:
        return np.zeros(0, dtype=int), np.zeros(0)
    if b.size == 1:
        return np.zeros(t.shape, dtype=int), np.zeros(t.shape)
    idx = np.clip(np.searchsorted(b, t, side="right") - 1, 0, b.size - 1).astype(int)
    lens = np.append(np.diff(b), b[-1] - b[-2])
    lens = np.where(lens > 0, lens, np.max(lens) if np.max(lens) > 0 else 1.0)
    frac = (t - b[idx]) / lens[idx]
    return idx, frac
