"""Sample-ready loops: what is and is not playing inside a span, per stem.

A loop is only worth flipping if you can use what is in it. The intro before
the singer comes in, the break where the band drops out, the bar after the
last chorus: that is what a producer is scrubbing for. This module measures
each stem's energy across a span and turns it into the claims that answer it:

``vocal_free``   the vocal stem sits at or near its noise floor for the whole span
``drums_free``   same for the drums: chop it and lay your own break under it
``drums_only``   drums present, everything else out: the break
``fullness``     how many stems are meaningfully present, so a lone bass note
                 does not read as a great find

Every claim is a value **with a confidence and a sentence saying why**, never a
bare boolean (principle 2). Two statistics decide presence, not one: the span
**mean** and the span **peak** (the loudest 50 ms window in it). The mean alone
calls a held note tailing off, or one background ad-lib in an otherwise clean
four bars, "clean"; over a loop played thirty times, it is not. The peak rule
is what stops that, and the near-miss lands in a middle band (``faint``) that
is reported as "there is something in there", not as clean.

Levels are read twice: **absolute** (dBFS) and **relative to that stem's own
level everywhere else in the file**, which is the honest reference — a stem is
absent when it is far below what it does when it plays, not when it is below
some fixed number that depends on how the record was mastered.

Separation is not surgical. Stems leak, and a "vocal-free" claim on a smeared
separation deserves less confidence than the same claim on a clean one. The
proxy used here is the stem's own dynamic range across the file
(``isolation_db``): a separation that produced real silence somewhere can be
believed when it says silence here; one whose "quiet" parts still carry the
band cannot. Confidence is scaled by it. Stems from the development stand-in
(model label ending in ``FAKE_MODEL_SUFFIX``) are not a separation at all, so
every claim is **withheld** rather than hedged.

Pure functions over arrays: no I/O, no database, no report. ``finder.py``
calls ``stem_energies`` once per file and ``sample_ready`` once per candidate.
Every threshold is a module constant; tune only against the accuracy harness
(principle 9).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Optional

import numpy as np

# --- constants (tune only against the harness) ----------------------------------------------------

DB_FLOOR = -120.0
"""dB value used for digital silence, so every level is a finite number."""

HOP_S = 0.025
WINDOW_S = 2 * HOP_S
"""Length of the short window whose RMS is the "is anything happening here" unit.

50 ms is about one syllable and about one drum hit: short enough that a single
ad-lib shows up as a peak, long enough not to chase individual waveform cycles.
It is exactly two hops, which is what lets the envelope be built from
non-overlapping block sums in bounded memory: a whole-file cumulative sum per
stem would be hundreds of megabytes on a long file, for no more accuracy than
a 25 ms grid gives.
"""

CHUNK_SAMPLES = 1 << 20
"""Block size for the envelope pass, so peak memory does not scale with the file."""

ACTIVE_RANGE_DB = 40.0
"""Frames within this of the stem's loudest frame are the stem "playing"; their
median is its reference level. Taking a percentile of *all* frames would read a
stem that only sings in the hook as quiet."""

FLOOR_PERCENTILE = 5.0
"""The stem's quietest frames define its noise floor (and so its isolation)."""

# Absence: both statistics have to agree, relative *or* absolute.
ABSENT_MEAN_REL_DB = -38.0
"""Span mean this far below the stem's own level counts as the noise floor."""
ABSENT_PEAK_REL_DB = -26.0
"""...and no 50 ms window inside the span may come nearer than this. One loud
syllable ruins a loop, so the peak gate is the tighter of the two."""
ABSENT_MEAN_ABS_DB = -58.0
ABSENT_PEAK_ABS_DB = -48.0
"""Absolute back-stop for a stem that is quiet over the whole file (its own
reference level is then meaningless)."""

# Presence: loud enough to be material you can actually use.
PRESENT_MEAN_REL_DB = -20.0
PRESENT_PEAK_REL_DB = -12.0
"""Between absent and present is ``faint``: audible, not usable, never "clean"."""

AUDIBLE_REL_DB = -25.0
"""Frames this close to the stem's own level are counted in ``audible_fraction``."""

MARGIN_FULL_DB = 12.0
"""dB past a threshold at which a claim earns full confidence."""
CONF_BASE = 0.50
CONF_SPAN = 0.45
"""confidence = CONF_BASE + CONF_SPAN * min(1, margin / MARGIN_FULL_DB), then
scaled by separation quality. A claim sitting exactly on its threshold is a
coin flip (0.50) and nothing here ever reaches 1.0."""

ISOLATION_POOR_DB = 25.0
ISOLATION_GOOD_DB = 55.0
"""Dynamic range of a stem across the file: below POOR the stem never goes
quiet anywhere, so "quiet here" is weak evidence; above GOOD the separation
demonstrably produces silence."""
TRUST_FLOOR = 0.50
"""Worst-case multiplier on confidence from separation quality, so a claim on a
smeared separation tops out near a coin flip instead of sounding certain."""

