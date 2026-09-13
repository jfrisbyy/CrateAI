"""Loop ranking that learns from one producer's corrections, and says so.

When a producer drags a loop's edges out to four bars, or plays the third row
instead of the first, that is a fact about what *they* think a good loop is.
The ``corrections`` table already records it (principle 7); this module is what
reads it back.

What it learns
--------------
Two things, both of them adjustments to numbers the finder already publishes in
``components``, both bounded, and both printable in a sentence:

``bar_prior_delta``
    per bar count, a shift of :data:`lockedgroove.loops.finder.BAR_PRIOR` -- the
    finder's default claim that four bars is the usual unit of a sampled loop.
    A producer who always ends up on eight bars moves their own eight-bar prior
    up. Bounded by ``BAR_DELTA_MAX``.
``term_delta``
    per scored term (``seam``, ``phrase``, ``stability``, ``novelty``,
    ``onset_lock``, ``recurrence``), a shift of that term's weight, learned from
    the candidates this producer picked over the one we ranked first. The whole
    vector is bounded: ``sum(|delta|) <= TERM_DELTA_BUDGET``.

Both are scaled by ``strength``, which grows with the number of corrections and
stops at ``STRENGTH_MAX``. Nothing here can overwrite a measurement: the
adjusted score is the measured score plus a delta clipped to
``PERSONAL_SCORE_MAX``, and every measured term stays in ``components``
untouched next to a record of exactly what moved and why.

What keeps it inside one account
--------------------------------
Every read is filtered by ``user_id`` and every :class:`LoopPreference` carries
the ``user_id`` it was learned for. :func:`learn_loop_preference` refuses a row
belonging to anyone else, and :func:`apply_preference` refuses to apply a
preference to another account's ranking. There is no cache, no shared state and
no cross-account aggregate anywhere in this module: with a hundred accounts on
the machine, a hundred separate reads happen.

Cold start
----------
An account with no loop corrections gets :meth:`LoopPreference.neutral`, whose
``strength`` is 0. :func:`apply_preference` then returns the finder's own list,
unchanged object for unchanged object. New accounts get the tuned defaults and
nothing personal, and a test pins that.

Cost
----
One ``select`` of at most ``READ_LIMIT`` rows for one user, served by the
partial index ``corrections (user_id, created_at desc) where field in
('loop_edges', 'loop_bars', 'loop_pick')``, then arithmetic over a few hundred
dicts. It runs inside the ``find_loops`` job next to a file download and a
librosa feature pass; it is not a training pipeline and must never become one.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

LOOP_CORRECTION_FIELDS: tuple[str, ...] = ("loop_edges", "loop_bars", "loop_pick")
"""``corrections.field`` values this module reads. Anything else is not its business.

``loop_edges``  a loop's edges were dragged: ``predicted`` and ``corrected`` are
                ``{"start_s", "end_s", "bars"?}`` (the offered span and the kept one).
``loop_bars``   the bar count was set explicitly: ``predicted``/``corrected`` are
                the numbers, or the same span shape as above.
``loop_pick``   a candidate was taken over the one ranked first: ``predicted`` is
                the top row, ``corrected`` the chosen row, each
                ``{"bars", "rank"?, "components"?}``.

The three are written by the web when a producer edits a loop. A row whose
payload does not carry what a signal needs is skipped, never guessed at.
"""

SCORED_TERMS: tuple[str, ...] = ("seam", "phrase", "stability", "novelty", "onset_lock", "recurrence")
"""The finder's terms, which are the only things a preference is allowed to move."""

READ_LIMIT = 300
"""Most recent loop corrections read per user. Beyond a few hundred the shape stops moving."""

STRENGTH_HALF = 8.0
"""``strength = min(STRENGTH_MAX, n / (n + STRENGTH_HALF))``: at ``n`` corrections it is 0.5.

Eight edits is about one session of real use: enough that a producer would be
annoyed to see the same wrong ranking again, few enough that one afternoon of
unusual work cannot rewrite their defaults. With ``STRENGTH_MAX`` at 0.6 the cap
is reached at twelve corrections, which is deliberate -- the cap itself is the
conservative part, not the climb to it.
"""
STRENGTH_MAX = 0.6
"""The cap. A producer's history is a strong opinion, never the whole opinion."""

