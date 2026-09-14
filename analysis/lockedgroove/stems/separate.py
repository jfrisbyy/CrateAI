"""Stem separation behind one interface, with the choice of separator made on quality.

Separation is the irreversible step. A weak separator measured on a real upload
threw away 17.6 dB of 8-20 kHz energy that a strong one preserved exactly, and
no amount of EQ downstream puts it back; the producer just hears "muddy". So
the registry below is ordered by quality, the default is the best entry that
produces the stems being asked for, and **there is no fast mode** - trading
separation quality for compute is not an option this module offers.

Quality tiers, best first:

  reference   band-split / spectro-temporal transformers. Highest published
              SDR; preserve the source's top end essentially untouched.
  strong      the fine-tuned hybrid time-frequency family. The best option
              that returns a full four- or six-stem split.
  baseline    earlier spectrogram U-nets. Usable, audibly softer.
  weak        the low-SDR members of the baseline family. Present only so a
              row that was produced by one can be *labelled* as such; never
              chosen automatically.
  stand_in    the band-split fake below. Not separation at all.

Every row written carries its tier, its published SDR and a confidence, so a
claim made from a stem downstream can say how far to trust it.

Backends:
  AudioSeparatorBackend  the real separators; needs the GPU image and a model download
  FakeSeparator          band-split stand-in for tests and the local runner
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Optional, Protocol

import numpy as np

TIERS = ("reference", "strong", "baseline", "weak", "stand_in")
TIER_RANK = {name: i for i, name in enumerate(TIERS)}
TIER_CONFIDENCE = {"reference": 0.9, "strong": 0.75, "baseline": 0.55, "weak": 0.35, "stand_in": 0.1}
TIER_NOTE = {
    "reference": "highest-quality separator available; the source's top end survives it",
    "strong": "strong separator; the best full-split option",
    "baseline": "older separator; audibly softer than the reference tier",
    "weak": "low-quality separator: it loses high-frequency detail that cannot be recovered downstream",
    "stand_in": "development stand-in, not a separation model; nothing measured from it is a real stem",
}

# The registry. Identifiers live here as data and nowhere else in the code.
MODELS: dict[str, dict] = {
    "bs_roformer": {
        "file": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
        "stems": ["vocals", "instrumental"],
        "label": "Band-split transformer (vocals / instrumental)",
        "family": "bs-roformer",
        "tier": "reference",
        "sdr": 12.98,
        "sdr_basis": "vocals SDR published by the checkpoint's author",
        "gpu": True,
    },
    "mdx23c_inst_voc": {
        "file": "MDX23C-8KFFT-InstVoc_HQ.ckpt",
        "stems": ["vocals", "instrumental"],
        "label": "MDX23C 8k FFT (vocals / instrumental)",
        "family": "mdx23c",
        "tier": "reference",
        "sdr": 11.0,
        "sdr_basis": "vocals SDR published by the checkpoint's author",
        "gpu": True,
    },
    "htdemucs_ft": {
        "file": "htdemucs_ft.yaml",
        "stems": ["drums", "bass", "vocals", "other"],
        "label": "Hybrid transformer, fine-tuned (drums, bass, vocals, other)",
        "family": "demucs",
        "tier": "strong",
        "sdr": 9.0,
        "sdr_basis": "four-stem average SDR on the standard separation benchmark, published by the author",
        "gpu": True,
    },
    "htdemucs_6s": {
        "file": "htdemucs_6s.yaml",
        "stems": ["drums", "bass", "vocals", "other", "guitar", "piano"],
        "label": "Hybrid transformer, six-stem (adds guitar and piano)",
        "family": "demucs",
        "tier": "strong",
        "sdr": None,
        "sdr_basis": "no per-stem SDR published for the six-stem variant",
        "gpu": True,
    },
    "mdxnet_inst_hq": {
        "file": "UVR-MDX-NET-Inst_HQ_3.onnx",
        "stems": ["vocals", "instrumental"],
        "label": "Spectrogram U-net, instrumental (vocals / instrumental)",
        "family": "mdx-net",
        "tier": "baseline",
        "sdr": None,
        "sdr_basis": "no SDR published on a standard benchmark",
        "gpu": True,
    },
    "kuielab_other": {
        "file": "kuielab_a_other.onnx",
        "stems": ["other"],
        "label": "Spectrogram U-net, melodic residue only",
        "family": "kuielab",
        "tier": "weak",
        "sdr": None,
        "sdr_basis": "no SDR published on a standard benchmark",
        "gpu": True,
    },
}

DEFAULT_STEMS: tuple[str, ...] = ("drums", "bass", "vocals", "other")
STAND_IN_SUFFIX = "-fake"


@dataclass(frozen=True)
class SeparationQuality:
    """What ran, how good it is, and how much a downstream claim should lean on it."""

    model: str
    label: str
    family: str
    tier: str
    sdr: Optional[float]
    sdr_basis: str
    confidence: float
    is_stand_in: bool
    note: str

    def to_row(self) -> dict:
        """The ``stems`` columns that record the separation's quality."""
        return {"model_family": self.family, "model_tier": self.tier, "model_sdr": self.sdr,
                "model_sdr_basis": self.sdr_basis, "is_stand_in": self.is_stand_in,
                "quality_confidence": self.confidence, "quality_note": self.note}

    def to_json(self) -> dict:
        return {"model": self.model, "label": self.label, **self.to_row()}