LEAKAGE_CORRELATION = 0.85
"""A quiet stem whose 50 ms envelope tracks another stem this closely across the
span is showing that stem's leakage, not its own part. The isolation proxy
cannot see this: a drum leaking into the vocal stem still leaves silence
between the hits, so the stem's dynamic range stays wide."""
LEAKAGE_CONF_CAP = 0.50
"""What suspected leakage does to a "not clean" call: it does not flip it (a
quiet vocal and a leaked snare look alike, and claiming clean is the worse
error), it caps it at a coin flip and says why."""
LEAKAGE_MIN_FRAMES = 8
LEAKAGE_FLAT_DB = 3.0
"""An envelope flatter than this has no shape to correlate; leakage undecided."""

LONE_STEM_FACTOR = 0.80
"""Ranking factor for a span where only one non-drum stem plays (the lone bass
note): still a loop, not a find."""
EMPTY_FACTOR = 0.60
"""Ranking factor for a span where nothing is meaningfully present."""

FAKE_MODEL_SUFFIX = "-fake"
"""Stems whose model label ends in this came from the development stand-in."""

VOCAL_STEM_NAMES = ("vocals", "vocal", "voice", "lead_vocals")
DRUM_STEM_NAMES = ("drums", "drum", "percussion")

FLAG_CLAIM_NAMES = ("vocal_free", "drums_free", "drums_only")
"""The three shapes a producer filters on; each is a value with a confidence."""
CLAIM_NAMES = (*FLAG_CLAIM_NAMES, "fullness")

PRESENCE_ABSENT = "absent"
PRESENCE_FAINT = "faint"
PRESENCE_PRESENT = "present"

SEPARATION_CAVEAT = ("separation leaks: this describes the separated stem, not proof the record has "
                     "nothing there")
STANDIN_CAVEAT = ("these stems came from the development stand-in, not a separation model: no claim "
                  "is made about what is in the span")


# --- small helpers --------------------------------------------------------------------------------


def to_db(power: float) -> float:
    """Mean square -> dB, floored at ``DB_FLOOR`` so silence is a number."""
    if not math.isfinite(power) or power <= 0:
        return DB_FLOOR
    return max(DB_FLOOR, 10.0 * math.log10(power))


def confidence_from_margin(margin_db: float) -> float:
    """A claim's confidence from how far past its threshold the evidence sits."""
    m = abs(float(margin_db))
    return float(CONF_BASE + CONF_SPAN * min(1.0, m / MARGIN_FULL_DB))


def separation_quality(isolation_db: float) -> float:
    """[0, 1]: how much the stem's own dynamic range backs an absence claim."""
    span = ISOLATION_GOOD_DB - ISOLATION_POOR_DB
    return float(np.clip((isolation_db - ISOLATION_POOR_DB) / span, 0.0, 1.0))


def quality_factor(isolation_db: float) -> float:
    """Multiplier applied to every confidence measured on this stem."""
    return float(TRUST_FLOOR + (1.0 - TRUST_FLOOR) * separation_quality(isolation_db))


NEGATED_MARKERS = ("no_", "no-", "non", "minus", "less", "free", "removed", "instrumental", "backing")
"""A stem named for what was taken *out* of it is not that stem: "no_vocals" and
"vocals_removed" are the instrumental, and answering the vocal question from
them would invert the answer."""


def _match_stem(names: Iterable[str], wanted: Sequence[str]) -> Optional[str]:
    lookup = {n.lower(): n for n in names}
    for w in wanted:
        if w in lookup:
            return lookup[w]
    for low, original in lookup.items():
        if any(m in low for m in NEGATED_MARKERS):
            continue
        if any(w in low for w in wanted):
            return original
    return None


def _round(v: Any, nd: int = 2) -> Any:
    if v is None:
        return None
    f = float(v)
    if not math.isfinite(f):
        return None
    return round(f, nd)


# --- source of the stems --------------------------------------------------------------------------


@dataclass(frozen=True)
class StemSource:
    """Where the stems came from, and whether claims may be made from them."""

    model: Optional[str] = None
    trusted: bool = True
    note: Optional[str] = None

    @classmethod
    def from_model(cls, model: Optional[str]) -> "StemSource":
        label = str(model) if model else None
        if label and label.endswith(FAKE_MODEL_SUFFIX):
            return cls(model=label, trusted=False,
                       note="development stand-in separation (a band split, not a model)")
        return cls(model=label, trusted=True)

    def to_dict(self) -> dict[str, Any]:
        return {"model": self.model, "trusted": bool(self.trusted), "note": self.note}


# --- per-track energy -------------------------------------------------------------------------------