BAR_DELTA_MAX = 0.5
"""Largest shift of one bar count's prior, before ``strength`` scales it down.

At full strength that is 0.6 * 0.5 = 0.3 on a prior that runs 0.25 to 1.0 --
enough to move one length class past another (score blocks on a real record sit
about 0.05 apart), never enough to make a length win on nothing else.
"""
TERM_DELTA_BUDGET = 0.10
"""Total ``sum(|term_delta|)``, before ``strength``. The six weights sum to 1."""

PERSONAL_SCORE_MAX = 0.15
"""Hard cap on how far a preference may move any one candidate's score.

The single number to quote when someone asks how much of the ranking is theirs
and how much is the measurement: at most 0.15 of a score that runs 0 to 1.
"""

MIN_DURATION_S = 1e-3
_EPS = 1e-9


# ---------------------------------------------------------------------------
# reading the rows
# ---------------------------------------------------------------------------


def read_loop_corrections(db: Any, user_id: str, limit: int = READ_LIMIT) -> list[dict]:
    """The most recent loop corrections for **one** account. Never raises.

    The ``user_id`` filter is not a convenience: it is the whole guarantee.
    A falsy ``user_id`` returns nothing rather than the table.
    """
    if not user_id or not isinstance(user_id, str):
        return []
    try:
        rows = db.select(
            "corrections",
            {"user_id": user_id, "field": list(LOOP_CORRECTION_FIELDS)},
            limit=int(limit),
            order="created_at.desc",
        )
    except Exception:  # a ranking must never fail because history could not be read
        log.warning("could not read loop corrections", exc_info=True)
        return []
    return [r for r in rows if isinstance(r, Mapping) and r.get("user_id") == user_id]


def personalization_enabled(db: Any, user_id: str) -> bool:
    """Whether this account wants its corrections to shape its ranking.

    ``profiles.loop_personalization`` (default true). A missing profile row or
    an unreadable table means *on*, because that is the default the column has;
    the producer's explicit ``false`` is the only thing that turns it off.
    """
    if not user_id:
        return False
    try:
        rows = db.select("profiles", {"id": user_id}, limit=1)
    except Exception:
        log.warning("could not read the profile for personalization", exc_info=True)
        return True
    if not rows:
        return True
    value = rows[0].get("loop_personalization")
    return True if value is None else bool(value)


# ---------------------------------------------------------------------------
# reading one row
# ---------------------------------------------------------------------------


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    try:
        out = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _bars_of(payload: Any) -> int | None:
    """The bar count a payload names, or the one a plain number is."""
    n = _number(payload)
    if n is not None and n > 0 and float(n).is_integer():
        return int(n)
    m = _as_mapping(payload)
    if m is None:
        return None
    bars = _number(m.get("bars"))
    if bars is not None and bars > 0 and float(bars).is_integer():
        return int(bars)
    return None


def _duration_of(payload: Any) -> float | None:
    m = _as_mapping(payload)
    if m is None:
        return None
    for key in ("duration_s", "length_s"):
        d = _number(m.get(key))
        if d is not None and d > MIN_DURATION_S:
            return d
    start, end = _number(m.get("start_s")), _number(m.get("end_s"))
    if start is None or end is None or end - start <= MIN_DURATION_S:
        return None
    return end - start


def _terms_of(payload: Any) -> dict[str, float]:
    """The finder's scored terms inside a payload, from ``components`` or the payload itself."""
    m = _as_mapping(payload)
    if m is None:
        return {}
    source = _as_mapping(m.get("components")) or m
    out: dict[str, float] = {}
    for term in SCORED_TERMS:
        value = _number(source.get(term))
        if value is not None and 0.0 - _EPS <= value <= 1.0 + _EPS:
            out[term] = float(min(1.0, max(0.0, value)))
    return out


@dataclass
class _Evidence:
    """One usable observation: the bar counts voted for and against, and term differences."""

    kept_bars: int | None = None
    dropped_bars: int | None = None
    longer: bool | None = None
    term_diff: dict[str, float] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.kept_bars or self.dropped_bars or self.term_diff or self.longer is not None)


