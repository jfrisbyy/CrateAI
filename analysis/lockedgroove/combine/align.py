"""Tempo-match by time-stretch, key-match by pitch-shift, downbeat-align.

``plan_alignment`` is pure arithmetic over the items' effective values, so the
UI can show the plan before any audio is touched. ``apply_plan`` does the
stretch and the shift with the best engine installed.

Engines, best first (``ENGINE_ORDER``):

  varispeed     plain resampling. Only usable when the pitch change is exactly
                the one the speed change implies - the turntable move - but
                then it is not an approximation at all, so it is tried first.
  signalsmith   MIT-licensed stretcher, one pass for stretch and shift together.
  rubberband    needs the ``rubberband`` CLI on PATH; GPL, so a licence is
                required for hosting (OPEN_QUESTIONS H.27).
  phase_locked  the in-repo vocoder: identity phase locking plus transient
                reset. No extra dependency, so this is the floor.
  librosa       the plain phase vocoder. Never chosen automatically: it smears
                the 0.73-0.85 ratios this product lives on. Kept selectable so
                the quality harness can measure against it.

The chosen engine is cached per process and reported by ``stretch_engine()`` so
a render can record which one ran.
"""

from __future__ import annotations

import importlib
import logging
import math
from dataclasses import asdict, dataclass, field
from typing import Literal, Optional

import numpy as np

from . import vocoder

log = logging.getLogger(__name__)

PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
StretchMode = Literal["transient", "smooth"]
NON_TONAL_TAGS = {"drums", "drum", "break", "percussion", "hats", "kick", "snare", "beatbox"}

ENGINE_ORDER = ("signalsmith", "rubberband", "phase_locked")
ENGINES = ("varispeed", *ENGINE_ORDER, "librosa")
_ENGINE_MODULES = {"signalsmith": "python_stretch", "rubberband": "pyrubberband"}
COUPLED_TOLERANCE_ST = 0.01
_ENGINE: Optional[str] = None


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


def available_engines() -> list[str]:
    """Every engine that could run here, best first. ``phase_locked`` is always in it."""
    out = []
    for name in ENGINE_ORDER:
        module = _ENGINE_MODULES.get(name)
        if module is None:
            out.append(name)
            continue
        try:
            importlib.import_module(module)
        except Exception:
            continue
        if name == "rubberband" and not _rubberband_binary():
            continue
        out.append(name)
    return out


def _rubberband_binary() -> bool:
    import shutil

    return shutil.which("rubberband") is not None


def stretch_engine(prefer: Optional[str] = None) -> str:
    """The engine that will run. ``prefer`` overrides and is not validated against availability."""
    global _ENGINE
    if prefer:
        if prefer not in ENGINES:
            raise ValueError(f"unknown stretch engine {prefer!r}; choose one of {sorted(ENGINES)}")
        return prefer
    if _ENGINE is None:
        available = available_engines()
        _ENGINE = available[0] if available else "phase_locked"
    return _ENGINE


def reset_engine_cache() -> None:
    """Forget the detected engine. For tests and for a process that changed its image."""
    global _ENGINE
    _ENGINE = None


def _as_2d(y: np.ndarray) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    return y[None, :] if y.ndim == 1 else y


def is_coupled(ratio: float, semitones: float, tolerance_st: float = COUPLED_TOLERANCE_ST) -> bool:
    """True when the pitch change is exactly the one speeding up by ``ratio`` would cause."""
    if ratio <= 0:
        return False
    return abs(semitones - 12.0 * math.log2(ratio)) <= tolerance_st


def resample(y: np.ndarray, orig_sr: float, target_sr: float) -> np.ndarray:
    """(channels, n) resample with the best resampler installed."""
    y2 = _as_2d(y)
    if abs(orig_sr - target_sr) < 1e-9 or y2.shape[1] == 0:
        return y2.copy()
    try:
        import soxr

        return np.asarray(soxr.resample(y2.T, orig_sr, target_sr, quality="VHQ"), dtype=np.float32).T
    except Exception:
        import librosa

        return np.stack([librosa.resample(ch, orig_sr=float(orig_sr), target_sr=float(target_sr))
                         for ch in y2]).astype(np.float32)


def varispeed(y: np.ndarray, sr: int, factor: float) -> np.ndarray:
    """Play ``factor`` times faster: duration divided by ``factor``, pitch up by ``12*log2(factor)``.

    A resample and nothing else, so the only loss is the resampler's, which is
    far below anything a stretcher does.
    """
    if factor <= 0:
        raise ValueError(f"varispeed factor must be positive, got {factor}")
    return resample(y, sr * factor, sr)


def time_stretch(y: np.ndarray, sr: int, ratio: float, mode: StretchMode = "transient",
                 engine: Optional[str] = None) -> np.ndarray:
    """Speed up by ``ratio`` (>1 shorter), pitch unchanged. Returns (channels, n)."""
    return stretch_and_shift(y, sr, ratio, 0.0, mode, engine)


def pitch_shift(y: np.ndarray, sr: int, semitones: float, mode: StretchMode = "transient",
                engine: Optional[str] = None) -> np.ndarray:
    """Shift by ``semitones``, duration unchanged. Returns (channels, n)."""
    return stretch_and_shift(y, sr, 1.0, semitones, mode, engine)