@dataclass(frozen=True)
class StemTrack:
    """One stem's frame envelope and whole-file reference levels."""

    name: str
    sr: int
    window: int
    hop: int
    n_samples: int
    frames_power: np.ndarray
    """Mean square of each 50 ms window, one every 25 ms."""
    frames_db: np.ndarray
    active_db: float
    floor_db: float
    max_db: float

    @property
    def isolation_db(self) -> float:
        """How far the stem drops between its loudest and quietest passages."""
        return float(self.active_db - self.floor_db)

    @property
    def quality(self) -> float:
        return quality_factor(self.isolation_db)

    def expected_frames(self, duration_s: float) -> int:
        """How many windows a span this long holds, whether or not the stem reaches."""
        span = duration_s * self.sr - self.window
        return max(1, int(math.floor(span / self.hop)) + 1) if span >= 0 else 1

    def mean_power(self, start_s: float, end_s: float) -> float:
        """Mean square over the *requested* span.

        Averaged over the windows the span *should* hold, so a stem that stops
        early (or never reached this far) reads as the silence it is rather
        than as its last loud moment.
        """
        i0, i1 = self.frame_slice(start_s, end_s)
        if i1 <= i0:
            if self.frames_power.size == 0:
                return 0.0
            mid = int(round((0.5 * (start_s + end_s) * self.sr - 0.5 * self.window) / self.hop))
            return float(self.frames_power[min(max(mid, 0), self.frames_power.size - 1)])
        return float(self.frames_power[i0:i1].sum()) / float(self.expected_frames(end_s - start_s))

    def frame_slice(self, start_s: float, end_s: float) -> tuple[int, int]:
        """Frames lying *entirely* inside ``[start_s, end_s)``.

        A window that straddles the start would count the hit just before the
        loop as if it were in it, which is precisely the edge a producer is
        trying to place. Frames are 50 ms on a 25 ms hop, so the first one
        still begins at the span's own start.
        """
        if self.frames_db.size == 0:
            return 0, 0
        i0 = int(math.ceil(start_s * self.sr / self.hop - 1e-6))
        i1 = int(math.floor((end_s * self.sr - self.window) / self.hop + 1e-6)) + 1
        i0 = min(max(i0, 0), self.frames_db.size)
        i1 = min(max(i1, i0), self.frames_db.size)
        return i0, i1

    def frame_time_s(self, index: int) -> float:
        return float(index * self.hop + 0.5 * self.window) / float(self.sr)


