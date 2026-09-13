"""Compatibility: what in the crate works with this file.

Two measured things decide whether a pair of files can play together, and this
module is the arithmetic for both. Nothing here reads audio or a database: the
inputs are the tempo and key a file was already measured at (its *effective*
values, so a user's correction wins over the prediction), and the outputs are a
relationship, the move it would take, a score in [0, 1], a ``method`` and a
``confidence`` that can never exceed the confidence of the measurements it rests
on (principle 2).

Tempo
-----
Two files share a grid when one can be stretched onto the other without the
stretch being audible. The comparison is octave-folded first: 170 and 85 BPM are
the same grid counted differently, so the candidate's tempo is multiplied by the
power of two that brings it nearest the source (``fold_tempo``) before any
stretch is measured. ``MAX_OCTAVES`` bounds the fold at one octave by default;
half-time and double-time are the moves producers actually make.

What is left after the fold is the stretch ratio: ``source / folded candidate``,
the number the candidate's playback rate is multiplied by (the same direction as
``combine.align.plan_alignment``'s ``stretch_ratio``). A ratio of 1.02 means the
candidate plays 2 % faster. The bands are symmetric in ratio space, which is why
they read as 0.94-1.06 and 0.88-1.14 in one direction and 1.06-0.94 in the
other: ``stretch_distance`` is ``max(ratio, 1 / ratio) - 1``, transparent up to
``TRANSPARENT_MAX`` (6 %) and usable up to ``USABLE_MAX`` (14 %). Past that a
time-stretch smears transients badly enough that a producer would hear it, so
the pair is not offered.

Key
---
In order of strength (``RELATIONSHIP_STRENGTH``):

``same``         identical tonic and mode.
``relative``     relative major/minor: A minor and C major, the same pitches.
``dominant``     the candidate is a perfect fifth above the source, same mode.
``subdominant``  a perfect fifth below, same mode.
``parallel``     same tonic, other mode: C major against C minor.

Those five need no pitch shift at all, so they are searched first. Anything else
is reached by shifting the candidate, and the search takes the smallest shift
that lands on one of the five (ties by strength, then by the upward shift, which
is the convention ``combine.align.semitone_shift`` already uses). A shift beyond
``CHARACTER_SHIFT`` (2 semitones) changes the character of the material enough
that the caller has to say so: ``KeyMatch.shifts_character``.

A file with no key -- a drum break, a hat loop, a noise sweep -- is compatible
with everything. That is the common case in a producer's crate, not an edge
case, so it is not a failure: the relationship is ``unknown``, the key axis drops
out of the score, and the combined claim rests on tempo alone and says so.

"No key" is two things. The key stage may not have run, leaving the section
empty. More often the stage ran and returned something anyway: K-S on a chroma
always has a best profile, so a drum break reads as a key at about 0.37
confidence (HANDOFF_dsp choice 11), which is a number about the chroma and not
about the music. So the material is asked whether it is tonal at all, by the same
rule ``combine.align.AlignItem.is_tonal`` uses and the layer render obeys
(``NON_TONAL_TAGS``, plus a stem whose name says drums): non-tonal material has
no key here, whatever the chroma said. A tonal file whose key is merely
*uncertain* keeps its key and its low confidence -- that is what the confidence
is for, and discarding it would throw away a real measurement.

Confidence
----------
A compatibility claim is a claim about two measurements, so it is at most as
confident as the weakest one it uses (the minimum, not a product: the claim is
not less true for resting on two solid numbers instead of one). Only the axes
the claim actually uses bind it -- a keyless drum break's missing key does not
drag the tempo claim down, but a key measured at 0.42 caps every harmonic claim
built on it at 0.42. ``Compatibility.confidence_bound_by`` names the input that
set the cap and ``confidence_reason`` says it in words. A value that is present
but carries no recorded confidence is treated as 0: measure, don't guess.

Score
-----
``tempo_score`` falls linearly from 1.0 at an exact match to 0.5 at the edge of
the usable band, with a small ``OCTAVE_PENALTY`` per fold so that a literal
tempo agreement outranks a half-time one when everything else is equal.
``key_score`` is the relationship's strength times a per-semitone shift penalty.
The two are averaged (``TEMPO_WEIGHT``, ``KEY_WEIGHT``); with no key on either
side the score is the tempo score alone. The number only ranks candidates, it
does not decide anything: ``compatible`` does that, and it is about the bands.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from typing import Literal, Optional

from ..report import PITCH_CLASSES

# --- tempo -----------------------------------------------------------------
TRANSPARENT_MAX = 0.06
USABLE_MAX = 0.14
MAX_OCTAVES = 1
OCTAVE_PENALTY = 0.03
NO_TEMPO_SCORE = 0.5

# --- key -------------------------------------------------------------------
MAX_SHIFT = 6
CHARACTER_SHIFT = 2
# combine.align.NON_TONAL_TAGS; kept in step with web/app/api/layers/vitals.ts
NON_TONAL_TAGS = frozenset({"drums", "drum", "break", "percussion", "hats", "kick", "snare", "beatbox"})
SHIFT_PENALTY = 0.12
NO_KEY_SCORE = 1.0
RELATIONSHIP_STRENGTH: dict[str, float] = {
    "same": 1.0,
    "relative": 0.9,
    "dominant": 0.8,
    "subdominant": 0.8,
    "parallel": 0.7,
}

# --- combination -----------------------------------------------------------
TEMPO_WEIGHT = 0.5
KEY_WEIGHT = 0.5

TempoFold = Literal["none", "half", "double"]
StretchQuality = Literal["transparent", "usable", "out_of_range", "unknown"]
KeyRelationship = Literal["same", "relative", "dominant", "subdominant", "parallel", "unknown"]

TEMPO_METHOD = (
    f"octave-folded tempo ratio, transparent <= {TRANSPARENT_MAX:.0%}, usable <= {USABLE_MAX:.0%}, "
    f"fold up to {MAX_OCTAVES} octave"
)
KEY_METHOD = (
    f"key relationship (same, relative, fifth up or down, parallel), smallest pitch shift up to "
    f"{MAX_SHIFT} semitones"
)
METHOD = f"{TEMPO_METHOD}; {KEY_METHOD}"

_FLAT_TO_SHARP = {"DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#", "CB": "B", "FB": "E",
                  "E#": "F", "B#": "C"}


def is_tonal(kind: str = "original", tags: Iterable[str] = (), filename: str = "") -> bool:
    """Does this material have a key at all? The rule ``combine.align.AlignItem.is_tonal`` uses.

    A drum stem, a break, a hat loop: the chroma still has a best profile, and the layer render
    will apply no pitch shift to it. Compatibility says the same thing: no key to clash with.
    """
    if kind == "stem" and "drums" in (filename or "").lower():
        return False
    return not any(str(t).strip().lower() in NON_TONAL_TAGS for t in tags)


@dataclass(frozen=True)
class TrackVitals:
    """What a compatibility question needs to know about one file.

    The values are the *effective* ones (``report.effective`` resolves user
    edits over predictions), and the confidences are the ones the analysis
    stages recorded. ``bpm`` or ``tonic`` of ``None`` means not measured, which
    is a fact about the file, not a missing argument.
    """

    file_id: Optional[str] = None
    bpm: Optional[float] = None
    bpm_confidence: Optional[float] = None
    tonic: Optional[str] = None
    mode: Optional[str] = None
    key_confidence: Optional[float] = None
    # false for drums and other non-tonal material: whatever the chroma read, it has no key
    tonal: bool = True

    @property
    def has_tempo(self) -> bool:
        return self.bpm is not None and self.bpm > 0

    @property
    def has_key(self) -> bool:
        return self.tonal and bool(self.tonic) and self.mode in ("major", "minor")


@dataclass(frozen=True)
class TempoMatch:
    source_bpm: Optional[float]
    candidate_bpm: Optional[float]
    # the candidate's tempo after the octave fold: what it is counted as here
    folded_bpm: Optional[float]
    octave_factor: float
    fold: TempoFold
    # source / folded candidate: what the candidate's playback rate is multiplied by
    ratio: Optional[float]
    # (ratio - 1) * 100, signed: +2.0 means the candidate plays 2 % faster
    percent: Optional[float]
    # max(ratio, 1/ratio) - 1: how far the stretch is from transparent, either direction
    distance: Optional[float]
    quality: StretchQuality
    compatible: bool
    score: float
    confidence: Optional[float]
    method: str
    note: str

    def to_json(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class KeyMatch:
    source_tonic: Optional[str]
    source_mode: Optional[str]
    candidate_tonic: Optional[str]
    candidate_mode: Optional[str]
    relationship: KeyRelationship
    # semitones the candidate is shifted by to reach the relationship; 0 for the five direct ones
    semitone_shift: int
    shifts_character: bool
    compatible: bool
    score: float
    confidence: Optional[float]
    method: str
    note: str

    def to_json(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Compatibility:
    score: float
    confidence: float
    # which measurement capped the confidence: source_tempo, candidate_key, ... or "" for none
    confidence_bound_by: str
    confidence_reason: str
    method: str
    compatible: bool
    reason: str
    tempo: TempoMatch
    key: KeyMatch

    def to_json(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# tempo
# ---------------------------------------------------------------------------


def fold_tempo(source_bpm: float, candidate_bpm: float, max_octaves: int = MAX_OCTAVES) -> tuple[float, float]:
    """``(octave_factor, ratio)``: the power of two that brings the candidate nearest, and what is left.

    ``octave_factor`` multiplies the candidate's tempo (2.0 = count it double-time), and ``ratio``
    is ``source / (candidate * octave_factor)``, the stretch the candidate still needs.

    >>> fold_tempo(170.0, 85.0)
    (2.0, 1.0)
    """
    if source_bpm <= 0 or candidate_bpm <= 0:
        raise ValueError("tempos must be positive")
    exponent = round(math.log2(source_bpm / candidate_bpm))
    exponent = max(-max_octaves, min(max_octaves, int(exponent)))
    factor = float(2.0**exponent)
    return factor, source_bpm / (candidate_bpm * factor)


def stretch_distance(ratio: float) -> float:
    """How far a stretch ratio is from transparent, in either direction: ``max(r, 1/r) - 1``."""
    if ratio <= 0:
        raise ValueError("ratio must be positive")
    return max(ratio, 1.0 / ratio) - 1.0


def _fold_name(factor: float) -> TempoFold:
    if factor > 1.0:
        return "double"
    if factor < 1.0:
        return "half"
    return "none"


def compare_tempo(source: TrackVitals, candidate: TrackVitals, *, tolerance: float = USABLE_MAX,
                  max_octaves: int = MAX_OCTAVES) -> TempoMatch:
    """Octave-folded tempo comparison. ``tolerance`` is the widest ``stretch_distance`` still offered."""
    conf = _pair_confidence(source.bpm_confidence, candidate.bpm_confidence)
    if not source.has_tempo or not candidate.has_tempo:
        side = "neither file" if not source.has_tempo and not candidate.has_tempo else (
            "this file" if not source.has_tempo else "the other file")
        return TempoMatch(
            source_bpm=source.bpm, candidate_bpm=candidate.bpm, folded_bpm=None, octave_factor=1.0,
            fold="none", ratio=None, percent=None, distance=None, quality="unknown", compatible=True,
            score=NO_TEMPO_SCORE, confidence=None, method=TEMPO_METHOD,
            note=f"no tempo measured on {side}; tempo says nothing either way",
        )
    factor, ratio = fold_tempo(float(source.bpm), float(candidate.bpm), max_octaves)
    distance = stretch_distance(ratio)
    limit = max(0.0, float(tolerance))
    if distance <= TRANSPARENT_MAX:
        quality: StretchQuality = "transparent"
    elif distance <= limit:
        quality = "usable"
    else:
        quality = "out_of_range"
    score = max(0.0, 1.0 - distance / (2.0 * USABLE_MAX)) * (1.0 - OCTAVE_PENALTY) ** abs(
        int(round(math.log2(factor)))
    )
    fold = _fold_name(factor)
    folded = float(candidate.bpm) * factor
    note = f"{candidate.bpm:g} BPM"
    if fold != "none":
        note += f" counted {fold}-time as {folded:g}"
    note += f", stretched x{ratio:.4f} onto {source.bpm:g} BPM ({quality.replace('_', ' ')})"
    return TempoMatch(
        source_bpm=float(source.bpm), candidate_bpm=float(candidate.bpm), folded_bpm=folded,
        octave_factor=factor, fold=fold, ratio=ratio, percent=(ratio - 1.0) * 100.0, distance=distance,
        quality=quality, compatible=quality != "out_of_range", score=round(score, 6), confidence=conf,
        method=TEMPO_METHOD, note=note,
    )


# ---------------------------------------------------------------------------
# key
# ---------------------------------------------------------------------------


def pitch_class(tonic: str) -> Optional[int]:
    """0-11 for a tonic spelled with sharps or flats; ``None`` when it is not a note name.

    The report spells tonics with sharps (CLAUDE.md conventions), but a user edit or another
    caller may hand over "Bb" or "D♭", so both spellings are accepted.
    """
    if not tonic:
        return None
    text = tonic.strip().replace("♯", "#").replace("♭", "b")
    if not text or not ("A" <= text[0].upper() <= "G"):
        return None
    accidental = text[1:].strip()
    if accidental in ("", "#"):
        spelled = text[0].upper() + accidental
    elif accidental.lower() == "b":
        spelled = text[0].upper() + "b"
    else:
        return None
    if spelled in PITCH_CLASSES:
        return PITCH_CLASSES.index(spelled)
    sharp = _FLAT_TO_SHARP.get(spelled.upper())
    return PITCH_CLASSES.index(sharp) if sharp else None


def direct_relationship(source_pc: int, source_mode: str, candidate_pc: int,
                        candidate_mode: str) -> Optional[str]:
    """One of the five no-shift relationships, or ``None``.

    The fifth relationships require the same mode: G major against C minor is not a dominant
    pairing, it is a B natural against a B flat.
    """
    interval = (candidate_pc - source_pc) % 12
    if candidate_mode == source_mode:
        if interval == 0:
            return "same"
        if interval == 7:
            return "dominant"
        if interval == 5:
            return "subdominant"
        return None
    if interval == 0:
        return "parallel"
    # the relative minor sits 9 semitones above its major (A minor over C major)
    if source_mode == "major" and candidate_mode == "minor" and interval == 9:
        return "relative"
    if source_mode == "minor" and candidate_mode == "major" and interval == 3:
        return "relative"
    return None


def key_relationship(source_tonic: str, source_mode: str, candidate_tonic: str, candidate_mode: str,
                     max_shift: int = MAX_SHIFT) -> tuple[Optional[str], int]:
    """``(relationship, semitone_shift)``: the smallest shift of the candidate that lands on a relationship.

    Shift 0 is tried first, so a pair that already works is never pitched. Within one shift size the
    stronger relationship wins, and an upward shift beats a downward one (``align.semitone_shift``'s
    convention). ``(None, 0)`` when nothing is reachable inside ``max_shift``.
    """
    src = pitch_class(source_tonic)
    cand = pitch_class(candidate_tonic)
    if src is None or cand is None or source_mode not in ("major", "minor") or candidate_mode not in (
            "major", "minor"):
        return None, 0
    for size in range(0, max(0, int(max_shift)) + 1):
        found: list[tuple[float, int, str]] = []
        for shift in ((0,) if size == 0 else (size, -size)):
            rel = direct_relationship(src, source_mode, (cand + shift) % 12, candidate_mode)
            if rel is not None:
                found.append((RELATIONSHIP_STRENGTH[rel], shift, rel))
        if found:
            found.sort(key=lambda f: (-f[0], -f[1]))
            return found[0][2], found[0][1]
    return None, 0


def relationship_words(relationship: str, candidate_mode: Optional[str]) -> str:
    """The relationship as a producer would say it: "relative minor", "a fifth up"."""
    if relationship == "same":
        return "same key"
    if relationship == "relative":
        return f"relative {candidate_mode or 'key'}"
    if relationship == "dominant":
        return "a fifth up"
    if relationship == "subdominant":
        return "a fifth down"
    if relationship == "parallel":
        return f"parallel {candidate_mode or 'key'}"
    return "no key detected"


def compare_key(source: TrackVitals, candidate: TrackVitals, *,
                max_semitones: int = MAX_SHIFT) -> KeyMatch:
    """Key relationship with the shift it needs. Missing key on either side is compatible, not a failure."""
    conf = _pair_confidence(source.key_confidence, candidate.key_confidence)
    if not source.has_key or not candidate.has_key:
        side = "neither file" if not source.has_key and not candidate.has_key else (
            "this file" if not source.has_key else "the other file")
        why = "drum or other non-tonal material" if not (source.tonal and candidate.tonal) else "no key measured"
        return KeyMatch(
            source_tonic=source.tonic, source_mode=source.mode, candidate_tonic=candidate.tonic,
            candidate_mode=candidate.mode, relationship="unknown", semitone_shift=0,
            shifts_character=False, compatible=True, score=NO_KEY_SCORE, confidence=None,
            method=KEY_METHOD,
            note=f"{why} on {side}; nothing to clash, so it fits anything on that axis",
        )
    limit = max(0, int(max_semitones))
    rel, shift = key_relationship(str(source.tonic), str(source.mode), str(candidate.tonic),
                                  str(candidate.mode), max_shift=limit)
    if rel is None:
        widest, widest_shift = key_relationship(str(source.tonic), str(source.mode),
                                                str(candidate.tonic), str(candidate.mode))
        note = (f"{candidate.tonic} {candidate.mode} against {source.tonic} {source.mode} needs "
                f"{abs(widest_shift)} semitones to reach {widest}, past the {limit} allowed")
        return KeyMatch(
            source_tonic=source.tonic, source_mode=source.mode, candidate_tonic=candidate.tonic,
            candidate_mode=candidate.mode, relationship="unknown", semitone_shift=widest_shift,
            shifts_character=abs(widest_shift) > CHARACTER_SHIFT, compatible=False, score=0.0,
            confidence=conf, method=KEY_METHOD, note=note,
        )
    score = RELATIONSHIP_STRENGTH[rel] * max(0.0, 1.0 - SHIFT_PENALTY * abs(shift))
    words = relationship_words(rel, candidate.mode)
    note = f"{candidate.tonic} {candidate.mode} is the {words} of {source.tonic} {source.mode}" if shift == 0 else (
        f"{candidate.tonic} {candidate.mode} shifted {shift:+d} semitones is the {words} of "
        f"{source.tonic} {source.mode}")
    return KeyMatch(
        source_tonic=source.tonic, source_mode=source.mode, candidate_tonic=candidate.tonic,
        candidate_mode=candidate.mode, relationship=rel, semitone_shift=shift,
        shifts_character=abs(shift) > CHARACTER_SHIFT, compatible=True, score=round(score, 6),
        confidence=conf, method=KEY_METHOD, note=note,
    )


# ---------------------------------------------------------------------------
# confidence
# ---------------------------------------------------------------------------


def _pair_confidence(a: Optional[float], b: Optional[float]) -> Optional[float]:
    """The weaker of two recorded confidences; ``None`` when neither side recorded one."""
    values = [v for v in (a, b) if v is not None]
    if not values:
        return None
    return float(min(max(0.0, min(1.0, v)) for v in values))


_LABELS = {
    "source_tempo": "this file's tempo",
    "candidate_tempo": "the other file's tempo",
    "source_key": "this file's key",
    "candidate_key": "the other file's key",
}


def _bound_confidence(tempo: TempoMatch, key: KeyMatch, source: TrackVitals,
                      candidate: TrackVitals) -> tuple[float, str, str]:
    """The cap the used measurements put on the claim, and which one set it."""
    used: list[tuple[str, float]] = []
    if tempo.quality != "unknown":
        used.append(("source_tempo", _clamp(source.bpm_confidence)))
        used.append(("candidate_tempo", _clamp(candidate.bpm_confidence)))
    if key.relationship != "unknown":
        used.append(("source_key", _clamp(source.key_confidence)))
        used.append(("candidate_key", _clamp(candidate.key_confidence)))
    if not used:
        return 0.0, "", "nothing was measured on either file, so this is a guess and not offered as more"
    field, value = min(used, key=lambda u: u[1])
    reason = f"{_LABELS[field]} was measured at {value:.2f}, and no claim built on it can be surer than that"
    return value, field, reason


def _clamp(value: Optional[float]) -> float:
    """A present measurement with no recorded confidence is a 0, not a 1 (principle 2)."""
    if value is None:
        return 0.0
    return float(max(0.0, min(1.0, value)))


# ---------------------------------------------------------------------------
# the pair
# ---------------------------------------------------------------------------


def compatibility(source: TrackVitals, candidate: TrackVitals, *, stretch_tolerance: float = USABLE_MAX,
                  max_semitones: int = MAX_SHIFT, max_octaves: int = MAX_OCTAVES) -> Compatibility:
    """Does the candidate work with the source? Tempo and key, scored, with the confidence they allow."""
    tempo = compare_tempo(source, candidate, tolerance=stretch_tolerance, max_octaves=max_octaves)
    key = compare_key(source, candidate, max_semitones=max_semitones)
    if key.relationship == "unknown" and key.compatible:
        score = tempo.score
        method = f"{TEMPO_METHOD}; no key on one side, so tempo alone"
    elif tempo.quality == "unknown":
        score = key.score
        method = f"{KEY_METHOD}; no tempo on one side, so key alone"
    else:
        score = TEMPO_WEIGHT * tempo.score + KEY_WEIGHT * key.score
        method = METHOD
    confidence, bound_by, reason = _bound_confidence(tempo, key, source, candidate)
    return Compatibility(
        score=round(min(1.0, max(0.0, score)), 6), confidence=round(confidence, 6),
        confidence_bound_by=bound_by, confidence_reason=reason, method=method,
        compatible=tempo.compatible and key.compatible, reason=describe_match(tempo, key),
        tempo=tempo, key=key,
    )


def _tempo_words(tempo: TempoMatch) -> str:
    if tempo.quality == "unknown":
        return "no tempo detected"
    parts: list[str] = []
    if tempo.fold != "none":
        parts.append(f"needs {tempo.fold}-time")
    percent = tempo.percent or 0.0
    if abs(percent) < 0.05:
        if not parts:
            parts.append("same tempo")
    else:
        rounded = round(abs(percent), 1)
        shown = f"{rounded:.0f}" if abs(rounded - round(rounded)) < 0.05 else f"{rounded:.1f}"
        parts.append(f"{shown}% {'faster' if percent > 0 else 'slower'}")
    return " and ".join(parts)


def describe_match(tempo: TempoMatch, key: KeyMatch) -> str:
    """The row's plain line: "relative minor, 2% faster", "same key, needs half-time".

    Nothing in it is generated: every clause names a measured value or the move it implies.
    """
    if key.relationship == "unknown" and key.compatible:
        tempo_words = _tempo_words(tempo)
        if tempo_words == "same tempo":
            tempo_words = "tempo only"
        return f"no key detected, {tempo_words}"
    if key.relationship == "unknown":
        return f"{key.candidate_tonic} {key.candidate_mode} does not fit, {_tempo_words(tempo)}"
    words = relationship_words(key.relationship, key.candidate_mode)
    if key.semitone_shift:
        direction = "up" if key.semitone_shift > 0 else "down"
        plural = "" if abs(key.semitone_shift) == 1 else "s"
        words += f" {direction} {abs(key.semitone_shift)} semitone{plural}"
    return f"{words}, {_tempo_words(tempo)}"


def describe(c: Compatibility) -> str:
    """``describe_match`` for a finished ``Compatibility``; the same string as its ``reason``."""
    return describe_match(c.tempo, c.key)


def vitals_from_report(report, file_id: Optional[str] = None) -> TrackVitals:
    """Read the vitals off an ``AnalysisReport``. Pass the *effective* report: user edits win.

    Tonality comes from the report's own tags and file kind, so a drums stem is keyless here
    exactly as it is keyless to the layer render.
    """
    tempo = getattr(report, "tempo", None)
    key = getattr(report, "key", None)
    info = getattr(report, "file", None)
    tags = [getattr(t, "tag", "") for t in (getattr(report, "tags", None) or [])]
    return TrackVitals(
        file_id=file_id or getattr(info, "id", None),
        bpm=getattr(tempo, "bpm", None),
        bpm_confidence=getattr(tempo, "confidence", None),
        tonic=getattr(key, "tonic", None),
        mode=getattr(key, "mode", None),
        key_confidence=getattr(key, "confidence", None),
        tonal=is_tonal(getattr(info, "kind", "original") or "original", tags,
                       getattr(info, "original_filename", "") or ""),
    )


__all__ = [
    "CHARACTER_SHIFT", "Compatibility", "KEY_METHOD", "KEY_WEIGHT", "KeyMatch", "MAX_OCTAVES",
    "MAX_SHIFT", "METHOD", "NON_TONAL_TAGS", "NO_KEY_SCORE", "NO_TEMPO_SCORE", "OCTAVE_PENALTY",
    "RELATIONSHIP_STRENGTH", "SHIFT_PENALTY", "TEMPO_METHOD", "TEMPO_WEIGHT", "TRANSPARENT_MAX",
    "TempoMatch", "TrackVitals", "USABLE_MAX", "compare_key", "compare_tempo", "compatibility",
    "describe", "describe_match", "direct_relationship", "fold_tempo", "is_tonal", "key_relationship",
    "pitch_class",
    "relationship_words", "stretch_distance", "vitals_from_report",
]
