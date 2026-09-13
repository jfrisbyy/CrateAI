"""The accuracy metrics, as pure functions.

Both ``scripts/eval_accuracy.py`` and the eval tests import these, so there is
exactly one definition of each metric. Two families:

* :data:`METRICS` -- the six of BUILD_PACKET section 16, scored on every
  dataset whose truth carries the field;
* :data:`PAIR_METRICS` -- the sample-pair metrics (``sample_pairs`` only),
  which ask whether the loop finder surfaces the section a producer actually
  flipped. See :mod:`lockedgroove.eval.pairs` and ``docs/HANDOFF_sample_pairs.md``.

The section-16 six:

===================  =====================================================================
metric               definition
===================  =====================================================================
``bpm_exact``        |predicted - true| <= 2 BPM
``bpm_octave``       exact, or the truth within 2 BPM of any value in ``alternates_bpm``
``key_exact``        tonic and mode agree (tonics normalized to sharps)
``key_relative``     exact, or the report's alternate matches, or the truth is the
                     relative major/minor of the prediction
``downbeat``         median absolute offset between predicted and true downbeats, taken
                     modulo the bar length, within +-60 ms
``structure_f``      section-boundary F-measure at +-1 bar, where labels exist
===================  =====================================================================

The sample-pair six, scored against the section the producer used:

===================  =====================================================================
metric               definition
===================  =====================================================================
``flip_top1``        the finder's *top* candidate overlaps the used section,
                     IoU >= ``FLIP_IOU_THRESHOLD``
``flip_topk``        any of the top ``FLIP_TOP_K`` does (the rack a producer scrolls)
``flip_mrr``         1 / rank of the first candidate that does, over the top
                     ``FLIP_RANK_DEPTH``; 0 when none does (mean reciprocal rank)
``flip_mark``        a top-``FLIP_TOP_K`` candidate covers the producer's timestamp,
                     widened by the pair's tolerance: the roughest bar, and the one a
                     pair with only "around 1:04" can still score
``tempo_ratio``      the stretch our alignment would compute is within
                     ``TEMPO_RATIO_TOLERANCE`` of the ratio the producer used
``pitch_shift``      the shift our alignment would compute is within
                     ``PITCH_TOLERANCE_ST`` of the one the producer used, modulo an
                     octave (a key-derived shift only ever claims a pitch class)
===================  =====================================================================

Scoring rules shared by every metric:

* a metric is *applicable* to an item only when the truth carries the field;
  otherwise it is skipped and does not count;
* an applicable metric whose prediction is missing (stage absent, stage
  failed, section ``None``) is a **miss**, with the reason recorded;
* per-dataset scores are ``sum(value) / n`` over applicable items, which is
  the hit rate for the boolean metrics and the mean F-measure for
  ``structure_f``.

Nothing here imports an analysis stage or pydantic; predictions arrive as a
:class:`Prediction` built from an (effective) report dict.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

BPM_TOLERANCE = 2.0
DOWNBEAT_TOLERANCE_S = 0.060
STRUCTURE_TOLERANCE_BARS = 1.0
DEFAULT_BEATS_PER_BAR = 4

METRICS: tuple[str, ...] = ("bpm_exact", "bpm_octave", "key_exact", "key_relative", "downbeat", "structure_f")

# --- sample pairs (an original record and the song that flipped it) ---------------------------

FLIP_IOU_THRESHOLD = 0.5
"""Intersection over union at or above this means a candidate *is* the used section.

Justified by the two ways a finder is right without being exact: a candidate
that contains the whole flip but runs twice as long scores exactly 0.5, and so
does a candidate half the length sitting inside it -- both are the right part
of the record with an edge to drag (principle 4). A candidate the same length
but offset by half of itself scores 0.33 and is a miss, which is the
distinction the threshold exists to draw.
"""

FLIP_TOP_K = 10
"""The rack a producer actually scrolls (PRODUCT_DIRECTION, surface 1)."""

FLIP_RANK_DEPTH = 50
"""How deep the ranking is scored: past this, "we did not find it" is the honest summary."""

MARK_TOLERANCE_S = 1.0
"""Default slack on a hand-written timestamp; roughly a beat and a half at 90 BPM.

