"""Tempo-match by time-stretch, key-match by pitch-shift, downbeat-align.

``plan_alignment`` is pure arithmetic over the items' effective values, so the
UI can show the plan before any audio is touched. ``apply_plan`` does the
stretch and shift with the best engine available:

  signalsmith  python-stretch bindings for Signalsmith Stretch (MIT); best
               transient handling
  rubberband   pyrubberband (needs the rubberband CLI; GPL, see OPEN_QUESTIONS H.27)
  librosa      phase vocoder fallback, always available

The engine is chosen once per process and named in the render's metadata.
"""

from __future__ import annotations

import importlib
from dataclasses import asdict, dataclass, field
from typing import Literal, Optional

import numpy as np

PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
StretchMode = Literal["transient", "smooth"]
NON_TONAL_TAGS = {"drums", "drum", "break", "percussion", "hats", "kick", "snare", "beatbox"}


@dataclass
class AlignItem:
    file_id: str
    bpm: Optional[float]
    first_downbeat_s: float = 0.0
    tonic: Optional[str] = None
    mode: Optional[str] = None
    tonal: bool = True
    kind: str = "original"
    tags: list[str] = field(default_factory=list)

    @property
    def is_tonal(self) -> bool:
        if not self.tonal:
            return False
        if self.kind == "stem" and any(t in NON_TONAL_TAGS for t in self.tags):
            return False
        return not any(t in NON_TONAL_TAGS for t in self.tags)


@dataclass
class ItemPlan:
    file_id: str
    stretch_ratio: float
    pitch_semitones: float
    offset_s: float
    reason: str


@dataclass
class AlignPlan:
    target_bpm: float
    target_tonic: Optional[str]
    target_mode: Optional[str]
    items: list[ItemPlan]

    def to_json(self) -> dict:
        return {"target_bpm": self.target_bpm, "target_key": ({"tonic": self.target_tonic, "mode": self.target_mode}
                                                              if self.target_tonic else None),
                "items": [asdict(i) for i in self.items]}


def semitone_shift(from_tonic: str, to_tonic: str) -> int:
    """Smallest shift in [-6, 6] taking ``from_tonic`` to ``to_tonic``."""
    d = (PITCH.index(to_tonic) - PITCH.index(from_tonic)) % 12
    return d - 12 if d > 6 else d


def plan_alignment(items: list[AlignItem], target_bpm: Optional[float] = None,
                   target_key: Optional[tuple[str, str]] = None) -> AlignPlan:
    """Default target: the first item's effective values (BUILD_PACKET section 9)."""
    if not items:
        raise ValueError("no items")
    first = items[0]
    bpm = target_bpm or first.bpm or next((i.bpm for i in items if i.bpm), 120.0)
    if target_key is not None:
        tonic, mode = target_key
    else:
        tonal_first = next((i for i in items if i.is_tonal and i.tonic), None)
        tonic, mode = (tonal_first.tonic, tonal_first.mode) if tonal_first else (None, None)
    plans: list[ItemPlan] = []
    for it in items:
        ratio = (bpm / it.bpm) if it.bpm else 1.0
        reasons = []
        if abs(ratio - 1.0) > 1e-6:
            reasons.append(f"stretch ×{ratio:.4f} from {it.bpm:g} to {bpm:g} BPM")
        shift = 0.0
        if tonic and it.is_tonal and it.tonic:
            shift = float(semitone_shift(it.tonic, tonic))
            if shift:
                reasons.append(f"pitch {shift:+g} st from {it.tonic} to {tonic}")
        elif not it.is_tonal:
            reasons.append("no pitch shift: non-tonal")
        # after stretching, the first downbeat moves to first_downbeat_s / ratio; offset so it lands at 0
        offset = -(it.first_downbeat_s / ratio) if ratio else -it.first_downbeat_s
        plans.append(ItemPlan(file_id=it.file_id, stretch_ratio=ratio, pitch_semitones=shift, offset_s=offset,
                              reason="; ".join(reasons) or "as is"))
    return AlignPlan(target_bpm=bpm, target_tonic=tonic, target_mode=mode, items=plans)


# ---------------------------------------------------------------------------
# engines
# ---------------------------------------------------------------------------

_ENGINE: Optional[str] = None


def stretch_engine(prefer: Optional[str] = None) -> str:
    global _ENGINE
    if prefer:
        return prefer
    if _ENGINE is None:
        for name, module in (("signalsmith", "stretch"), ("rubberband", "pyrubberband")):
            try:
                importlib.import_module(module)
                _ENGINE = name
                break
            except Exception:
                continue
        else:
            _ENGINE = "librosa"
    return _ENGINE


def _as_2d(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    return y[None, :] if y.ndim == 1 else y


def time_stretch(y: np.ndarray, sr: int, ratio: float, mode: StretchMode = "transient",
                 engine: Optional[str] = None) -> np.ndarray:
    """Speed up by ``ratio`` (>1 shorter). Returns (channels, n)."""
    y2 = _as_2d(y)
    if abs(ratio - 1.0) < 1e-9:
        return y2.copy()
    eng = stretch_engine(engine)
    if eng == "signalsmith":
        try:
            return _signalsmith(y2, sr, ratio, 0.0)
        except Exception:
            eng = "librosa"
    if eng == "rubberband":
        try:
            import pyrubberband as prb

            out = prb.time_stretch(y2.T, sr, ratio, rbargs={"--crisp": "6"} if mode == "transient" else None)
            return np.asarray(out, dtype=np.float32).T
        except Exception:
            eng = "librosa"
    import librosa

    n_fft = 1024 if mode == "transient" else 4096
    return np.stack([librosa.effects.time_stretch(ch, rate=ratio, n_fft=n_fft) for ch in y2]).astype(np.float32)


def pitch_shift(y: np.ndarray, sr: int, semitones: float, mode: StretchMode = "transient",
                engine: Optional[str] = None) -> np.ndarray:
    y2 = _as_2d(y)
    if abs(semitones) < 1e-9:
        return y2.copy()
    eng = stretch_engine(engine)
    if eng == "signalsmith":
        try:
            return _signalsmith(y2, sr, 1.0, semitones)
        except Exception:
            eng = "librosa"
    if eng == "rubberband":
        try:
            import pyrubberband as prb

            out = prb.pitch_shift(y2.T, sr, semitones)
            return np.asarray(out, dtype=np.float32).T
        except Exception:
            eng = "librosa"
    import librosa

    n_fft = 1024 if mode == "transient" else 4096
    return np.stack([librosa.effects.pitch_shift(ch, sr=sr, n_steps=semitones, n_fft=n_fft) for ch in y2]).astype(np.float32)


def _signalsmith(y2: np.ndarray, sr: int, ratio: float, semitones: float) -> np.ndarray:
    import stretch  # python-stretch bindings

    st = stretch.Signalsmith()
    st.preset(y2.shape[0], sr)
    st.timeFactor = 1.0 / ratio
    st.pitchShift = semitones
    out = st.process(y2)
    return np.asarray(out, dtype=np.float32)


def apply_plan(y: np.ndarray, sr: int, plan: ItemPlan, mode: StretchMode = "transient",
               engine: Optional[str] = None) -> np.ndarray:
    out = time_stretch(y, sr, plan.stretch_ratio, mode, engine)
    if plan.pitch_semitones:
        out = pitch_shift(out, sr, plan.pitch_semitones, mode, engine)
    return out


__all__ = ["AlignItem", "AlignPlan", "ItemPlan", "apply_plan", "pitch_shift", "plan_alignment", "semitone_shift",
           "stretch_engine", "time_stretch"]
