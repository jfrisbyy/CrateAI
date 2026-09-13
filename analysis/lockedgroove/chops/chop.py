"""Chop a file three ways: transients, grid, manual (BUILD_PACKET section 8).

Every chop is a ``ChopSegment`` (start/end in seconds). ``extract`` cuts the
audio with 3 ms fades so pads never click. Nothing here writes to the
library; the job runner turns segments into ``files`` and ``chops`` rows.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Optional

import numpy as np

MIN_GAP_MS_DEFAULT = 40.0
FADE_MS_DEFAULT = 3.0


@dataclass
class ChopSegment:
    index: int
    start_s: float
    end_s: float
    name: str
    strength: Optional[float] = None
    mode: str = "transients"

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    def to_row(self) -> dict:
        d = asdict(self)
        d.pop("mode", None)
        d.pop("strength", None)
        return d


def _mono(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    return y if y.ndim == 1 else y.mean(axis=0)


def chop_transients(y: np.ndarray, sr: int, count: Optional[int] = None, min_gap_ms: float = MIN_GAP_MS_DEFAULT,
                    onsets_s: Optional[list[float]] = None, end_s: Optional[float] = None) -> list[ChopSegment]:
    """Slices at onsets, 40 ms minimum gap, ranked by onset strength, capped at ``count``.

    Segments run from each kept onset to the next kept onset (the last runs
    to ``end_s`` or the end of the file). Ranking by strength decides which
    onsets survive the cap; the returned list is in time order.
    """
    import librosa

    mono = _mono(y)
    total_s = len(mono) / sr
    end_s = min(end_s, total_s) if end_s is not None else total_s
    if onsets_s is None:
        # pad so an onset at t=0 is detectable (the detector needs a frame before the peak)
        pad = int(0.1 * sr)
        padded = np.concatenate([np.zeros(pad, dtype=np.float32), mono])
        env = librosa.onset.onset_strength(y=padded, sr=sr)
        peaks = librosa.onset.onset_detect(onset_envelope=env, sr=sr, units="frames", backtrack=False)
        strengths = env[peaks] if len(peaks) else np.zeros(0)
        backtracked = librosa.onset.onset_backtrack(peaks, env) if len(peaks) else peaks
        times = np.clip(librosa.frames_to_time(backtracked, sr=sr) - pad / sr, 0.0, None)
    else:
        times = np.asarray(sorted(onsets_s), dtype=float)
        env = librosa.onset.onset_strength(y=mono, sr=sr)
        strengths = np.interp(times, librosa.times_like(env, sr=sr), env)
    # enforce the minimum gap: keep the stronger of two onsets closer than min_gap
    kept: list[tuple[float, float]] = []
    for t, s in sorted(zip(times, strengths)):
        if t >= end_s:
            break
        if kept and (t - kept[-1][0]) * 1000 < min_gap_ms:
            if s > kept[-1][1]:
                kept[-1] = (t, s)
            continue
        kept.append((float(t), float(s)))
    if count is not None and len(kept) > count:
        kept = sorted(sorted(kept, key=lambda ts: ts[1], reverse=True)[:count])
    segs: list[ChopSegment] = []
    for i, (t, s) in enumerate(kept):
        nxt = kept[i + 1][0] if i + 1 < len(kept) else end_s
        if nxt - t <= 0.001:
            continue
        segs.append(ChopSegment(index=len(segs), start_s=t, end_s=float(nxt), name=f"chop {len(segs) + 1}",
                                strength=s, mode="transients"))
    return segs


def chop_grid(bar_times_s: list[float], start_bar: int, end_bar: int, divisions_per_bar: int,
              end_s: Optional[float] = None) -> list[ChopSegment]:
    """``divisions_per_bar`` equal slices per bar across ``[start_bar, end_bar]`` (inclusive, 0-based).

    ``bar_times_s`` are downbeat times; a bar after the last downbeat uses the
    median bar length. Slices are equal within each bar, so they follow the
    tempo even when bars drift.
    """
    if divisions_per_bar < 1:
        raise ValueError("divisions_per_bar must be >= 1")
    bars = list(map(float, bar_times_s))
    if not bars:
        return []
    bar_len = float(np.median(np.diff(bars))) if len(bars) >= 2 else (end_s - bars[0] if end_s else 2.0)
    segs: list[ChopSegment] = []
    for bar in range(start_bar, end_bar + 1):
        if bar < 0:
            continue
        start = bars[bar] if bar < len(bars) else bars[-1] + (bar - len(bars) + 1) * bar_len
        stop = bars[bar + 1] if bar + 1 < len(bars) else start + bar_len
        if end_s is not None:
            if start >= end_s:
                break
            stop = min(stop, end_s)
        edges = np.linspace(start, stop, divisions_per_bar + 1)
        for d in range(divisions_per_bar):
            segs.append(ChopSegment(index=len(segs), start_s=float(edges[d]), end_s=float(edges[d + 1]),
                                    name=f"bar {bar + 1}.{d + 1}", mode="grid"))
    return segs


def chop_manual(markers_s: list[float], end_s: float) -> list[ChopSegment]:
    """Slices between user markers; the last runs to ``end_s``."""
    marks = sorted(float(m) for m in markers_s if 0 <= m < end_s)
    segs: list[ChopSegment] = []
    for i, m in enumerate(marks):
        nxt = marks[i + 1] if i + 1 < len(marks) else end_s
        if nxt - m <= 0.001:
            continue
        segs.append(ChopSegment(index=len(segs), start_s=m, end_s=nxt, name=f"chop {len(segs) + 1}", mode="manual"))
    return segs


def extract(y: np.ndarray, sr: int, seg: ChopSegment, fade_ms: float = FADE_MS_DEFAULT) -> np.ndarray:
    """Cut ``seg`` out of ``y`` with linear fades of ``fade_ms`` at both ends. Returns (channels, n)."""
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        y = y[None, :]
    a = int(round(seg.start_s * sr))
    b = int(round(seg.end_s * sr))
    a = max(0, min(a, y.shape[1]))
    b = max(a, min(b, y.shape[1]))
    out = y[:, a:b].copy()
    n = out.shape[1]
    f = min(int(round(fade_ms / 1000 * sr)), n // 2)
    if f > 0:
        ramp = np.linspace(0.0, 1.0, f, dtype=np.float32)
        out[:, :f] *= ramp
        out[:, n - f:] *= ramp[::-1]
    return out


def chop_filename(base: str, seg: ChopSegment, ext: str = "wav") -> str:
    safe = re.sub(r"[^A-Za-z0-9._#-]+", "-", base).strip("-") or "chop"
    return f"{safe}_chop{seg.index + 1:02d}.{ext}"


__all__ = ["ChopSegment", "FADE_MS_DEFAULT", "MIN_GAP_MS_DEFAULT", "chop_filename", "chop_grid", "chop_manual",
           "chop_transients", "extract"]