@dataclass(frozen=True)
class ModelChoice:
    """The resolved model and, in words, why it and not another."""

    model: str
    quality: SeparationQuality
    reason: str
    requested: Optional[str] = None
    downgraded: bool = False


@dataclass
class StemAudio:
    name: str
    y: np.ndarray  # (channels, n)
    sr: int


class Separator(Protocol):
    def separate(self, path: str, model: str) -> list[StemAudio]: ...


def _spec(model: str) -> dict:
    if model not in MODELS:
        raise ValueError(f"unknown stem model {model!r}; choose one of {sorted(MODELS)}")
    return MODELS[model]


def quality_of(model: str, *, stand_in: bool = False) -> SeparationQuality:
    """The quality record for ``model``; ``stand_in`` marks a row the fake produced."""
    spec = _spec(model)
    tier = "stand_in" if stand_in else str(spec["tier"])
    sdr = None if stand_in else spec["sdr"]
    basis = "not a separation model" if stand_in else str(spec["sdr_basis"])
    return SeparationQuality(model=model_label(model, stand_in=stand_in), label=str(spec["label"]),
                             family=str(spec["family"]), tier=tier, sdr=sdr, sdr_basis=basis,
                             confidence=TIER_CONFIDENCE[tier], is_stand_in=stand_in, note=TIER_NOTE[tier])


def model_label(model: str, *, stand_in: bool = False) -> str:
    """What goes in the ``stems.model`` column; a stand-in is always visibly marked."""
    return f"{model}{STAND_IN_SUFFIX}" if stand_in else model


def describe_stems(stems: Iterable[str]) -> str:
    """"vocals and instrumental" -- the split the way a person says it.

    ``ModelChoice.reason`` is shown to a producer (the Stems tab reads it off
    the job result), so it may not carry a Python list repr into the interface.
    Order is the registry's, not alphabetical: "drums, bass, vocals and other".
    """
    names = list(dict.fromkeys(stems))
    if not names:
        return "nothing"
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _sort_key(model: str) -> tuple[int, float, str]:
    spec = MODELS[model]
    sdr = spec["sdr"] if spec["sdr"] is not None else -1.0
    return (TIER_RANK[spec["tier"]], -float(sdr), model)


def models_for(stems_wanted: Optional[Sequence[str]] = None) -> list[str]:
    """Every model that returns all of ``stems_wanted``, best first."""
    wanted = set(stems_wanted or ())
    return sorted((m for m in MODELS if wanted <= set(MODELS[m]["stems"])), key=_sort_key)