def _evidence_from(row: Mapping[str, Any]) -> _Evidence | None:
    """What one corrections row says about loop ranking, or ``None`` when it says nothing."""
    field_name = str(row.get("field") or "")
    if field_name not in LOOP_CORRECTION_FIELDS:
        return None
    predicted, corrected = row.get("predicted"), row.get("corrected")
    ev = _Evidence()

    kept, dropped = _bars_of(corrected), _bars_of(predicted)
    if kept is not None and kept != dropped:
        ev.kept_bars = kept
        ev.dropped_bars = dropped

    before, after = _duration_of(predicted), _duration_of(corrected)
    if before is not None and after is not None and abs(after - before) > MIN_DURATION_S:
        ev.longer = after > before
        if ev.kept_bars is None and dropped is not None:
            # the edges moved but nobody wrote down a bar count: read it off the ratio
            scaled = dropped * after / before
            if abs(scaled - round(scaled)) < 0.02 and round(scaled) >= 1 and round(scaled) != dropped:
                ev.kept_bars, ev.dropped_bars = int(round(scaled)), dropped

    if field_name == "loop_pick":
        chosen, first = _terms_of(corrected), _terms_of(predicted)
        # only terms both rows published can be compared, and only the ones that
        # actually differed say anything about why one was taken over the other
        ev.term_diff = {t: chosen[t] - first[t] for t in sorted(set(chosen) & set(first))
                        if abs(chosen[t] - first[t]) > 1e-6}
    return ev or None


