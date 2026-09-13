"""Beat tracking behind one interface (BUILD_PACKET section 2: librosa first, BeatNet later).

    result = track_beats(y, sr, backend="librosa", start_bpm=95.0)

Backends:
  librosa   deterministic, always available: beat_track on the onset envelope
  beatnet   neural, downbeat-aware (BeatNet, GPL-3.0; see docs/BACKLOG.md Phase 2).
            Used only when installed and ``LOCKEDGROOVE_BEAT_BACKEND=beatnet``
            or the caller asks for it; falls back to librosa with a note.
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
from dataclasses import dataclass, field

import numpy as np

DEFAULT_START_BPM = 95.0


@dataclass
class BeatTrack:
    bpm: float
    beats_s: list[float]
    downbeats_s: list[float] | None
    method: str
    notes: list[str] = field(default_factory=list)


def available_backends() -> list[str]:
    out = ["librosa"]
    if importlib.util.find_spec("BeatNet") is not None:
        out.append("beatnet")
    return out


def default_backend() -> str:
    wanted = os.environ.get("LOCKEDGROOVE_BEAT_BACKEND", "librosa").lower()
    return wanted if wanted in available_backends() else "librosa"


def _librosa(y: np.ndarray, sr: int, start_bpm: float, hop: int) -> BeatTrack:
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if len(y) < hop * 8:
        return BeatTrack(bpm=start_bpm, beats_s=[], downbeats_s=None, method="librosa.beat_track",
                         notes=["too short to track beats"])
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop, start_bpm=start_bpm,
                                            units="frames")
    beats = [float(b) for b in librosa.frames_to_time(frames, sr=sr, hop_length=hop)]
    # the tempogram's tempo and each beat are quantized to the hop (23 ms); a least-squares
    # line through the beat times averages that quantization out
    if len(beats) >= 4:
        period = float(np.polyfit(np.arange(len(beats)), np.asarray(beats), 1)[0])
        bpm = 60.0 / period if period > 0 else float(np.atleast_1d(tempo)[0])
    else:
        bpm = float(np.atleast_1d(tempo)[0])
    return BeatTrack(bpm=bpm, beats_s=beats, downbeats_s=None, method="librosa.beat_track")


def _beatnet(y: np.ndarray, sr: int) -> BeatTrack:
    import soundfile as sf
    from BeatNet.BeatNet import BeatNet  # type: ignore

    estimator = BeatNet(1, mode="offline", inference_model="DBN", plot=[], thread=False)
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        sf.write(path, np.asarray(y, dtype=np.float32), sr)
        out = np.asarray(estimator.process(path))
    finally:
        os.unlink(path)
    if out.size == 0:
        return BeatTrack(bpm=0.0, beats_s=[], downbeats_s=[], method="beatnet", notes=["no beats found"])
    times = out[:, 0].astype(float)
    kinds = out[:, 1].astype(int)
    beats = [float(t) for t in times]
    downbeats = [float(t) for t, k in zip(times, kinds) if k == 1]
    bpm = float(60.0 / np.median(np.diff(times))) if len(times) > 1 else 0.0
    return BeatTrack(bpm=bpm, beats_s=beats, downbeats_s=downbeats, method="beatnet")


def track_beats(y: np.ndarray, sr: int, backend: str | None = None, start_bpm: float = DEFAULT_START_BPM,
                hop: int = 512) -> BeatTrack:
    chosen = backend or default_backend()
    if chosen not in ("librosa", "beatnet"):
        raise ValueError(f"unknown beat backend {chosen!r}; choose librosa or beatnet")
    if chosen == "beatnet":
        if "beatnet" not in available_backends():
            result = _librosa(y, sr, start_bpm, hop)
            result.notes.append("beatnet requested but not installed; used librosa")
            return result
        try:
            return _beatnet(y, sr)
        except Exception as exc:  # the neural path must never sink the report
            result = _librosa(y, sr, start_bpm, hop)
            result.notes.append(f"beatnet failed ({type(exc).__name__}); used librosa")
            return result
    return _librosa(y, sr, start_bpm, hop)


__all__ = ["BeatTrack", "DEFAULT_START_BPM", "available_backends", "default_backend", "track_beats"]