def best_model(stems_wanted: Optional[Sequence[str]] = None,
               available: Optional[Iterable[str]] = None) -> Optional[str]:
    """The highest-quality model that returns ``stems_wanted`` and is installed."""
    candidates = models_for(stems_wanted)
    if available is not None:
        allowed = set(available)
        candidates = [m for m in candidates if m in allowed]
    return candidates[0] if candidates else None


def resolve_model(requested: Optional[str] = None, stems_wanted: Optional[Sequence[str]] = None,
                  available: Optional[Iterable[str]] = None, *, stand_in: bool = False) -> ModelChoice:
    """Pick the separator, best first, and say why.

    An explicit request is honoured - the producer may know exactly what they
    want - but if it is a low-quality one the choice says so, and the row it
    writes carries the tier with it. There is no option that trades quality for
    speed: when nothing good is installed the answer is a worse *label*, never
    a quieter one.
    """
    wanted = tuple(stems_wanted) if stems_wanted else None
    allowed = set(available) if available is not None else None

    if requested:
        spec = _spec(requested)
        quality = quality_of(requested, stand_in=stand_in)
        if wanted and not set(wanted) <= set(spec["stems"]):
            missing = sorted(set(wanted) - set(spec["stems"]))
            raise ValueError(f"{requested!r} does not produce {missing}; "
                             f"it returns {sorted(spec['stems'])}")
        if allowed is not None and requested not in allowed and not stand_in:
            raise ValueError(f"{requested!r} is not installed in this image; "
                             f"available: {sorted(allowed) or 'none'}")
        better = [m for m in models_for(wanted or spec["stems"])
                  if (allowed is None or m in allowed) and _sort_key(m) < _sort_key(requested)]
        reason = f"asked for by name ({quality.tier} tier)"
        if better and not stand_in:
            reason += f"; {better[0]} is higher quality and would have been chosen by default"
        return ModelChoice(model=requested, quality=quality, reason=reason, requested=requested,
                           downgraded=bool(better))

    wanted = wanted or DEFAULT_STEMS
    chosen = best_model(wanted, allowed)
    if chosen is None:
        raise ValueError(f"no installed separator produces {sorted(set(wanted))}; "
                         f"available: {sorted(allowed) if allowed is not None else sorted(MODELS)}")
    quality = quality_of(chosen, stand_in=stand_in)
    ranked = models_for(wanted)
    skipped = [m for m in ranked if _sort_key(m) < _sort_key(chosen)]
    reason = f"best available for {describe_stems(wanted)} ({quality.tier} tier)"
    if skipped:
        # Name the one that was missed rather than counting them. The owner
        # decides what the image carries, and a name is what they act on.
        reason += (f"; {skipped[0]} is higher quality but is not installed here" if len(skipped) == 1
                   else f"; {len(skipped)} higher-quality separators are not installed here, "
                        f"the best of them {skipped[0]}")
    return ModelChoice(model=chosen, quality=quality, reason=reason, requested=None, downgraded=bool(skipped))


DEFAULT_MODEL: str = best_model(DEFAULT_STEMS) or next(iter(MODELS))


def stem_name_from_filename(filename: str) -> Optional[str]:
    """Separator outputs are named like 'song_(Drums)_<model>.wav'."""
    m = re.search(r"\(([A-Za-z ]+)\)", filename)
    if not m:
        return None
    name = m.group(1).strip().lower()
    return {"instrumental": "instrumental", "no vocals": "instrumental"}.get(name, name.replace(" ", "_"))