# ---------------------------------------------------------------------------
# the preference
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LoopPreference:
    """One account's bounded, legible adjustment to the loop ranking.

    Immutable, carries the ``user_id`` it belongs to, and knows how to say what
    it does in sentences a producer can read.
    """

    user_id: str
    n_corrections: int = 0
    strength: float = 0.0
    bar_prior_delta: Mapping[int, float] = field(default_factory=dict)
    term_delta: Mapping[str, float] = field(default_factory=dict)
    longer_votes: int = 0
    shorter_votes: int = 0
    enabled: bool = True

    @classmethod
    def neutral(cls, user_id: str, *, enabled: bool = True) -> LoopPreference:
        """Cold start: what a new account gets, and what "off" gets. Changes nothing."""
        return cls(user_id=user_id, enabled=enabled)

    @property
    def is_neutral(self) -> bool:
        return (not self.enabled or self.strength <= 0.0
                or (not self.bar_prior_delta and not self.term_delta))

    def bar_delta(self, bars: int | None) -> float:
        return float(self.bar_prior_delta.get(int(bars), 0.0)) if bars else 0.0

    def explain(self) -> list[str]:
        """Plain sentences: what this account's history changed, and by how much.

        These are what the chat answers "why is this one first for me" with, and
        what the account screen shows next to the switch that turns it off.
        """
        if not self.enabled:
            return ["Personal loop ranking is off for this account: every loop is ranked "
                    "by the measurement alone."]
        if self.is_neutral:
            return ["No loop corrections yet, so loops are ranked by the measurement alone. "
                    "Drag a loop's edges or pick a different row and this starts learning."]
        out = [f"Learned from your last {self.n_corrections} loop "
               f"correction{'' if self.n_corrections == 1 else 's'}, at "
               f"{self.strength * 100:.0f}% of the most this is allowed to count."]
        for bars, delta in sorted(self.bar_prior_delta.items(), key=lambda kv: -abs(kv[1])):
            if abs(delta) < 0.01:
                continue
            direction = "higher" if delta > 0 else "lower"
            out.append(f"You keep {'ending up on' if delta > 0 else 'moving off'} "
                       f"{bars} bar{'' if bars == 1 else 's'}, so {bars}-bar loops rank "
                       f"{direction} for you ({delta:+.2f} on their prior).")
        for term, delta in sorted(self.term_delta.items(), key=lambda kv: -abs(kv[1])):
            if abs(delta) < 0.005:
                continue
            out.append(f"The loops you choose score {'higher' if delta > 0 else 'lower'} on "
                       f"{_TERM_WORDS.get(term, term)} than the ones we put first, so it counts "
                       f"{'more' if delta > 0 else 'less'} for you ({delta:+.3f} of weight).")
        if self.longer_votes != self.shorter_votes:
            longer = self.longer_votes > self.shorter_votes
            out.append(f"You usually drag loop edges {'out' if longer else 'in'} "
                       f"({self.longer_votes} longer, {self.shorter_votes} shorter).")
        out.append(f"This comes from your corrections only, never anyone else's, it can move a "
                   f"loop's score by at most {PERSONAL_SCORE_MAX:.2f}, and you can turn it off.")
        return out

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe, for ``jobs.result`` and the account screen. No ``user_id``: the caller knows it."""
        return {
            "enabled": bool(self.enabled),
            "neutral": bool(self.is_neutral),
            "n_corrections": int(self.n_corrections),
            "strength": round(float(self.strength), 4),
            "bar_prior_delta": {str(k): round(float(v), 4) for k, v in sorted(self.bar_prior_delta.items())},
            "term_delta": {k: round(float(v), 4) for k, v in sorted(self.term_delta.items())},
            "score_cap": PERSONAL_SCORE_MAX,
            "why": self.explain(),
        }


_TERM_WORDS = {
    "seam": "how the loop point sounds",
    "phrase": "being a whole phrase",
    "stability": "even energy",
    "novelty": "staying inside one section",
    "onset_lock": "starting on a hit",
    "recurrence": "coming back elsewhere in the record",
}


def learn_loop_preference(user_id: str, rows: Iterable[Mapping[str, Any]], *,
                          enabled: bool = True) -> LoopPreference:
    """Turn one account's corrections into its bounded preference.

    Raises ``ValueError`` when a row belongs to someone else. That is not
    defensive programming: it is the mechanism that makes principle 7's "never
    crosses users" checkable rather than merely intended.
    """
    if not user_id:
        raise ValueError("a loop preference needs a user_id")
    if not enabled:
        return LoopPreference.neutral(user_id, enabled=False)

    bar_votes: dict[int, float] = {}
    term_sum: dict[str, float] = {}
    term_n = 0
    longer = shorter = 0
    n_used = 0
    for row in rows:
        owner = row.get("user_id")
        if owner is not None and owner != user_id:
            raise ValueError("loop corrections from another account reached learn_loop_preference")
        ev = _evidence_from(row)
        if ev is None:
            continue
        n_used += 1
        if ev.kept_bars:
            bar_votes[ev.kept_bars] = bar_votes.get(ev.kept_bars, 0.0) + 1.0
        if ev.dropped_bars and ev.dropped_bars != ev.kept_bars:
            bar_votes[ev.dropped_bars] = bar_votes.get(ev.dropped_bars, 0.0) - 1.0
        if ev.longer is True:
            longer += 1
        elif ev.longer is False:
            shorter += 1
        if ev.term_diff:
            term_n += 1
            for term, diff in ev.term_diff.items():
                term_sum[term] = term_sum.get(term, 0.0) + diff

    if n_used == 0:
        return LoopPreference.neutral(user_id)

    strength = min(STRENGTH_MAX, n_used / (n_used + STRENGTH_HALF))

    total_votes = sum(abs(v) for v in bar_votes.values())
    bar_delta: dict[int, float] = {}
    if total_votes > 0:
        for bars, votes in bar_votes.items():
            value = strength * BAR_DELTA_MAX * (votes / total_votes)
            if abs(value) >= 0.005:
                bar_delta[int(bars)] = round(_clip(value, -BAR_DELTA_MAX, BAR_DELTA_MAX), 6)

    term_delta: dict[str, float] = {}
    if term_n > 0 and term_sum:
        mean = {t: v / term_n for t, v in term_sum.items()}
        scale = sum(abs(v) for v in mean.values())
        if scale > 0:
            budget = strength * TERM_DELTA_BUDGET
            for term, value in mean.items():
                out = budget * value / scale
                if abs(out) >= 0.0005:
                    term_delta[term] = round(out, 6)

    return LoopPreference(user_id=user_id, n_corrections=n_used, strength=round(strength, 6),
                          bar_prior_delta=bar_delta, term_delta=term_delta,
                          longer_votes=longer, shorter_votes=shorter, enabled=True)


def loop_preference_for(db: Any, user_id: str, *, limit: int = READ_LIMIT,
                        enabled: bool | None = None) -> LoopPreference:
    """Read this account's corrections and learn from them. One select, then arithmetic."""
    if not user_id:
        raise ValueError("a loop preference needs a user_id")
    if enabled is None:
        enabled = personalization_enabled(db, user_id)
    if not enabled:
        return LoopPreference.neutral(user_id, enabled=False)
    return learn_loop_preference(user_id, read_loop_corrections(db, user_id, limit=limit))