def _block_sums(y: np.ndarray, hop: int) -> np.ndarray:
    """Sum of squares of each ``hop`` samples, in chunks so memory stays flat."""
    n_blocks = int(y.size) // hop
    out = np.zeros(n_blocks, dtype=np.float64)
    per_chunk = max(1, CHUNK_SAMPLES // hop)
    for first in range(0, n_blocks, per_chunk):
        last = min(first + per_chunk, n_blocks)
        seg = np.asarray(y[first * hop:last * hop], dtype=np.float64)
        out[first:last] = np.einsum("ij,ij->i", seg.reshape(-1, hop), seg.reshape(-1, hop))
    return out


def _frame_powers(y: np.ndarray, window: int, hop: int) -> np.ndarray:
    """Mean square of every ``window``-long frame on a ``hop`` grid (``window = 2 * hop``)."""
    n = int(y.size)
    if n == 0:
        return np.zeros(0, dtype=np.float64)
    if n < window:
        seg = np.asarray(y, dtype=np.float64)
        return np.asarray([float(np.dot(seg, seg)) / n], dtype=np.float64)
    blocks = _block_sums(y, hop)
    if blocks.size < 2:
        seg = np.asarray(y[:window], dtype=np.float64)
        return np.asarray([float(np.dot(seg, seg)) / window], dtype=np.float64)
    return (blocks[:-1] + blocks[1:]) / float(window)


def _to_db_array(power: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore"):
        db = 10.0 * np.log10(np.maximum(power, 1e-30))
    return np.maximum(db, DB_FLOOR)


def stem_energy(name: str, y: np.ndarray, sr: int) -> StemTrack:
    """Frame envelope plus reference levels for one stem (mono or ``(channels, n)``)."""
    arr = np.asarray(y)
    if arr.ndim > 1:
        arr = arr.mean(axis=0) if arr.shape[0] <= arr.shape[1] else arr.mean(axis=1)
    if not np.isfinite(arr).all():
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    hop = max(1, int(round(HOP_S * sr)))
    window = 2 * hop
    power = _frame_powers(arr, window, hop)
    frames = _to_db_array(power)
    if frames.size:
        max_db = float(frames.max())
        active = frames[frames >= max_db - ACTIVE_RANGE_DB]
        active_db = float(np.median(active)) if active.size else max_db
        floor_db = float(np.percentile(frames, FLOOR_PERCENTILE))
    else:
        max_db = active_db = floor_db = DB_FLOOR
    return StemTrack(name=name, sr=int(sr), window=window, hop=hop, n_samples=int(arr.size),
                     frames_power=power, frames_db=frames, active_db=active_db, floor_db=floor_db,
                     max_db=max_db)


@dataclass(frozen=True)
class StemEnergies:
    """Every stem of one file, measured once, ready to answer span questions."""

    stems: dict[str, StemTrack]
    sr: int
    duration_s: float
    source: StemSource = field(default_factory=StemSource)
    mix: Optional[StemTrack] = None

    @property
    def names(self) -> list[str]:
        return sorted(self.stems)

    def vocal_stem(self) -> Optional[str]:
        return _match_stem(self.stems, VOCAL_STEM_NAMES)

    def drum_stem(self) -> Optional[str]:
        return _match_stem(self.stems, DRUM_STEM_NAMES)


def stem_energies(stems: Mapping[str, np.ndarray], sr: int, *, mix: Optional[np.ndarray] = None,
                  source: Optional[StemSource] = None) -> Optional[StemEnergies]:
    """Measure every stem once. ``None`` when there is nothing to measure.

    ``stems`` maps stem name -> audio at ``sr`` (mono, or ``(channels, n)``).
    ``mix`` is the file itself when it is to hand; it only adds the "how loud is
    this stem against everything else in the span" reading.
    """
    if not stems or sr <= 0:
        return None
    tracks: dict[str, StemTrack] = {}
    for name, y in stems.items():
        arr = np.asarray(y)
        if arr.size == 0:
            continue
        tracks[str(name)] = stem_energy(str(name), arr, sr)
    if not tracks:
        return None
    mix_track = stem_energy("mix", np.asarray(mix), sr) if mix is not None and np.asarray(mix).size else None
    duration = max(t.n_samples for t in tracks.values()) / float(sr)
    return StemEnergies(stems=tracks, sr=int(sr), duration_s=float(duration),
                        source=source or StemSource(), mix=mix_track)


# --- per-span measurement ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StemSpan:
    """What one stem does across one span, and which presence band that puts it in."""

    stem: str
    mean_db: float
    peak_db: float
    rel_mean_db: float
    rel_peak_db: float
    rel_mix_db: Optional[float]
    audible_fraction: float
    loudest_at_s: Optional[float]
    presence: str
    absent_margin_db: float
    present_margin_db: float
    isolation_db: float
    leakage_correlation: Optional[float] = None
    leaks_from: Optional[str] = None

    @property
    def quality(self) -> float:
        return quality_factor(self.isolation_db)

    @property
    def leakage_suspected(self) -> bool:
        """Is the little that is in here another stem showing through?"""
        return (self.presence == PRESENCE_FAINT and self.leakage_correlation is not None
                and self.leakage_correlation >= LEAKAGE_CORRELATION)

    def cap(self, confidence: float) -> float:
        """Suspected leakage means "can't tell", so nothing about it is confident."""
        if self.leakage_suspected:
            return float(min(confidence, LEAKAGE_CONF_CAP))
        return float(confidence)

    @property
    def band_margin_db(self) -> float:
        """How far inside its band the stem sits (always >= 0 for absent/present)."""
        if self.presence == PRESENCE_ABSENT:
            return max(0.0, self.absent_margin_db)
        if self.presence == PRESENCE_PRESENT:
            return max(0.0, self.present_margin_db)
        return max(0.0, min(-self.absent_margin_db, -self.present_margin_db))

    @property
    def band_confidence(self) -> float:
        """Confidence that the stem is in the band it was put in.

        Separation quality only weighs on the *quiet* readings. "This stem is
        loud here" needs no proof that the separation can produce silence;
        "this stem is not here" does.
        """
        conf = confidence_from_margin(self.band_margin_db)
        if self.presence != PRESENCE_PRESENT:
            conf *= self.quality
        return float(np.clip(self.cap(conf), 0.0, 1.0))

    def to_dict(self) -> dict[str, Any]:
        return {
            "presence": self.presence,
            "mean_db": _round(self.mean_db, 1),
            "peak_db": _round(self.peak_db, 1),
            "rel_mean_db": _round(self.rel_mean_db, 1),
            "rel_peak_db": _round(self.rel_peak_db, 1),
            "rel_mix_db": _round(self.rel_mix_db, 1),
            "audible_fraction": _round(self.audible_fraction, 3),
            "loudest_at_s": _round(self.loudest_at_s, 3),
            "isolation_db": _round(self.isolation_db, 1),
            "leakage_correlation": _round(self.leakage_correlation, 3),
            "leaks_from": self.leaks_from if self.leakage_suspected else None,
        }


def _span_stats(track: StemTrack, start_s: float, end_s: float) -> tuple[float, float, float, Optional[float]]:
    """(mean dB, peak dB, audible fraction, time of the loudest frame)."""
    mean_db = to_db(track.mean_power(start_s, end_s))
    i0, i1 = track.frame_slice(start_s, end_s)
    if i1 > i0:
        window = track.frames_db[i0:i1]
        k = int(np.argmax(window))
        peak_db = float(window[k])
        loudest_at = track.frame_time_s(i0 + k)
        audible_db = max(track.active_db + AUDIBLE_REL_DB, ABSENT_PEAK_ABS_DB)
        audible = float(np.mean(window >= audible_db))
    else:
        peak_db, loudest_at, audible = mean_db, None, 0.0
    return mean_db, peak_db, audible, loudest_at


def span_of(track: StemTrack, start_s: float, end_s: float, mix_mean_db: Optional[float] = None) -> StemSpan:
    """Measure one stem across ``[start_s, end_s)`` and place it in a presence band."""
    mean_db, peak_db, audible, loudest_at = _span_stats(track, start_s, end_s)
    rel_mean = mean_db - track.active_db
    rel_peak = peak_db - track.active_db
    absent_rel = min(ABSENT_MEAN_REL_DB - rel_mean, ABSENT_PEAK_REL_DB - rel_peak)
    absent_abs = min(ABSENT_MEAN_ABS_DB - mean_db, ABSENT_PEAK_ABS_DB - peak_db)
    absent_margin = max(absent_rel, absent_abs)
    # a stem under the absolute absence floor can never read as "present", however
    # loud it is against its own (equally absent) reference level
    present_margin = min(rel_mean - PRESENT_MEAN_REL_DB, rel_peak - PRESENT_PEAK_REL_DB,
                         mean_db - ABSENT_MEAN_ABS_DB)
    if absent_margin > 0:
        presence = PRESENCE_ABSENT
    elif present_margin >= 0:
        presence = PRESENCE_PRESENT
    else:
        presence = PRESENCE_FAINT
    return StemSpan(
        stem=track.name, mean_db=mean_db, peak_db=peak_db, rel_mean_db=rel_mean, rel_peak_db=rel_peak,
        rel_mix_db=None if mix_mean_db is None else mean_db - mix_mean_db,
        audible_fraction=audible, loudest_at_s=loudest_at, presence=presence,
        absent_margin_db=float(absent_margin), present_margin_db=float(present_margin),
        isolation_db=track.isolation_db,
    )


def _envelope(track: StemTrack, start_s: float, end_s: float) -> np.ndarray:
    i0, i1 = track.frame_slice(start_s, end_s)
    return track.frames_db[i0:i1]


def _correlation(a: np.ndarray, b: np.ndarray) -> Optional[float]:
    n = min(a.size, b.size)
    if n < LEAKAGE_MIN_FRAMES:
        return None
    x, y = a[:n], b[:n]
    if float(x.max() - x.min()) < LEAKAGE_FLAT_DB or float(y.max() - y.min()) < LEAKAGE_FLAT_DB:
        return None
    x = x - x.mean()
    y = y - y.mean()
    denom = float(np.linalg.norm(x) * np.linalg.norm(y))
    if denom <= 0:
        return None
    return float(np.clip(np.dot(x, y) / denom, -1.0, 1.0))


def leakage_of(track: StemTrack, others: Sequence[StemTrack], start_s: float, end_s: float
               ) -> tuple[Optional[float], Optional[str]]:
    """Does this stem's envelope across the span follow another stem's?

    Leakage is a scaled copy of the stem it came from, so in dB it is the same
    shape with an offset: a near-perfect correlation with a *louder* stem is
    what a leaked hit looks like, and what a part of its own does not.
    """
    mine = _envelope(track, start_s, end_s)
    best: Optional[float] = None
    from_name: Optional[str] = None
    for other in others:
        if other.name == track.name:
            continue
        r = _correlation(mine, _envelope(other, start_s, end_s))
        if r is not None and (best is None or r > best):
            best, from_name = r, other.name
    return best, from_name


def span_profile(energies: StemEnergies, start_s: float, end_s: float) -> dict[str, StemSpan]:
    """Per-stem measurement of one span, keyed by stem name."""
    mix_mean_db = to_db(energies.mix.mean_power(start_s, end_s)) if energies.mix is not None else None
    tracks = [t for _, t in sorted(energies.stems.items())]
    out: dict[str, StemSpan] = {}
    for track in tracks:
        span = span_of(track, start_s, end_s, mix_mean_db)
        if span.presence == PRESENCE_FAINT:
            r, from_name = leakage_of(track, tracks, start_s, end_s)
            span = replace(span, leakage_correlation=r, leaks_from=from_name)
        out[track.name] = span
    return out


# --- claims ------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Claim:
    """A value with a confidence and the reason for it; never a bare boolean."""

    value: Any
    confidence: float
    why: str
    withheld: Optional[str] = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"value": self.value, "confidence": _round(self.confidence, 3), "why": self.why}
        if self.withheld:
            out["withheld"] = self.withheld
        out.update(self.extra)
        return out


def _withheld(reason: str, why: str, extra: Optional[dict[str, Any]] = None) -> Claim:
    return Claim(value=None, confidence=0.0, why=why, withheld=reason, extra=extra or {})


def _rel_phrase(rel_db: float) -> str:
    return f"{abs(rel_db):.0f} dB {'above' if rel_db > 0 else 'below'} its own level"


def _db_phrase(span: StemSpan) -> str:
    return (f"{_rel_phrase(span.rel_mean_db)} on average, loudest "
            f"{int(round(WINDOW_S * 1000))} ms {_rel_phrase(span.rel_peak_db)}")


def _absence_claim(span: StemSpan, label: str) -> Claim:
    """"Is the {label} out of this span?" — with the near miss called by name."""
    value = span.presence == PRESENCE_ABSENT
    conf = confidence_from_margin(span.absent_margin_db)
    if span.presence != PRESENCE_PRESENT:
        conf *= span.quality
    if value:
        why = f"the {label} stem is at its noise floor across the span: {_db_phrase(span)}"
    elif span.presence == PRESENCE_FAINT:
        at = "" if span.loudest_at_s is None else f" at {span.loudest_at_s:.2f} s"
        why = (f"quiet but not gone: the {label} stem peaks {_rel_phrase(span.rel_peak_db)}{at} "
               f"({_db_phrase(span)})")
        if span.leakage_suspected:
            why += (f"; what is in there follows the {span.leaks_from} stem, which is what leakage "
                    f"looks like, so this is can't-tell rather than not-clean")
    else:
        why = f"the {label} stem is playing here ({_db_phrase(span)})"
    return Claim(value=value, confidence=float(np.clip(span.cap(conf), 0.0, 1.0)), why=why,
                 extra={"stem": span.stem, "presence": span.presence})


def _fullness_claim(profile: Mapping[str, StemSpan]) -> Claim:
    present = sorted(n for n, s in profile.items() if s.presence == PRESENCE_PRESENT)
    faint = sorted(n for n, s in profile.items() if s.presence == PRESENCE_FAINT)
    conf = min((s.band_confidence for s in profile.values()), default=0.0)
    if present:
        why = f"{', '.join(present)} playing"
    else:
        why = "nothing is playing at a usable level"
    if faint:
        why += f"; {', '.join(faint)} faint"
    return Claim(value=len(present), confidence=float(np.clip(conf, 0.0, 1.0)), why=why,
                 extra={"of": len(profile), "stems_present": present, "stems_faint": faint})


def _drums_only_claim(profile: Mapping[str, StemSpan], drums: str) -> Claim:
    others = {n: s for n, s in profile.items() if n != drums}
    drum_span = profile[drums]
    drums_present = drum_span.presence == PRESENCE_PRESENT
    rest_absent = all(s.presence == PRESENCE_ABSENT for s in others.values())
    value = bool(drums_present and rest_absent and others)
    parts = [drum_span.band_confidence] + [s.band_confidence for s in others.values()]
    conf = min(parts) if parts else 0.0
    if value:
        why = "drums are the only thing playing: this is the break"
    elif not drums_present:
        why = f"the drums are not playing at a usable level here ({_db_phrase(drum_span)})"
    else:
        still = sorted(n for n, s in others.items() if s.presence != PRESENCE_ABSENT)
        why = f"drums plus {', '.join(still)}" if still else "no other stem to compare against"
    return Claim(value=value, confidence=float(np.clip(conf, 0.0, 1.0)), why=why)


def ranking_factor(claims: Mapping[str, Claim], trusted: bool) -> float:
    """How much a span's *content* should move it in the ranking.

    Loop quality (seam, stability, novelty, onset lock) is not touched. This
    only stops a span with one lone part in it from outranking a real find —
    except when that one part is the drums, because a break is a find.
    """
    fullness = claims.get("fullness")
    if not trusted or fullness is None or fullness.value is None:
        return 1.0
    count = int(fullness.value)
    if count >= 2:
        return 1.0
    drums_only = claims.get("drums_only")
    if count == 1 and drums_only is not None and drums_only.value:
        return 1.0
    return LONE_STEM_FACTOR if count == 1 else EMPTY_FACTOR


@dataclass(frozen=True)
class SampleReady:
    """The per-stem profile of one span, the claims drawn from it, and the caveats."""

    claims: dict[str, Claim]
    profile: dict[str, StemSpan]
    caveats: list[str]
    ranking_factor: float
    source: StemSource

    def claim(self, name: str) -> Optional[Claim]:
        return self.claims.get(name)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source.to_dict(),
            "claims": {k: v.to_dict() for k, v in self.claims.items()},
            "profile": {k: v.to_dict() for k, v in self.profile.items()},
            "caveats": list(self.caveats),
            "ranking_factor": _round(self.ranking_factor, 3),
        }


