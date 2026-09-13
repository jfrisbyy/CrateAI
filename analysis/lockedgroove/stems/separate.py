"""Stem separation behind one interface, model exposed to the user.

Backends:
  AudioSeparatorBackend  python-audio-separator (htdemucs_ft default, htdemucs_6s, BS-RoFormer); GPU
  FakeSeparator          band-split stand-in for tests and the local runner without models

Every stem becomes a ``files`` row with ``parent_file_id`` and its own
``analyze`` job (the job runner does that part).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

MODELS: dict[str, dict] = {
    "htdemucs_ft": {
        "file": "htdemucs_ft.yaml",
        "stems": ["drums", "bass", "vocals", "other"],
        "label": "Demucs v4 fine-tuned (drums, bass, vocals, other)",
        "gpu": True,
    },
    "htdemucs_6s": {
        "file": "htdemucs_6s.yaml",
        "stems": ["drums", "bass", "vocals", "other", "guitar", "piano"],
        "label": "Demucs v4 six-stem (adds guitar and piano)",
        "gpu": True,
    },
    "bs_roformer": {
        "file": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        "stems": ["vocals", "instrumental"],
        "label": "BS-RoFormer (vocals / instrumental, highest vocal quality)",
        "gpu": True,
    },
}
DEFAULT_MODEL = "htdemucs_ft"


@dataclass
class StemAudio:
    name: str
    y: np.ndarray  # (channels, n)
    sr: int


class Separator(Protocol):
    def separate(self, path: str, model: str) -> list[StemAudio]: ...


def stem_name_from_filename(filename: str) -> Optional[str]:
    """audio-separator names outputs like 'song_(Drums)_htdemucs_ft.wav'."""
    m = re.search(r"\(([A-Za-z ]+)\)", filename)
    if not m:
        return None
    name = m.group(1).strip().lower()
    return {"instrumental": "instrumental", "no vocals": "instrumental"}.get(name, name.replace(" ", "_"))


class AudioSeparatorBackend:
    """python-audio-separator; models are downloaded to ``model_dir`` on first use (a Modal volume)."""

    def __init__(self, model_dir: Optional[str] = None, output_dir: Optional[str] = None, use_gpu: bool = True):
        self.model_dir = model_dir or os.environ.get("LOCKEDGROOVE_MODEL_CACHE", "/tmp/lockedgroove-models")
        self.output_dir = output_dir or "/tmp/lockedgroove-stems"
        self.use_gpu = use_gpu

    def separate(self, path: str, model: str) -> list[StemAudio]:
        try:
            from audio_separator.separator import Separator as _Sep  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on the image
            raise ImportError("audio-separator is not installed; run the stems job on the GPU image "
                              "(pip install 'audio-separator[gpu]')") from exc
        import soundfile as sf

        spec = MODELS[model]
        os.makedirs(self.output_dir, exist_ok=True)
        sep = _Sep(model_file_dir=self.model_dir, output_dir=self.output_dir, output_format="WAV")
        sep.load_model(model_filename=spec["file"])
        outputs = sep.separate(path)
        stems: list[StemAudio] = []
        for out in outputs:
            full = out if os.path.isabs(out) else os.path.join(self.output_dir, out)
            name = stem_name_from_filename(os.path.basename(full))
            if name is None:
                continue
            data, sr = sf.read(full, dtype="float32", always_2d=True)
            stems.append(StemAudio(name=name, y=data.T, sr=int(sr)))
        return stems


class FakeSeparator:
    """Band-split stand-in: bass = < 150 Hz, drums = transient residue, other = the rest, vocals = 1-4 kHz.

    Not a separation model. It keeps the pipeline runnable end to end without
    a GPU and is clearly labeled in the stems rows (``model`` = 'fake').
    """

    def separate(self, path: str, model: str) -> list[StemAudio]:
        import soundfile as sf
        from scipy.signal import butter, sosfiltfilt

        data, sr = sf.read(path, dtype="float32", always_2d=True)
        y = data.T
        nyq = sr / 2
        lp = butter(4, 150 / nyq, btype="lowpass", output="sos")
        bp = butter(4, [1000 / nyq, min(4000, nyq * 0.9) / nyq], btype="bandpass", output="sos")
        bass = sosfiltfilt(lp, y, axis=-1).astype(np.float32)
        vocals = (0.5 * sosfiltfilt(bp, y, axis=-1)).astype(np.float32)
        rest = y - bass - vocals
        # crude transient/sustain split for drums vs other
        import librosa

        drums = np.stack([librosa.effects.percussive(ch, margin=3.0) for ch in rest]).astype(np.float32)
        other = (rest - drums).astype(np.float32)
        names = MODELS[model]["stems"]
        out = {"drums": drums, "bass": bass, "vocals": vocals, "other": other,
               "guitar": (0.5 * other).astype(np.float32), "piano": (0.5 * other).astype(np.float32),
               "instrumental": (y - vocals).astype(np.float32)}
        return [StemAudio(name=n, y=out[n], sr=int(sr)) for n in names]


def separate_file(path: str, model: str = DEFAULT_MODEL, backend: Optional[Separator] = None) -> list[StemAudio]:
    if model not in MODELS:
        raise ValueError(f"unknown stem model {model!r}; choose one of {sorted(MODELS)}")
    backend = backend or AudioSeparatorBackend()
    stems = backend.separate(path, model)
    expected = set(MODELS[model]["stems"])
    got = {s.name for s in stems}
    missing = expected - got
    if missing:
        raise RuntimeError(f"separation with {model} returned {sorted(got)}; missing {sorted(missing)}")
    return [s for s in stems if s.name in expected]


__all__ = ["DEFAULT_MODEL", "MODELS", "AudioSeparatorBackend", "FakeSeparator", "Separator", "StemAudio",
           "separate_file", "stem_name_from_filename"]