A pair may override it (``tolerance_s``) when the owner is less sure than that.
"""

TEMPO_RATIO_TOLERANCE = 0.02
"""2 % -- ``BPM_TOLERANCE`` (2 BPM) expressed as a ratio at the ~95 BPM this product centres on."""

PITCH_TOLERANCE_ST = 0.5
"""Half a semitone: our alignment claims whole semitones, so this asks only that it lands on the right one."""

PAIR_METRICS: tuple[str, ...] = ("flip_top1", "flip_topk", "flip_mrr", "flip_mark",
                                 "tempo_ratio", "pitch_shift")
ALL_METRICS: tuple[str, ...] = (*METRICS, *PAIR_METRICS)
"""Both families. The report prints them as two tables; gates may name any of them."""

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_ENHARMONIC = {
    "DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#",
    "CB": "B", "FB": "E", "E#": "F", "B#": "C",
}
_MODE_WORDS = {
    "major": "major", "maj": "major", "ionian": "major", "dur": "major",
    "minor": "minor", "min": "minor", "aeolian": "minor", "moll": "minor",
}


# --------------------------------------------------------------------------
# key spelling
# --------------------------------------------------------------------------

def normalize_tonic(tonic: Any) -> str | None:
    """Return the sharp spelling of a tonic (``"Bb"`` -> ``"A#"``) or ``None``."""
    if tonic is None:
        return None
    s = str(tonic).strip().replace("♯", "#").replace("♭", "b").replace("♮", "")
    if not s:
        return None
    letter = s[0].upper()
    if letter not in "ABCDEFG":
        return None
    acc = s[1:].strip()
    if acc == "":
        name = letter
    elif acc in ("#", "s", "is", "sharp"):
        name = letter + "#"
    elif acc in ("b", "-", "es", "flat") or (acc == "B" and letter != "B"):
        # a trailing capital B on any letter but B itself reads as a flat ("EB")
        name = letter + "b"
    else:
        return None
    name = _ENHARMONIC.get(name.upper(), name)
    return name if name in PITCH_CLASSES else None


def normalize_mode(mode: Any) -> str | None:
    if mode is None:
        return None
    raw = str(mode).strip()
    if raw == "M":
        return "major"
    if raw == "m":
        return "minor"
    return _MODE_WORDS.get(raw.lower())


def parse_key(text: Any) -> tuple[str, str] | None:
    """Parse ``"F# minor"``, ``"Db major"``, ``"Bbm"``, ``"A"`` (major) into ``(tonic, mode)``."""
    if text is None:
        return None
    s = str(text).strip().replace("♯", "#").replace("♭", "b")
    if not s:
        return None
    parts = s.replace("_", " ").replace(":", " ").split()
    if len(parts) >= 2:
        tonic, mode = normalize_tonic(parts[0]), normalize_mode(parts[1])
        return (tonic, mode) if tonic and mode else None
    token = parts[0]
    # compact forms: "F#m", "Bbmaj", "Abmin", "C"
    for suffix, mode in (("major", "major"), ("minor", "minor"), ("maj", "major"), ("min", "minor"),
                         ("M", "major"), ("m", "minor")):
        if token.endswith(suffix) and len(token) > len(suffix):
            tonic = normalize_tonic(token[: -len(suffix)])
            if tonic:
                return tonic, mode
    tonic = normalize_tonic(token)
    return (tonic, "major") if tonic else None


def key_tuple(key: Any) -> tuple[str, str] | None:
    """Coerce a key in any of the accepted forms into a normalized ``(tonic, mode)``.

    Accepts ``{"tonic": .., "mode": ..}``, objects with ``tonic``/``mode``
    attributes, ``(tonic, mode)`` pairs, and strings (see :func:`parse_key`).
    """
    if key is None:
        return None
    if isinstance(key, str):
        return parse_key(key)
    if isinstance(key, Mapping):
        tonic, mode = normalize_tonic(key.get("tonic")), normalize_mode(key.get("mode"))
    elif isinstance(key, (tuple, list)) and len(key) == 2:
        tonic, mode = normalize_tonic(key[0]), normalize_mode(key[1])
    else:
        tonic, mode = normalize_tonic(getattr(key, "tonic", None)), normalize_mode(getattr(key, "mode", None))
    return (tonic, mode) if tonic and mode else None


def relative_key(tonic: str, mode: str) -> tuple[str, str]:
    """The relative minor of a major key, or the relative major of a minor key."""
    i = PITCH_CLASSES.index(tonic)
    if mode == "major":
        return PITCH_CLASSES[(i + 9) % 12], "minor"
    return PITCH_CLASSES[(i + 3) % 12], "major"


# --------------------------------------------------------------------------
# tempo
# --------------------------------------------------------------------------

def bpm_exact(pred_bpm: float | None, true_bpm: float | None, tol: float = BPM_TOLERANCE) -> bool:
    if pred_bpm is None or true_bpm is None:
        return False
    return abs(float(pred_bpm) - float(true_bpm)) <= tol


def bpm_octave(pred_bpm: float | None, true_bpm: float | None,
               alternates_bpm: Iterable[float] | None = None, tol: float = BPM_TOLERANCE) -> bool:
    """Exact, or the truth within ``tol`` of any value the report lists in ``alternates_bpm``.

    The alternates are taken from the report, never derived here: the metric
    measures what the report actually offers the user to click (principle 4).
    """
    if true_bpm is None:
        return False
    if bpm_exact(pred_bpm, true_bpm, tol):
        return True
    for alt in alternates_bpm or ():
        if alt is not None and abs(float(alt) - float(true_bpm)) <= tol:
            return True
    return False


# --------------------------------------------------------------------------
# key
# --------------------------------------------------------------------------

def key_exact(pred_key: Any, true_key: Any) -> bool:
    p, t = key_tuple(pred_key), key_tuple(true_key)
    return p is not None and t is not None and p == t


def key_relative(pred_key: Any, true_key: Any, pred_alternate: Any = None) -> bool:
    """Exact, or the report's alternate is exact, or the truth is the relative of the prediction."""
    p, t = key_tuple(pred_key), key_tuple(true_key)
    if p is None or t is None:
        return False
    if p == t:
        return True
    a = key_tuple(pred_alternate)
    if a is not None and a == t:
        return True
    return relative_key(*p) == t