def stretch_and_shift(y: np.ndarray, sr: int, ratio: float, semitones: float,
                      mode: StretchMode = "transient", engine: Optional[str] = None) -> np.ndarray:
    """Both at once, in one pass wherever the engine can do it.

    Doing the two as separate passes runs the signal through the same smearing
    twice for no reason; every engine here except ``rubberband`` does them
    together, and when the two are coupled nothing has to smear at all.
    """
    y2 = _as_2d(y)
    if y2.shape[1] == 0:
        return y2.copy()
    if abs(ratio - 1.0) < 1e-9 and abs(semitones) < 1e-9:
        return y2.copy()
    if ratio <= 0:
        raise ValueError(f"stretch ratio must be positive, got {ratio}")
    if semitones and is_coupled(ratio, semitones):
        return varispeed(y2, sr, ratio)

    chosen = stretch_engine(engine)
    if chosen == "phase_locked":
        return _phase_locked(y2, sr, ratio, semitones, mode)
    try:
        return _ENGINE_FNS[chosen](y2, sr, ratio, semitones, mode)
    except Exception:
        # A render must not fail because an engine is missing from the image, but
        # which one ran is provenance, so the fallback is never silent.
        log.warning("stretch engine %r failed; falling back to the in-repo vocoder", chosen, exc_info=True)
    return _phase_locked(y2, sr, ratio, semitones, mode)


def _signalsmith(y2: np.ndarray, sr: int, ratio: float, semitones: float,
                 mode: StretchMode = "transient") -> np.ndarray:
    from python_stretch import Signalsmith

    processor = Signalsmith.Stretch()
    processor.preset(int(y2.shape[0]), float(sr))
    processor.setTimeFactor(float(ratio))
    if semitones:
        processor.setTransposeSemitones(float(semitones))
    out = processor.process(np.ascontiguousarray(y2, dtype=np.float32))
    return np.asarray(out, dtype=np.float32)


def _rubberband(y2: np.ndarray, sr: int, ratio: float, semitones: float, mode: StretchMode) -> np.ndarray:
    import pyrubberband as prb

    out = y2
    if abs(ratio - 1.0) > 1e-9:
        args = {"--crisp": "6"} if mode == "transient" else None
        out = np.asarray(prb.time_stretch(out.T, sr, ratio, rbargs=args), dtype=np.float32).T
    if semitones:
        out = np.asarray(prb.pitch_shift(out.T, sr, semitones), dtype=np.float32).T
    return np.asarray(out, dtype=np.float32)


def _phase_locked(y2: np.ndarray, sr: int, ratio: float, semitones: float, mode: StretchMode) -> np.ndarray:
    factor = 2.0 ** (semitones / 12.0) if semitones else 1.0
    n_fft = 1024 if mode == "transient" else 4096
    out = vocoder.time_stretch(y2, ratio / factor, n_fft=n_fft, transient_reset=(mode == "transient"))
    return varispeed(out, sr, factor) if semitones else out


def _varispeed_engine(y2: np.ndarray, sr: int, ratio: float, semitones: float, mode: StretchMode) -> np.ndarray:
    if not is_coupled(ratio, semitones):
        raise ValueError("varispeed cannot separate the pitch change from the speed change")
    return varispeed(y2, sr, ratio)


def _librosa(y2: np.ndarray, sr: int, ratio: float, semitones: float, mode: StretchMode) -> np.ndarray:
    import librosa

    n_fft = 1024 if mode == "transient" else 4096
    out = y2
    if abs(ratio - 1.0) > 1e-9:
        out = np.stack([librosa.effects.time_stretch(ch, rate=ratio, n_fft=n_fft) for ch in out]).astype(np.float32)
    if semitones:
        out = np.stack([librosa.effects.pitch_shift(ch, sr=sr, n_steps=semitones, n_fft=n_fft)
                        for ch in out]).astype(np.float32)
    return np.asarray(out, dtype=np.float32)


_ENGINE_FNS = {"varispeed": _varispeed_engine, "signalsmith": _signalsmith, "rubberband": _rubberband,
               "phase_locked": _phase_locked, "librosa": _librosa}


def engine_installed(name: str) -> bool:
    """Whether ``name`` would actually run here. ``librosa`` and ``varispeed`` always would."""
    if name not in ENGINES:
        raise ValueError(f"unknown stretch engine {name!r}; choose one of {sorted(ENGINES)}")
    return name in ("librosa", "varispeed", "phase_locked") or name in available_engines()


def apply_plan(y: np.ndarray, sr: int, plan: ItemPlan, mode: StretchMode = "transient",
               engine: Optional[str] = None) -> np.ndarray:
    return stretch_and_shift(y, sr, plan.stretch_ratio, plan.pitch_semitones, mode, engine)


__all__ = ["AlignItem", "AlignPlan", "ENGINES", "ENGINE_ORDER", "ItemPlan", "apply_plan", "available_engines",
           "engine_installed", "is_coupled", "pitch_shift", "plan_alignment", "resample", "reset_engine_cache",
           "semitone_shift", "stretch_and_shift", "stretch_engine", "time_stretch", "varispeed"]
