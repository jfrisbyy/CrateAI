"""CLAP: one model gives audio and text embeddings in the same 512-d space.

  LaionClapEmbedder  laion-clap with the music checkpoint (OPEN_QUESTIONS G.26); GPU
  HashEmbedder       deterministic stand-in for tests and the local runner: audio is projected
                     from a mel summary, text from token hashes. Similar only in shape.

``get_embedder()`` returns the real model when laion-clap is installed, else
the stand-in when LOCKEDGROOVE_FAKE_EMBEDDER=1, else raises.
"""

from __future__ import annotations

import hashlib
import os
from typing import Optional, Protocol

import numpy as np

CLAP_DIM = 512
MODEL_NAME = "music_audioset_epoch_15_esc_90.14"
MODEL_URL = "https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt"
CLAP_SR = 48000


class Embedder(Protocol):
    name: str

    def embed_audio(self, y: np.ndarray, sr: int) -> np.ndarray: ...

    def embed_text(self, texts: list[str]) -> np.ndarray: ...


def l2(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    n = np.linalg.norm(v, axis=-1, keepdims=True) + 1e-9
    return v / n


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(l2(a), l2(b)))


class LaionClapEmbedder:
    name = MODEL_NAME

    def __init__(self, checkpoint_path: Optional[str] = None, device: Optional[str] = None):
        try:
            import laion_clap  # type: ignore
        except ImportError as exc:  # pragma: no cover - depends on the image
            raise ImportError("laion-clap is not installed; the embed job runs on the GPU image") from exc
        import torch

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base", device=self.device)
        ckpt = checkpoint_path or os.path.join(os.environ.get("LOCKEDGROOVE_MODEL_CACHE", "/tmp/lockedgroove-models"),
                                               MODEL_NAME + ".pt")
        if not os.path.exists(ckpt):
            self.model.load_ckpt(model_id=None)  # downloads the default; music checkpoint preferred when cached
        else:
            self.model.load_ckpt(ckpt)

    def embed_audio(self, y: np.ndarray, sr: int) -> np.ndarray:
        import librosa

        mono = np.asarray(y, dtype=np.float32)
        if mono.ndim == 2:
            mono = mono.mean(axis=0)
        if sr != CLAP_SR:
            mono = librosa.resample(mono, orig_sr=sr, target_sr=CLAP_SR)
        # CLAP takes 10 s windows; average over the file
        win = CLAP_SR * 10
        chunks = [mono[i: i + win] for i in range(0, max(1, len(mono)), win)] or [mono]
        chunks = [c for c in chunks if len(c) >= CLAP_SR]
        if not chunks:
            chunks = [np.pad(mono, (0, max(0, CLAP_SR - len(mono))))]
        embs = self.model.get_audio_embedding_from_data(x=[np.asarray(c, dtype=np.float32) for c in chunks], use_tensor=False)
        return l2(np.mean(np.asarray(embs), axis=0))

    def embed_text(self, texts: list[str]) -> np.ndarray:
        return l2(np.asarray(self.model.get_text_embedding(texts, use_tensor=False)))


class HashEmbedder:
    """Deterministic stand-in. Audio: mel summary through a fixed random projection. Text: token hashes."""

    name = "hash-fake"

    def __init__(self, seed: int = 7):
        rng = np.random.default_rng(seed)
        self._proj = rng.standard_normal((80, CLAP_DIM)).astype(np.float32) / np.sqrt(80)

    def embed_audio(self, y: np.ndarray, sr: int) -> np.ndarray:
        import librosa

        mono = np.asarray(y, dtype=np.float32)
        if mono.ndim == 2:
            mono = mono.mean(axis=0)
        if len(mono) < 2048:
            mono = np.pad(mono, (0, 2048 - len(mono)))
        mel = librosa.feature.melspectrogram(y=mono, sr=sr, n_mels=40)
        logmel = np.log(mel + 1e-9)
        feat = np.concatenate([logmel.mean(axis=1), logmel.std(axis=1)])
        feat = (feat - feat.mean()) / (feat.std() + 1e-9)
        return l2(feat @ self._proj)

    def embed_text(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), CLAP_DIM), dtype=np.float32)
        for i, t in enumerate(texts):
            for tok in t.lower().split():
                h = int.from_bytes(hashlib.sha256(tok.encode()).digest()[:8], "little")
                rng = np.random.default_rng(h % (2 ** 32))
                out[i] += rng.standard_normal(CLAP_DIM).astype(np.float32)
        return l2(out)


_EMBEDDER: Optional[Embedder] = None


def get_embedder() -> Embedder:
    global _EMBEDDER
    if _EMBEDDER is not None:
        return _EMBEDDER
    try:
        _EMBEDDER = LaionClapEmbedder()
    except ImportError:
        if os.environ.get("LOCKEDGROOVE_FAKE_EMBEDDER") == "1":
            _EMBEDDER = HashEmbedder()
        else:
            raise
    return _EMBEDDER


def set_embedder(e: Optional[Embedder]) -> None:
    global _EMBEDDER
    _EMBEDDER = e


__all__ = ["CLAP_DIM", "CLAP_SR", "MODEL_NAME", "MODEL_URL", "Embedder", "HashEmbedder", "LaionClapEmbedder", "cosine",
           "get_embedder", "l2", "set_embedder"]
