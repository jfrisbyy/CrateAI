"""Chords: chroma templates per beat with Viterbi smoothing, on the ``other`` stem when present.

Confidence (per segment): mean posterior of the chosen chord over the
segment's beats, where the posterior is a softmax over template
similarities. Segments shorter than a beat are merged into their neighbors.
"""

from __future__ import annotations

import numpy as np

from ..report import ChordSegment, Chords
from .. import pipeline as _p

PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
STAY_PROB = 0.85
TEMPERATURE = 12.0
MIN_ENERGY = 1e-4


def templates() -> tuple[np.ndarray, list[str]]:
    labels: list[str] = []
    rows: list[np.ndarray] = []
    for i, name in enumerate(PITCH):
        for quality, intervals in (("maj", (0, 4, 7)), ("min", (0, 3, 7))):
            t = np.zeros(12)
            for k, iv in enumerate(intervals):
                t[(i + iv) % 12] = 1.0 if k == 0 else 0.8
            rows.append(t / np.linalg.norm(t))
            labels.append(f"{name}:{quality}")
    rows.append(np.ones(12) / np.sqrt(12))
    labels.append("N")
    return np.stack(rows), labels


def _viterbi(logp: np.ndarray, stay: float) -> np.ndarray:
    n, k = logp.shape
    trans = np.full((k, k), np.log((1 - stay) / (k - 1)))
    np.fill_diagonal(trans, np.log(stay))
    score = logp[0].copy()
    back = np.zeros((n, k), dtype=int)
    for t in range(1, n):
        cand = score[:, None] + trans
        back[t] = np.argmax(cand, axis=0)
        score = cand[back[t], np.arange(k)] + logp[t]
    path = np.zeros(n, dtype=int)
    path[-1] = int(np.argmax(score))
    for t in range(n - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    return path


def estimate_chords(y: np.ndarray, sr: int, beat_times: list[float] | None, hop: int = 512) -> list[ChordSegment]:
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if len(y) < hop * 4:
        return []
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    energy = librosa.feature.rms(y=y, hop_length=hop)[0]
    frame_times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=hop)
    duration = len(y) / sr
    if beat_times and len(beat_times) >= 2:
        edges = list(beat_times)
        if edges[0] > 0.05:
            edges.insert(0, 0.0)
        if edges[-1] < duration - 0.05:
            edges.append(duration)
    else:
        edges = list(np.arange(0.0, duration + 0.5, 0.5))
    frames = librosa.time_to_frames(np.asarray(edges), sr=sr, hop_length=hop)
    frames = np.clip(frames, 0, chroma.shape[1])
    obs: list[np.ndarray] = []
    spans: list[tuple[float, float]] = []
    T, labels = templates()
    for a, b in zip(frames[:-1], frames[1:]):
        if b <= a:
            continue
        c = np.median(chroma[:, a:b], axis=1)
        e = float(np.mean(energy[a:b])) if b <= len(energy) else 0.0
        norm = np.linalg.norm(c)
        if norm < 1e-9 or e < MIN_ENERGY:
            sims = np.full(len(labels), -1.0)
            sims[-1] = 1.0
        else:
            sims = T @ (c / norm)
            sims[-1] = 0.55  # "no chord" competes only when nothing fits
        logits = TEMPERATURE * sims
        post = np.exp(logits - logits.max())
        post /= post.sum()
        obs.append(post)
        spans.append((float(edges[list(frames).index(a)] if False else 0.0), 0.0))
    if not obs:
        return []
    P = np.stack(obs)
    path = _viterbi(np.log(P + 1e-12), STAY_PROB)
    # rebuild spans from edges (indexes align with kept (a, b) pairs)
    kept_edges = []
    for i, (a, b) in enumerate(zip(frames[:-1], frames[1:])):
        if b > a:
            kept_edges.append((float(edges[i]), float(edges[i + 1])))
    segments: list[ChordSegment] = []
    for i, lab_idx in enumerate(path):
        start, end = kept_edges[i]
        conf = float(P[i, lab_idx])
        label = labels[lab_idx]
        if segments and segments[-1].label == label:
            prev = segments[-1]
            n_prev = prev.end_s - prev.start_s
            n_new = end - start
            prev.confidence = float((prev.confidence * n_prev + conf * n_new) / max(n_prev + n_new, 1e-9))
            prev.end_s = end
        else:
            segments.append(ChordSegment(start_s=start, end_s=end, label=label, confidence=conf))
    return segments


def run(y: np.ndarray, sr: int, ctx: "_p.Context") -> Chords:
    src = y
    method = "chroma_cqt templates + viterbi on mix"
    if ctx.stems and "other" in ctx.stems:
        src = ctx.stems["other"]
        method = "chroma_cqt templates + viterbi on other stem"
    beats = ctx.report.beats.times_s if ctx.report.beats else None
    segments = estimate_chords(src, sr, beats)
    return Chords(segments=segments, method=method,
                  notes=None if segments else "no chord activity found")


__all__ = ["estimate_chords", "run", "templates"]