def sample_ready(energies: StemEnergies, start_s: float, end_s: float) -> SampleReady:
    """Measure ``[start_s, end_s)`` per stem and draw the claims a producer asks for."""
    profile = span_profile(energies, start_s, end_s)
    source = energies.source
    vocal = energies.vocal_stem()
    drums = energies.drum_stem()
    caveats: list[str] = []

    if not source.trusted:
        reason = source.note or "these stems are not from a separation model"
        withheld_claims = {
            "vocal_free": _withheld(reason, "no claim: the stems are a development stand-in"),
            "drums_free": _withheld(reason, "no claim: the stems are a development stand-in"),
            "drums_only": _withheld(reason, "no claim: the stems are a development stand-in"),
            "fullness": _withheld(reason, "no claim: the stems are a development stand-in",
                                  {"of": len(profile)}),
        }
        caveats.append(STANDIN_CAVEAT)
        return SampleReady(claims=withheld_claims, profile=profile, caveats=caveats, ranking_factor=1.0,
                           source=source)

    claims: dict[str, Claim] = {}
    if vocal is None:
        claims["vocal_free"] = _withheld("this separation has no vocal stem",
                                         f"no vocal stem among {', '.join(energies.names)}")
    else:
        claims["vocal_free"] = _absence_claim(profile[vocal], "vocal")
    if drums is None:
        claims["drums_free"] = _withheld("this separation has no drum stem",
                                         f"no drum stem among {', '.join(energies.names)}")
        claims["drums_only"] = _withheld("this separation has no drum stem",
                                         f"no drum stem among {', '.join(energies.names)}")
    else:
        claims["drums_free"] = _absence_claim(profile[drums], "drums")
        claims["drums_only"] = _drums_only_claim(profile, drums)
    claims["fullness"] = _fullness_claim(profile)

    caveats.append(SEPARATION_CAVEAT)
    for name in {n for n in (vocal, drums) if n}:
        span = profile[name]
        if span.leakage_suspected:
            caveats.append(f"the little that is in the {name} stem here tracks the {span.leaks_from} "
                           f"stem, so it is as likely to be leakage as a real quiet part")
        if separation_quality(span.isolation_db) < 0.5:
            caveats.append(f"the {name} stem never drops near silence anywhere in this file "
                           f"({span.isolation_db:.0f} dB range), so an absence claim about it is "
                           f"weakly evidenced")
    return SampleReady(claims=claims, profile=profile, caveats=caveats,
                       ranking_factor=ranking_factor(claims, source.trusted), source=source)