# --------------------------------------------------------------------------
# downbeats
# --------------------------------------------------------------------------

def bar_length_s(downbeats_s: Sequence[float] | None = None, bpm: float | None = None,
                 beats_per_bar: int = DEFAULT_BEATS_PER_BAR) -> float | None:
    """Bar length from annotated downbeats (median spacing), else from ``bpm`` and the meter."""
    if downbeats_s is not None and len(downbeats_s) >= 2:
        diffs = np.diff(np.asarray(sorted(float(t) for t in downbeats_s)))
        diffs = diffs[diffs > 1e-3]
        if diffs.size:
            return float(np.median(diffs))
    if bpm:
        return beats_per_bar * 60.0 / float(bpm)
    return None


def downbeat_offsets_s(pred_downbeats_s: Sequence[float], true_downbeats_s: Sequence[float],
                       bar_s: float) -> np.ndarray:
    """Signed offset of each true downbeat to the nearest predicted one, wrapped into ``[-bar/2, bar/2)``.

    Wrapping modulo the bar length means a grid that starts a whole bar late
    scores as aligned (the *phase* within the bar is what the user sees),
    while a grid one beat off scores as a quarter bar off.
    """
    true = np.asarray([float(t) for t in true_downbeats_s], dtype=float)
    pred = np.asarray(sorted(float(t) for t in pred_downbeats_s), dtype=float)
    if true.size == 0 or pred.size == 0 or not bar_s or bar_s <= 0:
        return np.zeros(0, dtype=float)
    idx = np.searchsorted(pred, true)
    lo = np.clip(idx - 1, 0, pred.size - 1)
    hi = np.clip(idx, 0, pred.size - 1)
    nearest = np.where(np.abs(pred[lo] - true) <= np.abs(pred[hi] - true), pred[lo], pred[hi])
    d = true - nearest
    return ((d + bar_s / 2.0) % bar_s) - bar_s / 2.0


def downbeat_median_offset_s(pred_downbeats_s: Sequence[float], true_downbeats_s: Sequence[float],
                             bar_s: float) -> float | None:
    offs = downbeat_offsets_s(pred_downbeats_s, true_downbeats_s, bar_s)
    if offs.size == 0:
        return None
    return float(np.median(np.abs(offs)))


def downbeat_ok(pred_downbeats_s: Sequence[float], true_downbeats_s: Sequence[float], bar_s: float,
                tol_s: float = DOWNBEAT_TOLERANCE_S) -> bool:
    med = downbeat_median_offset_s(pred_downbeats_s, true_downbeats_s, bar_s)
    return med is not None and med <= tol_s


# --------------------------------------------------------------------------
# structure boundaries
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class BoundaryScore:
    f: float
    precision: float
    recall: float
    matched: int
    n_pred: int
    n_true: int


def section_boundaries_s(sections: Iterable[Any] | None, trim: bool = True, merge_s: float = 1e-3) -> list[float]:
    """Boundary times from sections (dicts or objects with ``start_s``/``end_s``).

    Every start and end is a boundary; duplicates within ``merge_s`` collapse.
    With ``trim`` the first and last boundaries (start and end of the piece)
    are dropped, as in mir_eval, so only real section changes count.
    """
    times: list[float] = []
    for s in sections or ():
        if isinstance(s, Mapping):
            start, end = s.get("start_s"), s.get("end_s")
        else:
            start, end = getattr(s, "start_s", None), getattr(s, "end_s", None)
        for v in (start, end):
            if v is not None and math.isfinite(float(v)):
                times.append(float(v))
    times.sort()
    merged: list[float] = []
    for t in times:
        if not merged or t - merged[-1] > merge_s:
            merged.append(t)
    if trim and merged:
        merged = merged[1:-1]
    return merged