# ---------------------------------------------------------------------------
# applying it
# ---------------------------------------------------------------------------


def _clip(value: float, low: float, high: float) -> float:
    return low if value < low else (high if value > high else value)


def _candidate_delta(candidate: Any, pref: LoopPreference, weights: Mapping[str, float],
                     phrase_length_share: float) -> tuple[float, list[str]]:
    """How far this candidate moves, and the reasons, from values already in ``components``."""
    components = getattr(candidate, "components", None) or {}
    why: list[str] = []
    delta = 0.0

    bar_delta = pref.bar_delta(getattr(candidate, "bars", None))
    if bar_delta:
        agreement = components.get("period_agreement")
        agreement = 1.0 if agreement is None else float(agreement)
        moved = float(weights.get("phrase", 0.0)) * phrase_length_share * agreement * bar_delta
        if abs(moved) >= 1e-6:
            delta += moved
            bars = int(getattr(candidate, "bars", 0) or 0)
            kept = "a length you keep" if bar_delta > 0 else "a length you move off"
            why.append(f"{bars} bar{'' if bars == 1 else 's'} is {kept}: {moved:+.3f}")

    for term, weight_delta in pref.term_delta.items():
        value = components.get(term)
        if value is None:
            continue
        moved = float(weight_delta) * float(value)
        if abs(moved) >= 1e-6:
            delta += moved
            counts = "counts more" if weight_delta > 0 else "counts less"
            why.append(f"{_TERM_WORDS.get(term, term)} {counts} for you: {moved:+.3f}")

    return _clip(delta, -PERSONAL_SCORE_MAX, PERSONAL_SCORE_MAX), why


def apply_preference(candidates: Sequence[Any], pref: LoopPreference, user_id: str) -> list[Any]:
    """Re-rank one account's candidates by its own preference. Returns a new list.

    The candidates themselves are updated in place: ``score`` and the new
    ``components["personalization"]`` entry. The measured terms in
    ``components`` are never touched; the measured score is kept beside the
    adjusted one in ``components["personalization"]``, which also carries the
    delta, the reasons and the cap, so the whole adjustment is visible in the
    row the producer is looking at and a chat answer can read it from there.

    ``score`` becomes the adjusted score because that is what orders the rack
    (``loops`` is read ``order by score desc``). A neutral preference returns the
    finder's own list, object for object, with nothing written at all.
    """
    if not user_id:
        raise ValueError("apply_preference needs the user_id the candidates belong to")
    if pref.user_id != user_id:
        raise ValueError(
            f"a loop preference learned for {pref.user_id!r} cannot rank for {user_id!r}")
    out = list(candidates)
    if pref.is_neutral or not out:
        return out

    from ..loops.finder import PHRASE_LENGTH_SHARE, WEIGHTS

    summary = pref.to_dict()
    adjusted: list[tuple[float, float, Any]] = []
    for candidate in out:
        components = getattr(candidate, "components", None)
        if not isinstance(components, dict):
            adjusted.append((-float(getattr(candidate, "score", 0.0) or 0.0),
                             float(getattr(candidate, "start_s", 0.0) or 0.0), candidate))
            continue
        measured = float(getattr(candidate, "score", 0.0) or 0.0)
        weights = components.get("weights") if isinstance(components.get("weights"), Mapping) else WEIGHTS
        delta, why = _candidate_delta(candidate, pref, weights, PHRASE_LENGTH_SHARE)
        score = round(_clip(measured + delta, 0.0, 1.0), 4)
        components["personalization"] = {
            **summary,
            "applied": bool(delta),
            "score_measured": round(measured, 4),
            "delta": round(delta, 4),
            "reasons": why,
        }
        candidate.score = score
        adjusted.append((-score, float(getattr(candidate, "start_s", 0.0) or 0.0), candidate))

    adjusted.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in adjusted]


__all__ = [
    "BAR_DELTA_MAX", "LOOP_CORRECTION_FIELDS", "PERSONAL_SCORE_MAX", "READ_LIMIT", "SCORED_TERMS",
    "STRENGTH_HALF", "STRENGTH_MAX", "TERM_DELTA_BUDGET", "LoopPreference", "apply_preference",
    "learn_loop_preference", "loop_preference_for", "personalization_enabled",
    "read_loop_corrections",
]