def reasons(ready: SampleReady) -> list[str]:
    """Short chip texts for the Loops tab and the chat, in the finder's style."""
    out: list[str] = []
    if not ready.source.trusted:
        out.append("stems are the development stand-in: no vocal-free claim")
        return out
    vocal = ready.claim("vocal_free")
    if vocal is not None and vocal.value is True:
        out.append("no vocal in this span" if vocal.confidence >= 0.8 else "likely no vocal in this span")
    elif vocal is not None and vocal.value is False:
        span = ready.profile.get(vocal.extra.get("stem", ""))
        if span is not None and span.presence == PRESENCE_FAINT:
            at = "" if span.loudest_at_s is None else f" around {span.loudest_at_s:.1f}s"
            out.append(f"a quiet vocal is still in here{at}")
        else:
            out.append("the vocal is playing over this")
    drums_only = ready.claim("drums_only")
    drums_free = ready.claim("drums_free")
    if drums_only is not None and drums_only.value:
        out.append("drums only: this is the break")
    elif drums_free is not None and drums_free.value:
        out.append("no drums: chop it and lay your own under it")
    fullness = ready.claim("fullness")
    if fullness is not None and fullness.value is not None:
        n = int(fullness.value)
        is_break = drums_only is not None and bool(drums_only.value)
        if n == 0:
            out.append("nothing is playing at a usable level")
        elif n == 1 and not is_break:
            only = ", ".join(fullness.extra.get("stems_present", [])) or "one stem"
            out.append(f"only the {only} is playing")
        elif not is_break:
            out.append(f"{n} of {fullness.extra.get('of', n)} stems playing")
    return out