def boundary_f_measure(pred_boundaries_s: Sequence[float], true_boundaries_s: Sequence[float],
                       tol_s: float) -> BoundaryScore:
    """Boundary detection F-measure with a +-``tol_s`` window and one-to-one matching.

    Both lists are sorted and each true boundary is matched greedily to the
    earliest unmatched prediction within the window, which is optimal for
    points on a line with a fixed window.
    """
    pred = sorted(float(t) for t in pred_boundaries_s)
    true = sorted(float(t) for t in true_boundaries_s)
    if not pred and not true:
        return BoundaryScore(1.0, 1.0, 1.0, 0, 0, 0)
    matched = 0
    j = 0
    for t in true:
        while j < len(pred) and pred[j] < t - tol_s:
            j += 1
        if j < len(pred) and abs(pred[j] - t) <= tol_s:
            matched += 1
            j += 1
    precision = matched / len(pred) if pred else 0.0
    recall = matched / len(true) if true else 0.0
    f = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return BoundaryScore(f, precision, recall, matched, len(pred), len(true))


# --------------------------------------------------------------------------
# sample pairs: spans, ranking, transform
# --------------------------------------------------------------------------

PAIR_TRUTH_FIELDS: tuple[str, ...] = ("flip_span_s", "flip_mark_s", "tempo_ratio", "pitch_semitones")
"""Any of these in an item's truth makes it a sample pair, ``kind`` or no ``kind``."""


def is_pair_truth(truth: Mapping[str, Any]) -> bool:
    """True when this item's truth is about a sample pair rather than an annotation."""
    if truth.get("kind") == "sample_pair":
        return True
    return any(truth.get(f) is not None for f in PAIR_TRUTH_FIELDS)


def as_span(value: Any) -> tuple[float, float] | None:
    """``(start_s, end_s)`` from a pair/list of two finite numbers, ordered; else ``None``."""
    if value is None:
        return None
    if isinstance(value, Mapping):
        value = (value.get("start_s"), value.get("end_s"))
    if not isinstance(value, (tuple, list)) or len(value) != 2:
        return None
    try:
        a, b = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(a) and math.isfinite(b)) or b <= a:
        return None
    return a, b


def as_spans(loops: Iterable[Any] | None) -> list[tuple[float, float]]:
    """Candidate spans in rank order; accepts pairs, or objects/dicts with ``start_s``/``end_s``."""
    out: list[tuple[float, float]] = []
    for loop in loops or ():
        span = as_span(loop)
        if span is None and not isinstance(loop, (tuple, list, Mapping)):
            span = as_span((getattr(loop, "start_s", None), getattr(loop, "end_s", None)))
        if span is not None:
            out.append(span)
    return out


