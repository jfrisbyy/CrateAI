"""Instrumentation: per-stem RMS per bar and per section -> present/absent with entry and exit bars.

Needs stems (``ctx.stems``); returns ``None`` without them, which the report
shows as "not measured" with the stems job as the remedy.

Confidence: how far the quietest "present" stem sits above the presence
threshold and the loudest "absent" stem below it, squashed to [0, 1].
"""

from __future__ import annotations

import numpy as np

from ..report import Instrumentation, InstrumentationSection, InstrumentEvent
from .. import pipeline as _p
from ._beatgrid import bar_times, section_bounds

PRESENT_DB = -45.0          # absolute floor
RELATIVE_DB = -30.0         # relative to the stem's loudest bar
SECTION_PRESENCE = 0.5      # fraction of a section's bars where a stem must be present


def bar_rms_db(y: np.ndarray, sr: int, bars: list[float], duration_s: float) -> np.ndarray:
    edges = list(bars) + [duration_s]
    out = np.full(len(bars), -120.0)
    for i in range(len(bars)):
        a, b = int(edges[i] * sr), int(min(edges[i + 1], duration_s) * sr)
        if b > a:
            seg = y[a:b]
            out[i] = 20 * np.log10(np.sqrt(np.mean(seg.astype(np.float64) ** 2)) + 1e-9)
    return out


def presence_matrix(stems: dict[str, np.ndarray], sr: int, bars: list[float], duration_s: float
                    ) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    levels: dict[str, np.ndarray] = {}
    present: dict[str, np.ndarray] = {}
    for name, y in stems.items():
        lv = bar_rms_db(np.asarray(y, dtype=np.float32), sr, bars, duration_s)
        thr = max(PRESENT_DB, float(lv.max()) + RELATIVE_DB)
        levels[name] = lv
        present[name] = lv >= thr
    return levels, present


def run(y: np.ndarray, sr: int, ctx: "_p.Context") -> Instrumentation | None:
    if not ctx.stems:
        return None
    duration_s = len(y) / sr
    bars = bar_times(ctx.report, duration_s)
    levels, present = presence_matrix(ctx.stems, sr, bars, duration_s)
    per_section: list[InstrumentationSection] = []
    for idx, start_s, end_s in section_bounds(ctx.report, duration_s):
        bar_idx = [i for i, t in enumerate(bars) if start_s - 1e-6 <= t < end_s - 1e-6]
        if not bar_idx:
            continue
        names_present = [n for n in present if np.mean(present[n][bar_idx]) >= SECTION_PRESENCE]
        entries: list[InstrumentEvent] = []
        exits: list[InstrumentEvent] = []
        for n in present:
            p = present[n]
            for i in bar_idx:
                if i == 0:
                    continue
                if p[i] and not p[i - 1]:
                    entries.append(InstrumentEvent(instrument=n, bar=i))
                if not p[i] and p[i - 1]:
                    exits.append(InstrumentEvent(instrument=n, bar=i))
        per_section.append(InstrumentationSection(section_index=idx, present=sorted(names_present),
                                                  entries=entries, exits=exits))
    margins = []
    for n in levels:
        thr = max(PRESENT_DB, float(levels[n].max()) + RELATIVE_DB)
        margins.extend(np.abs(levels[n] - thr))
    conf = float(np.clip(np.median(margins) / 12.0, 0.0, 1.0)) if margins else 0.0
    return Instrumentation(per_section=per_section, method="per-stem bar RMS vs threshold", confidence=conf)


__all__ = ["bar_rms_db", "presence_matrix", "run"]