# --- selecting loops by what is in them ----------------------------------------------------------------


def components_of(loop: Any) -> dict[str, Any]:
    """``components`` of a candidate, a ``loops`` row, or a components dict itself."""
    if isinstance(loop, Mapping):
        comp = loop.get("components", loop)
    else:
        comp = getattr(loop, "components", None)
    return comp if isinstance(comp, Mapping) else {}


def claim_of(loop: Any, name: str) -> Optional[dict[str, Any]]:
    """The stored claim dict for ``name``, or ``None`` when the loop has no stem profile."""
    block = components_of(loop).get("sample_ready")
    if not isinstance(block, Mapping):
        return None
    claim = (block.get("claims") or {}).get(name)
    return dict(claim) if isinstance(claim, Mapping) else None


def _bars_of(loop: Any) -> Optional[int]:
    value = loop.get("bars") if isinstance(loop, Mapping) else getattr(loop, "bars", None)
    return None if value is None else int(value)


def _score_of(loop: Any) -> float:
    value = loop.get("score") if isinstance(loop, Mapping) else getattr(loop, "score", None)
    return float(value or 0.0)


def holds(loop: Any, name: str, want: bool = True, min_confidence: float = 0.6) -> bool:
    """Does this loop carry claim ``name`` as ``want`` at or above ``min_confidence``?

    A withheld claim (no stems, a stand-in separation, no such stem) is never a
    match: "show me the vocal-free loops" must not answer with loops nobody
    measured.
    """
    claim = claim_of(loop, name)
    if not claim or claim.get("withheld") or claim.get("value") is None:
        return False
    return bool(claim["value"]) is bool(want) and float(claim.get("confidence") or 0.0) >= min_confidence


