"""Minimal beat-grid arithmetic used by the stem-aware stages.

Kept private and tiny so the stages don't depend on each other's modules;
``grid.py`` carries the richer helpers.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from ..report import AnalysisReport


def beats_per_bar(meter: Optional[str]) -> int:
    try:
        num, den = (meter or "4/4").split("/")
        n, d = int(num), int(den)
    except (ValueError, AttributeError):
        return 4
    if d == 8 and n % 3 == 0:
        return max(1, n // 3)
    return max(1, n)


def bar_times(report: AnalysisReport, duration_s: float) -> list[float]:
    """Downbeat times covering the file; extrapolated from the beat grid or tempo when needed."""
    b = report.beats
    if b and b.downbeats_s:
        times = list(b.downbeats_s)
        if len(times) >= 2:
            bar_len = float(np.median(np.diff(times)))
        elif b.times_s and len(b.times_s) >= 2:
            bar_len = float(np.median(np.diff(b.times_s))) * beats_per_bar(b.meter)
        else:
            bar_len = 2.0
        while times[-1] + bar_len < duration_s - 1e-6:
            times.append(times[-1] + bar_len)
        return times
    if b and len(b.times_s) >= 2:
        bpb = beats_per_bar(b.meter)
        return [t for i, t in enumerate(b.times_s) if i % bpb == b.downbeat_phase % bpb]
    if report.tempo and report.tempo.bpm:
        bar_len = 60.0 / report.tempo.bpm * 4
        return list(np.arange(0.0, duration_s, bar_len))
    return [0.0]


def bar_index_for(bars: list[float], t: float) -> int:
    return max(0, int(np.searchsorted(np.asarray(bars), t, side="right") - 1))


def sixteenth_grid(report: AnalysisReport, duration_s: float) -> tuple[np.ndarray, int]:
    """(grid times, steps per bar) for the whole file."""
    b = report.beats
    bpb = beats_per_bar(b.meter if b else None)
    if b and len(b.times_s) >= 2:
        beats = np.asarray(b.times_s, dtype=float)
        step = float(np.median(np.diff(beats))) / 4
        # extend the beat list to cover the file
        beats = list(beats)
        while beats[-1] + 4 * step < duration_s:
            beats.append(beats[-1] + 4 * step)
        grid = np.concatenate([np.asarray(beats[i]) + np.arange(4) * (beats[i + 1] - beats[i]) / 4
                               for i in range(len(beats) - 1)] + [np.asarray(beats[-1:])])
        return grid, bpb * 4
    bpm = report.tempo.bpm if report.tempo else 120.0
    step = 60.0 / bpm / 4
    return np.arange(0.0, duration_s, step), bpb * 4


def section_bounds(report: AnalysisReport, duration_s: float) -> list[tuple[int, float, float]]:
    """(section_index, start_s, end_s); one section spanning the file when structure is null."""
    if report.structure and report.structure.sections:
        return [(i, s.start_s, s.end_s) for i, s in enumerate(report.structure.sections)]
    return [(0, 0.0, duration_s)]


__all__ = ["bar_index_for", "bar_times", "beats_per_bar", "section_bounds", "sixteenth_grid"]