def span_iou(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Intersection over union of two spans in seconds; 0.0 when they do not overlap."""
    inter = min(a[1], b[1]) - max(a[0], b[0])
    if inter <= 0:
        return 0.0
    union = (a[1] - a[0]) + (b[1] - b[0]) - inter
    return float(inter / union) if union > 0 else 0.0


def flip_ranks(loops: Sequence[tuple[float, float]], span: tuple[float, float],
               threshold: float = FLIP_IOU_THRESHOLD) -> list[int]:
    """1-based ranks of the candidates that overlap ``span`` at or above ``threshold``."""
    return [i + 1 for i, c in enumerate(loops) if span_iou(c, span) >= threshold - 1e-9]


def best_overlap(loops: Sequence[tuple[float, float]], span: tuple[float, float]) -> tuple[float, int | None]:
    """The best IoU any candidate reaches, and its 1-based rank (``(0.0, None)`` with no candidates)."""
    best, best_rank = 0.0, None
    for i, c in enumerate(loops):
        iou = span_iou(c, span)
        if iou > best:
            best, best_rank = iou, i + 1
    return best, best_rank


def mark_rank(loops: Sequence[tuple[float, float]], mark_s: float,
              tolerance_s: float = MARK_TOLERANCE_S) -> int | None:
    """1-based rank of the first candidate covering ``mark_s``, its span widened by the tolerance."""
    for i, (start, end) in enumerate(loops):
        if start - tolerance_s <= mark_s <= end + tolerance_s:
            return i + 1
    return None


def covered_seconds(loops: Sequence[tuple[float, float]]) -> float:
    """Seconds of the record the candidates cover between them (overlaps counted once).

    ``flip_mark`` has to be read against this: a rack that covers half the
    record covers the producer's timestamp half the time by luck.
    """
    total, end = 0.0, None
    for start, stop in sorted(loops):
        if end is None or start > end:
            total += stop - start
            end = stop
        elif stop > end:
            total += stop - end
            end = stop
    return float(total)


def tempo_ratio_ok(measured: float | None, true_ratio: float | None,
                   tol: float = TEMPO_RATIO_TOLERANCE) -> bool:
    if not measured or not true_ratio:
        return False
    return abs(measured / true_ratio - 1.0) <= tol


def semitone_error(measured: float | None, true_semitones: float | None) -> float | None:
    """Smallest signed difference in semitones, modulo an octave, in ``[-6, 6)``.

    Our alignment derives the shift from two keys, so it can only ever claim a
    pitch class: scoring modulo 12 measures what we assert rather than
    punishing us for an octave we never claimed.
    """
    if measured is None or true_semitones is None:
        return None
    return float(((float(measured) - float(true_semitones) + 6.0) % 12.0) - 6.0)


def score_pair(pred: "Prediction", truth: Mapping[str, Any]) -> dict[str, MetricResult]:
    """The six sample-pair metrics for one pair. Missing truth skips; missing prediction misses."""
    out: dict[str, MetricResult] = {}
    loops = as_spans(pred.loops)
    span = as_span(truth.get("flip_span_s"))
    mark = truth.get("flip_mark_s")
    if mark is None and span is not None:
        mark = span[0]
    tolerance = float(truth.get("mark_tolerance_s") or MARK_TOLERANCE_S)

    # --- did we find the flip: strict, lenient, and how well ranked
    rank_metrics = ("flip_top1", "flip_topk", "flip_mrr")
    if span is None:
        for m in rank_metrics:
            out[m] = _skip(m, "truth has no flip span" if mark is None else
                              "truth has a timestamp but no span")
    elif not loops:
        reason = _stage_reason(pred, "loops", "no loop candidates")
        for m in rank_metrics:
            out[m] = _miss(m, reason)
    else:
        ranks = flip_ranks(loops, span)
        first = ranks[0] if ranks else None
        best_iou, best_rank = best_overlap(loops, span)
        top1_iou = span_iou(loops[0], span)
        detail = {
            "span_s": [round(span[0], 3), round(span[1], 3)],
            "iou_threshold": FLIP_IOU_THRESHOLD,
            "top_k": FLIP_TOP_K,
            "n_candidates": len(loops),
            "first_match_rank": first,
            "top1_span_s": [round(loops[0][0], 3), round(loops[0][1], 3)],
            "top1_iou": round(top1_iou, 3),
            "best_iou": round(best_iou, 3),
            "best_iou_rank": best_rank,
        }
        deep = f"not in the top {len(loops)}"
        out["flip_top1"] = MetricResult(
            "flip_top1", True, 1.0 if first == 1 else 0.0,
            None if first == 1 else (f"the flip is rank {first}" if first else deep), dict(detail))
        in_k = first is not None and first <= FLIP_TOP_K
        out["flip_topk"] = MetricResult(
            "flip_topk", True, 1.0 if in_k else 0.0,
            None if in_k else (f"the flip is rank {first}" if first else deep), dict(detail))
        rr = 1.0 / first if first else 0.0
        out["flip_mrr"] = MetricResult(
            "flip_mrr", True, rr, None if first == 1 else (f"rank {first}" if first else deep), dict(detail))

    # --- the roughest bar: did the rack include the moment they used
    if mark is None:
        out["flip_mark"] = _skip("flip_mark", "truth has no timestamp")
    elif not loops:
        out["flip_mark"] = _miss("flip_mark", _stage_reason(pred, "loops", "no loop candidates"))
    else:
        rank = mark_rank(loops[:FLIP_TOP_K], float(mark), tolerance)
        deep_rank = mark_rank(loops, float(mark), tolerance)
        ok = rank is not None
        out["flip_mark"] = MetricResult(
            "flip_mark", True, 1.0 if ok else 0.0,
            None if ok else (f"covered only at rank {deep_rank}" if deep_rank else
                             "no candidate covers the timestamp"),
            {"mark_s": round(float(mark), 3), "tolerance_s": tolerance, "rank": rank,
             "rank_any_depth": deep_rank, "top_k": FLIP_TOP_K,
             "covered_s": round(covered_seconds(loops[:FLIP_TOP_K]), 3)})

    # --- did we measure the transform right
    true_ratio = truth.get("tempo_ratio")
    if true_ratio is None:
        out["tempo_ratio"] = _skip("tempo_ratio", "truth has no tempo ratio")
    elif not pred.tempo_ratio:
        out["tempo_ratio"] = _miss("tempo_ratio", _stage_reason(pred, "transform", "no tempo ratio measured"))
    else:
        ok = tempo_ratio_ok(pred.tempo_ratio, float(true_ratio))
        rel = pred.tempo_ratio / float(true_ratio)
        if ok:
            reason = None
        elif abs(rel - 2.0) <= 4 * TEMPO_RATIO_TOLERANCE or abs(rel - 0.5) <= TEMPO_RATIO_TOLERANCE:
            reason = "tempo octave"
        else:
            reason = f"off by {(rel - 1.0) * 100:+.0f} %"
        out["tempo_ratio"] = MetricResult(
            "tempo_ratio", True, 1.0 if ok else 0.0, reason,
            {"measured": round(float(pred.tempo_ratio), 4), "true": round(float(true_ratio), 4),
             "tolerance": TEMPO_RATIO_TOLERANCE, **dict(pred.transform)})

    true_pitch = truth.get("pitch_semitones")
    if true_pitch is None:
        out["pitch_shift"] = _skip("pitch_shift", "truth has no pitch shift")
    elif pred.pitch_semitones is None:
        out["pitch_shift"] = _miss("pitch_shift", _stage_reason(pred, "transform", "no pitch shift measured"))
    else:
        err = semitone_error(pred.pitch_semitones, float(true_pitch))
        ok = err is not None and abs(err) <= PITCH_TOLERANCE_ST
        out["pitch_shift"] = MetricResult(
            "pitch_shift", True, 1.0 if ok else 0.0,
            None if ok else f"{pred.pitch_semitones:+.0f} st, not {float(true_pitch):+.0f} st",
            {"measured": float(pred.pitch_semitones), "true": float(true_pitch),
             "error_st": None if err is None else round(err, 3),
             "tolerance_st": PITCH_TOLERANCE_ST, **dict(pred.transform)})
    return out


# --------------------------------------------------------------------------
# report -> prediction, and per-item scoring
# --------------------------------------------------------------------------

@dataclass
class Prediction:
    """What the harness reads off an effective AnalysisReport."""

    bpm: float | None = None
    alternates_bpm: list[float] = field(default_factory=list)
    key: tuple[str, str] | None = None
    key_alternate: tuple[str, str] | None = None
    beats_s: list[float] = field(default_factory=list)
    downbeats_s: list[float] = field(default_factory=list)
    sections: list[dict[str, Any]] = field(default_factory=list)
    has_structure: bool = False
    errors: dict[str, str] = field(default_factory=dict)
    """stage -> failure reason, from ``Context.errors`` or an analysis-level error."""

    # sample pairs only (empty everywhere else)
    loops: list[tuple[float, float]] = field(default_factory=list)
    """ranked loop-candidate spans from ``find_loops`` on the original record."""
    tempo_ratio: float | None = None
    """what our alignment would stretch the original by to sit in the song."""
    pitch_semitones: float | None = None
    """what our alignment would pitch the original by, in semitones."""
    transform: dict[str, Any] = field(default_factory=dict)
    """the measurements the two above came from (both BPMs, both keys), for the report."""


def _as_dict(report: Any) -> Mapping[str, Any]:
    if report is None:
        return {}
    if isinstance(report, Mapping):
        return report
    dump = getattr(report, "model_dump", None)
    if callable(dump):
        return dump(mode="json")
    raise TypeError(f"unsupported report type {type(report)!r}")


def prediction_from_report(report: Any, errors: Mapping[str, str] | None = None) -> Prediction:
    """Build a :class:`Prediction` from an AnalysisReport (model or JSON dict).

    Pass the *effective* report (``lockedgroove.report.effective``) so user
    edits are honored the way every other consumer honors them.
    """
    r = _as_dict(report)
    pred = Prediction(errors=dict(errors or {}))
    tempo = r.get("tempo") or {}
    if tempo.get("bpm") is not None:
        pred.bpm = float(tempo["bpm"])
        pred.alternates_bpm = [float(a) for a in (tempo.get("alternates_bpm") or []) if a is not None]
    key = r.get("key") or {}
    if key:
        pred.key = key_tuple(key)
        pred.key_alternate = key_tuple(key.get("alternate"))
    beats = r.get("beats") or {}
    if beats:
        pred.beats_s = [float(t) for t in (beats.get("times_s") or [])]
        pred.downbeats_s = [float(t) for t in (beats.get("downbeats_s") or [])]
    structure = r.get("structure")
    if structure:
        pred.has_structure = True
        pred.sections = [
            {"start_s": float(s["start_s"]), "end_s": float(s["end_s"]), "label": s.get("label")}
            for s in (structure.get("sections") or [])
        ]
    return pred


@dataclass
class MetricResult:
    metric: str
    applicable: bool
    value: float | None = None
    """1.0 / 0.0 for the boolean metrics, the F-measure for ``structure_f``; ``None`` when not applicable."""
    reason: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def hit(self) -> bool | None:
        if not self.applicable or self.value is None:
            return None
        return self.value >= 1.0 - 1e-9

    def to_json_dict(self) -> dict[str, Any]:
        return {"metric": self.metric, "applicable": self.applicable, "value": self.value,
                "reason": self.reason, "detail": self.detail}


def _skip(metric: str, reason: str) -> MetricResult:
    return MetricResult(metric, applicable=False, reason=reason)


def _miss(metric: str, reason: str, **detail: Any) -> MetricResult:
    return MetricResult(metric, applicable=True, value=0.0, reason=reason, detail=detail)


def _stage_reason(pred: Prediction, stage: str, fallback: str) -> str:
    err = pred.errors.get(stage) or pred.errors.get("analysis")
    return f"{stage}: {err}" if err else fallback


def truth_bar_length_s(truth: Mapping[str, Any]) -> float | None:
    if truth.get("bar_s"):
        return float(truth["bar_s"])
    beats_per_bar = int(truth.get("beats_per_bar") or DEFAULT_BEATS_PER_BAR)
    meter = truth.get("meter")
    if isinstance(meter, str) and "/" in meter:
        try:
            beats_per_bar = int(meter.split("/")[0])
        except ValueError:
            pass
    return bar_length_s(truth.get("downbeats_s"), truth.get("bpm"), beats_per_bar)


def score_item(pred: Prediction, truth: Mapping[str, Any]) -> dict[str, MetricResult]:
    """Score one item. Missing truth fields skip a metric; missing predictions miss it."""
    out: dict[str, MetricResult] = {}

    # tempo
    true_bpm = truth.get("bpm")
    if true_bpm is None:
        out["bpm_exact"] = _skip("bpm_exact", "truth has no bpm")
        out["bpm_octave"] = _skip("bpm_octave", "truth has no bpm")
    elif pred.bpm is None:
        reason = _stage_reason(pred, "tempo", "no tempo in report")
        out["bpm_exact"] = _miss("bpm_exact", reason)
        out["bpm_octave"] = _miss("bpm_octave", reason)
    else:
        exact = bpm_exact(pred.bpm, true_bpm)
        octave = bpm_octave(pred.bpm, true_bpm, pred.alternates_bpm)
        detail = {"pred": pred.bpm, "true": float(true_bpm), "alternates": pred.alternates_bpm}
        out["bpm_exact"] = MetricResult("bpm_exact", True, 1.0 if exact else 0.0,
                                        None if exact else f"off by {pred.bpm - float(true_bpm):+.1f} BPM", detail)
        out["bpm_octave"] = MetricResult("bpm_octave", True, 1.0 if octave else 0.0,
                                         None if octave else "truth not in alternates", detail)

    # key
    true_key = key_tuple(truth.get("key"))
    if true_key is None:
        out["key_exact"] = _skip("key_exact", "truth has no key")
        out["key_relative"] = _skip("key_relative", "truth has no key")
    elif pred.key is None:
        reason = _stage_reason(pred, "key", "no key in report")
        out["key_exact"] = _miss("key_exact", reason)
        out["key_relative"] = _miss("key_relative", reason)
    else:
        exact = key_exact(pred.key, true_key)
        rel = key_relative(pred.key, true_key, pred.key_alternate)
        detail = {"pred": list(pred.key), "true": list(true_key),
                  "alternate": list(pred.key_alternate) if pred.key_alternate else None}
        out["key_exact"] = MetricResult("key_exact", True, 1.0 if exact else 0.0,
                                        None if exact else f"predicted {pred.key[0]} {pred.key[1]}", detail)
        out["key_relative"] = MetricResult("key_relative", True, 1.0 if rel else 0.0,
                                           None if rel else "neither exact, alternate, nor relative", detail)

    # downbeats
    true_db = truth.get("downbeats_s")
    bar_s = truth_bar_length_s(truth)
    if not true_db:
        out["downbeat"] = _skip("downbeat", "truth has no downbeats")
    elif not bar_s:
        out["downbeat"] = _skip("downbeat", "bar length unknown")
    elif not pred.downbeats_s:
        out["downbeat"] = _miss("downbeat", _stage_reason(pred, "beats", "no downbeats in report"))
    else:
        med = downbeat_median_offset_s(pred.downbeats_s, true_db, bar_s)
        ok = med is not None and med <= DOWNBEAT_TOLERANCE_S
        out["downbeat"] = MetricResult("downbeat", True, 1.0 if ok else 0.0,
                                       None if ok else f"median offset {med * 1000:.0f} ms",
                                       {"median_offset_s": med, "bar_s": bar_s})

    # structure boundaries
    true_bounds = section_boundaries_s(truth.get("sections"))
    if not truth.get("sections") or not true_bounds:
        out["structure_f"] = _skip("structure_f", "truth has no section boundaries")
    elif not bar_s:
        out["structure_f"] = _skip("structure_f", "bar length unknown")
    elif not pred.has_structure:
        out["structure_f"] = _miss("structure_f", _stage_reason(pred, "structure", "no structure in report"))
    else:
        pred_bounds = section_boundaries_s(pred.sections)
        bs = boundary_f_measure(pred_bounds, true_bounds, STRUCTURE_TOLERANCE_BARS * bar_s)
        out["structure_f"] = MetricResult(
            "structure_f", True, bs.f,
            None if bs.f >= 1.0 else f"P={bs.precision:.2f} R={bs.recall:.2f}",
            {"precision": bs.precision, "recall": bs.recall, "matched": bs.matched,
             "n_pred": bs.n_pred, "n_true": bs.n_true, "tol_s": STRUCTURE_TOLERANCE_BARS * bar_s},
        )

    # sample pairs score six more; every other dataset never sees them
    if is_pair_truth(truth):
        out.update(score_pair(pred, truth))
    return out


# --------------------------------------------------------------------------
# aggregation and gates
# --------------------------------------------------------------------------

@dataclass
class MetricSummary:
    metric: str
    n: int = 0
    total: float = 0.0
    reasons: Counter = field(default_factory=Counter)

    @property
    def score(self) -> float | None:
        return self.total / self.n if self.n else None

    def add(self, result: MetricResult) -> None:
        if not result.applicable:
            return
        self.n += 1
        self.total += float(result.value or 0.0)
        if result.value is None or result.value < 1.0 - 1e-9:
            self.reasons[result.reason or "miss"] += 1

    def to_json_dict(self) -> dict[str, Any]:
        return {"metric": self.metric, "n": self.n, "score": self.score,
                "reasons": dict(self.reasons.most_common())}


def summarize(item_scores: Iterable[Mapping[str, MetricResult]]) -> dict[str, MetricSummary]:
    summary = {m: MetricSummary(m) for m in METRICS}
    for scores in item_scores:
        for m, result in scores.items():
            summary.setdefault(m, MetricSummary(m)).add(result)
    return summary


def merge_summaries(summaries: Iterable[Mapping[str, MetricSummary]]) -> dict[str, MetricSummary]:
    """Pool several per-dataset summaries into one (item-weighted)."""
    out = {m: MetricSummary(m) for m in METRICS}
    for summary in summaries:
        for m, s in summary.items():
            o = out.setdefault(m, MetricSummary(m))
            o.n += s.n
            o.total += s.total
            o.reasons.update(s.reasons)
    return out


@dataclass(frozen=True)
class GateResult:
    dataset: str
    metric: str
    threshold: float
    score: float | None
    n: int

    @property
    def applicable(self) -> bool:
        return self.n > 0 and self.score is not None

    @property
    def passed(self) -> bool | None:
        if not self.applicable:
            return None
        return self.score + 1e-9 >= self.threshold

    def to_json_dict(self) -> dict[str, Any]:
        return {"dataset": self.dataset, "metric": self.metric, "threshold": self.threshold,
                "score": self.score, "n": self.n, "passed": self.passed}


def check_gates(summaries: Mapping[str, Mapping[str, MetricSummary]],
                gates: Mapping[str, Mapping[str, float]]) -> list[GateResult]:
    """Evaluate gates for every dataset that was scored.

    A gate whose metric did not apply to any item of the dataset (``n == 0``)
    is reported but neither passes nor fails. Datasets in ``gates`` that were
    not scored are ignored here; the CLI decides whether that is an error.
    """
    results: list[GateResult] = []
    for dataset, summary in summaries.items():
        for metric, threshold in (gates.get(dataset) or {}).items():
            s = summary.get(metric)
            n = s.n if s else 0
            score = s.score if s else None
            results.append(GateResult(dataset, metric, float(threshold), score, n))
    return results


__all__ = [
    "ALL_METRICS", "BPM_TOLERANCE", "DEFAULT_BEATS_PER_BAR", "DOWNBEAT_TOLERANCE_S",
    "FLIP_IOU_THRESHOLD", "FLIP_RANK_DEPTH", "FLIP_TOP_K", "MARK_TOLERANCE_S", "METRICS",
    "PAIR_METRICS", "PAIR_TRUTH_FIELDS", "PITCH_CLASSES", "PITCH_TOLERANCE_ST",
    "STRUCTURE_TOLERANCE_BARS", "TEMPO_RATIO_TOLERANCE", "BoundaryScore", "GateResult",
    "MetricResult", "MetricSummary", "Prediction", "as_span", "as_spans", "bar_length_s",
    "best_overlap", "boundary_f_measure", "bpm_exact", "bpm_octave", "check_gates", "covered_seconds",
    "downbeat_median_offset_s", "downbeat_offsets_s", "downbeat_ok", "flip_ranks", "is_pair_truth",
    "key_exact", "key_relative", "key_tuple", "mark_rank", "merge_summaries", "normalize_mode",
    "normalize_tonic", "parse_key", "prediction_from_report", "relative_key", "score_item",
    "score_pair", "section_boundaries_s", "semitone_error", "span_iou", "summarize",
    "tempo_ratio_ok", "truth_bar_length_s",
]