def filter_loops(loops: Iterable[Any], *, vocal_free: Optional[bool] = None,
                 drums_free: Optional[bool] = None, drums_only: Optional[bool] = None,
                 min_stems: Optional[int] = None, bars: Optional[int | Sequence[int]] = None,
                 min_confidence: float = 0.6) -> list[Any]:
    """"Show me the vocal-free 4 bar loops in this record", as a function.

    Works on ``LoopCandidate`` objects and on ``loops`` rows alike.
    """
    want_bars = None if bars is None else ({int(bars)} if isinstance(bars, int) else {int(b) for b in bars})
    out = []
    for loop in loops:
        if want_bars is not None and _bars_of(loop) not in want_bars:
            continue
        if vocal_free is not None and not holds(loop, "vocal_free", vocal_free, min_confidence):
            continue
        if drums_free is not None and not holds(loop, "drums_free", drums_free, min_confidence):
            continue
        if drums_only is not None and not holds(loop, "drums_only", drums_only, min_confidence):
            continue
        if min_stems is not None:
            claim = claim_of(loop, "fullness")
            if not claim or claim.get("value") is None or int(claim["value"]) < int(min_stems):
                continue
        out.append(loop)
    return out


def sort_loops(loops: Iterable[Any], *, prefer: Sequence[str] = (), min_confidence: float = 0.6) -> list[Any]:
    """Sort by the claims a producer asked for first, then by loop score.

    ``prefer=("vocal_free",)`` puts the measured vocal-free loops on top,
    most confident first, and leaves everything else in score order below.
    """
    def key(loop: Any) -> tuple:
        hits = tuple(1 if holds(loop, name, True, min_confidence) else 0 for name in prefer)
        conf = 0.0
        for name in prefer:
            claim = claim_of(loop, name)
            if claim and claim.get("value") and not claim.get("withheld"):
                conf = max(conf, float(claim.get("confidence") or 0.0))
        return (-sum(hits), -conf, -_score_of(loop))
    return sorted(loops, key=key)


__all__ = [
    "ABSENT_MEAN_ABS_DB", "ABSENT_MEAN_REL_DB", "ABSENT_PEAK_ABS_DB", "ABSENT_PEAK_REL_DB",
    "CLAIM_NAMES", "DB_FLOOR", "EMPTY_FACTOR", "FAKE_MODEL_SUFFIX", "FLAG_CLAIM_NAMES",
    "HOP_S", "ISOLATION_GOOD_DB",
    "ISOLATION_POOR_DB", "LEAKAGE_CONF_CAP", "LEAKAGE_CORRELATION", "LONE_STEM_FACTOR",
    "MARGIN_FULL_DB", "NEGATED_MARKERS",
    "PRESENCE_ABSENT", "PRESENCE_FAINT",
    "PRESENCE_PRESENT", "PRESENT_MEAN_REL_DB", "PRESENT_PEAK_REL_DB", "SEPARATION_CAVEAT",
    "STANDIN_CAVEAT", "WINDOW_S", "Claim", "SampleReady", "StemEnergies", "StemSource", "StemSpan",
    "StemTrack", "claim_of", "components_of", "confidence_from_margin", "filter_loops", "holds",
    "leakage_of", "quality_factor", "ranking_factor", "reasons", "sample_ready",
    "separation_quality",
    "sort_loops", "span_of", "span_profile", "stem_energies", "stem_energy", "to_db",
]
