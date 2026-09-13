"""Transcription: record a pattern -> onsets (60 ms gap) -> classify -> grid -> MIDI with real offsets."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import numpy as np

from ..chops.midi import Grid, Hit, MidiResult, drum_midi
from .features import MIN_GAP_MS_TRANSCRIBE, detect_onsets, hit_features, segment
from .train import load_model


@dataclass
class TranscribedHit:
    time_s: float
    cls: str
    confidence: float
    velocity: float
    bar: int
    step: int
    offset_ms: float

    def to_json(self) -> dict[str, Any]:
        return self.__dict__.copy()


def transcribe(y: np.ndarray, sr: int, model_bytes: bytes, grid: Optional[Grid] = None, bpm: Optional[float] = None,
               min_gap_ms: float = MIN_GAP_MS_TRANSCRIBE, first_hit_is_one: bool = True) -> tuple[list[TranscribedHit], MidiResult]:
    """Place hits on ``grid`` (a chosen file's effective grid) or a free grid at ``bpm``.

    With a free grid and ``first_hit_is_one``, the first onset defines the one.
    Offsets are preserved in the MIDI timing and reported per hit for the step view.
    """
    model, _classes = load_model(model_bytes)
    onsets = detect_onsets(y, sr, min_gap_ms)
    if grid is None:
        bpm = bpm or 90.0
        start = float(onsets[0]) if (first_hit_is_one and len(onsets)) else 0.0
        total_s = len(y if y.ndim == 1 else y[0]) / sr
        bars = int(np.ceil(max(total_s - start, 1.0) * bpm / 60.0 / 4)) + 1
        grid = Grid.free(bpm, bars=bars, start_s=start)
    hits: list[TranscribedHit] = []
    mono = y if y.ndim == 1 else y.mean(axis=0)
    peak_global = float(np.max(np.abs(mono))) or 1.0
    for t in onsets:
        seg = segment(y, sr, float(t))
        feats = hit_features(seg, sr)[None, :]
        probs = model.predict_proba(feats)[0]
        idx = int(np.argmax(probs))
        cls = str(model.classes_[idx])
        vel = float(np.clip(np.max(np.abs(seg)) / peak_global, 0.05, 1.0))
        bar, step, _, off = grid.quantize(float(t))
        hits.append(TranscribedHit(float(t), cls, float(probs[idx]), vel, bar, step, off))
    midi = drum_midi([Hit(h.time_s, h.cls, h.velocity) for h in hits], grid)
    midi.meta["hits"] = [h.to_json() for h in hits]
    return hits, midi


def step_view(hits: list[TranscribedHit], steps_per_bar: int = 16) -> list[dict[str, Any]]:
    """Editable step view: one row per bar with class per step."""
    bars: dict[int, dict[int, list[TranscribedHit]]] = {}
    for h in hits:
        bars.setdefault(h.bar, {}).setdefault(h.step, []).append(h)
    view = []
    for bar in sorted(bars):
        row = {"bar": bar, "steps": []}
        for s in range(steps_per_bar):
            cell = bars[bar].get(s, [])
            row["steps"].append({"step": s, "hits": [{"cls": h.cls, "velocity": h.velocity, "offset_ms": h.offset_ms,
                                                     "confidence": h.confidence} for h in cell]})
        view.append(row)
    return view


__all__ = ["TranscribedHit", "step_view", "transcribe"]