class AudioSeparatorBackend:
    """The real separators; weights are downloaded to ``model_dir`` on first use (a Modal volume)."""

    def __init__(self, model_dir: Optional[str] = None, output_dir: Optional[str] = None, use_gpu: bool = True):
        self.model_dir = model_dir or os.environ.get("LOCKEDGROOVE_MODEL_CACHE", "/tmp/lockedgroove-models")
        self.output_dir = output_dir or "/tmp/lockedgroove-stems"
        self.use_gpu = use_gpu

    def _separator_class(self):
        try:
            from audio_separator.separator import Separator as _Sep  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on the image
            raise ImportError("audio-separator is not installed; run the stems job on the GPU image") from exc
        return _Sep

    def available_models(self) -> Optional[set[str]]:
        """Registry keys this image can actually load, or ``None`` when it cannot be determined.

        ``None`` means "assume the registry" rather than "nothing", so a listing
        API that changes shape degrades to the old behaviour instead of refusing
        to separate.
        """
        try:  # pragma: no cover - needs the separator installed
            listing = self._separator_class()().list_supported_model_files()
        except Exception:
            return None
        files = set(_flatten_model_files(listing))
        if not files:
            return None
        return {key for key, spec in MODELS.items() if spec["file"] in files}

    def separate(self, path: str, model: str) -> list[StemAudio]:
        import soundfile as sf

        spec = _spec(model)
        os.makedirs(self.output_dir, exist_ok=True)
        sep = self._separator_class()(model_file_dir=self.model_dir, output_dir=self.output_dir,
                                      output_format="WAV")
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


def _flatten_model_files(listing) -> list[str]:
    """The separator's listing is nested and its shape has changed between versions."""
    out: list[str] = []
    if isinstance(listing, dict):
        for key, value in listing.items():
            if isinstance(key, str) and "." in key:
                out.append(key)
            out.extend(_flatten_model_files(value))
    elif isinstance(listing, (list, tuple, set)):
        for value in listing:
            out.extend(_flatten_model_files(value))
    elif isinstance(listing, str) and "." in listing:
        out.append(listing)
    return out


class FakeSeparator:
    """Band-split stand-in: bass = < 150 Hz, drums = transient residue, other = the rest, vocals = 1-4 kHz.

    Not a separation model, and never treated as one: rows it writes carry the
    ``stand_in`` tier, a confidence of 0.1, and a model name with a visible
    suffix. It exists so the pipeline runs end to end without a GPU.
    """

    def available_models(self) -> Optional[set[str]]:
        return set(MODELS)

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
        names = _spec(model)["stems"]
        out = {"drums": drums, "bass": bass, "vocals": vocals, "other": other,
               "guitar": (0.5 * other).astype(np.float32), "piano": (0.5 * other).astype(np.float32),
               "instrumental": (y - vocals).astype(np.float32)}
        return [StemAudio(name=n, y=out[n], sr=int(sr)) for n in names]


def backend_available_models(backend: Optional[Separator]) -> Optional[set[str]]:
    """Ask a backend what it can load; ``None`` when it does not know or cannot say."""
    getter = getattr(backend, "available_models", None)
    if getter is None:
        return None
    try:
        return getter()
    except Exception:
        return None


def separate_file(path: str, model: str = DEFAULT_MODEL, backend: Optional[Separator] = None) -> list[StemAudio]:
    expected = set(_spec(model)["stems"])
    backend = backend or AudioSeparatorBackend()
    stems = backend.separate(path, model)
    got = {s.name for s in stems}
    missing = expected - got
    if missing:
        raise RuntimeError(f"separation with {model} returned {sorted(got)}; missing {sorted(missing)}")
    return [s for s in stems if s.name in expected]


__all__ = ["describe_stems", "DEFAULT_MODEL", "DEFAULT_STEMS", "MODELS", "STAND_IN_SUFFIX", "TIERS", "TIER_CONFIDENCE",
           "AudioSeparatorBackend", "FakeSeparator", "ModelChoice", "SeparationQuality", "Separator",
           "StemAudio", "backend_available_models", "best_model", "model_label", "models_for", "quality_of",
           "resolve_model", "separate_file", "stem_name_from_filename"]
