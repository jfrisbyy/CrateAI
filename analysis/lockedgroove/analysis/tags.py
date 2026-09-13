"""Tags: CLAP zero-shot against producer terms (BUILD_PACKET section 6).

Confidence: softmax over the vocabulary of the cosine similarity between the
audio embedding and each term's prompt embedding, scaled so the top term of a
clear match sits near 0.9. The stage runs only where an embedder is available
(the GPU embed job); the CPU analyze job leaves tags empty.
"""

from __future__ import annotations

import numpy as np

from .. import pipeline as _p
from ..report import Tag

VOCABULARY: list[str] = [
    # instruments
    "rhodes", "wurlitzer", "piano", "upright piano", "organ", "clavinet", "electric guitar", "acoustic guitar",
    "bass guitar", "upright bass", "synth bass", "808", "strings", "violin", "cello", "brass", "trumpet", "saxophone",
    "flute", "harp", "vibraphone", "marimba", "bells", "choir", "vocals", "vocal chop", "rap vocal", "female vocal",
    "male vocal", "humming", "whistle", "synth lead", "synth pad", "arpeggio", "pluck", "sitar", "kalimba", "steel drum",
    "accordion", "harmonica", "drum break", "drum machine", "kick", "snare", "hi-hat", "clap", "rimshot", "shaker",
    "tambourine", "congas", "bongos", "tabla", "timpani", "cymbal", "percussion loop", "beatbox",
    # genres and eras
    "soul", "funk", "jazz", "gospel", "blues", "hip hop", "boom bap", "trap", "drill", "lo-fi", "house", "techno",
    "disco", "reggae", "dub", "afrobeat", "latin", "bossa nova", "rock", "psychedelic", "library music", "film score",
    "sixties", "seventies", "eighties", "nineties",
    # texture and character
    "dusty", "warm", "vinyl crackle", "tape hiss", "lo-fi texture", "clean", "bright", "dark", "mellow", "aggressive",
    "distorted", "saturated", "filtered", "reverb heavy", "dry", "wide stereo", "mono", "ambient", "cinematic",
    "melancholic", "uplifting", "eerie", "sparse", "dense", "minor key", "major key", "slow", "fast", "swung",
    "straight", "loop", "one shot", "sample", "acapella", "instrumental", "intro", "breakdown", "riser", "fx",
]
PROMPT = "the sound of {term}"
TOP_K = 8
TEMPERATURE = 25.0
MIN_CONFIDENCE = 0.05


def zero_shot_tags(audio_embedding: np.ndarray, embedder, vocabulary: list[str] | None = None, top_k: int = TOP_K
                   ) -> list[Tag]:
    vocab = vocabulary or VOCABULARY
    text = embedder.embed_text([PROMPT.format(term=t) for t in vocab])
    a = np.asarray(audio_embedding, dtype=np.float32)
    a = a / (np.linalg.norm(a) + 1e-9)
    sims = text @ a
    logits = TEMPERATURE * sims
    probs = np.exp(logits - logits.max())
    probs /= probs.sum()
    order = np.argsort(-probs)[:top_k]
    out = []
    for i in order:
        conf = float(min(1.0, probs[i] * 3.0))  # a clear winner over ~120 terms lands near 0.9
        if conf < MIN_CONFIDENCE:
            continue
        out.append(Tag(tag=vocab[i], confidence=round(conf, 3), source="model"))
    return out


def run(y: np.ndarray, sr: int, ctx: "_p.Context") -> list[Tag]:
    embedder = ctx.options.get("embedder")
    if embedder is None:
        from ..embeddings.clap import get_embedder

        embedder = get_embedder()  # raises ImportError -> pipeline records "stage not available"
    emb = embedder.embed_audio(y, sr)
    ctx.options["audio_embedding"] = emb
    return zero_shot_tags(emb, embedder)


__all__ = ["PROMPT", "TOP_K", "VOCABULARY", "run", "zero_shot_tags"]
