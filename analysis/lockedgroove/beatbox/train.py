"""Enrollment: ~20 examples each of the user's kick, snare, hat -> a small classifier.

Reports cross-validated accuracy and refuses to enable the profile under 85%.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from typing import Optional

import joblib
import numpy as np
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

from .features import detect_onsets, hit_features, segment

MIN_ACCURACY = 0.85
MIN_EXAMPLES_PER_CLASS = 5
DEFAULT_CLASSES = ["kick", "snare", "hat"]


@dataclass
class Example:
    cls: str
    y: np.ndarray
    sr: int


@dataclass
class TrainResult:
    model_bytes: bytes
    classes: list[str]
    sample_count: int
    cv_accuracy: float
    enabled: bool
    per_class_counts: dict[str, int] = field(default_factory=dict)
    message: str = ""


def examples_from_recording(cls: str, y: np.ndarray, sr: int) -> list[Example]:
    """A recording of repeated hits of one class becomes one example per onset."""
    return [Example(cls, segment(y, sr, t), sr) for t in detect_onsets(y, sr)]


def _features(examples: list[Example]) -> tuple[np.ndarray, np.ndarray]:
    X = np.stack([hit_features(e.y, e.sr) for e in examples])
    labels = np.asarray([e.cls for e in examples])
    return X, labels


def build_model() -> Pipeline:
    return Pipeline([("scale", StandardScaler()), ("svm", SVC(kernel="rbf", C=4.0, gamma="scale", probability=True))])


def train(examples: list[Example], min_accuracy: float = MIN_ACCURACY, seed: int = 0) -> TrainResult:
    counts: dict[str, int] = {}
    for e in examples:
        counts[e.cls] = counts.get(e.cls, 0) + 1
    classes = sorted(counts)
    too_few = [c for c, n in counts.items() if n < MIN_EXAMPLES_PER_CLASS]
    if len(classes) < 2 or too_few:
        return TrainResult(b"", classes, len(examples), 0.0, False, counts,
                           f"need at least {MIN_EXAMPLES_PER_CLASS} examples per class; short on {too_few or 'classes'}")
    X, labels = _features(examples)
    folds = max(2, min(5, min(counts.values())))
    cv = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)
    scores = cross_val_score(build_model(), X, labels, cv=cv)
    acc = float(np.mean(scores))
    model = build_model().fit(X, labels)
    buf = io.BytesIO()
    joblib.dump({"model": model, "classes": classes}, buf)
    enabled = acc >= min_accuracy
    msg = (f"cross-validated accuracy {acc:.0%}" if enabled
           else f"cross-validated accuracy {acc:.0%} is under {min_accuracy:.0%}; record more examples")
    return TrainResult(buf.getvalue(), classes, len(examples), acc, enabled, counts, msg)


def load_model(model_bytes: bytes) -> tuple[Pipeline, list[str]]:
    obj = joblib.load(io.BytesIO(model_bytes))
    return obj["model"], obj["classes"]


__all__ = ["DEFAULT_CLASSES", "Example", "MIN_ACCURACY", "TrainResult", "examples_from_recording", "load_model",
           "train"]
