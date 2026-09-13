"""Loop ranking that learns from one producer's corrections (principle 7).

Three things these tests exist to hold:

* **cold start is exactly today's behaviour** -- an account with no corrections
  gets the finder's list, object for object, with nothing written on it;
* **the adjustment is bounded and legible** -- it moves a score by at most
  ``PERSONAL_SCORE_MAX``, never overwrites a measured term, and can say what it
  did in a sentence;
* **one account's corrections can never reach another's ranking** -- asserted
  from both ends, the read and the apply.
"""

from __future__ import annotations

import uuid

import pytest

from lockedgroove.db import InMemoryDatabase
from lockedgroove.learn import loop_prefs as P
from lockedgroove.learn.loop_prefs import (
    BAR_DELTA_MAX,
    PERSONAL_SCORE_MAX,
    TERM_DELTA_BUDGET,
    LoopPreference,
    apply_preference,
    learn_loop_preference,
    loop_preference_for,
    personalization_enabled,
    read_loop_corrections,
)
from lockedgroove.loops.finder import LoopCandidate

USER_A = str(uuid.uuid4())
USER_B = str(uuid.uuid4())


# --- helpers --------------------------------------------------------------------------------------


def candidate(bars: int, start_s: float, score: float, **terms) -> LoopCandidate:
    components = {
        "seam": 0.6, "phrase": 0.6, "stability": 0.9, "novelty": 1.0,
        "onset_lock": 1.0, "recurrence": 0.5, "period_agreement": 1.0,
        "weights": {"seam": 0.30, "phrase": 0.22, "stability": 0.15, "novelty": 0.15,
                    "onset_lock": 0.10, "recurrence": 0.08},
        "reasons": ["measured"],
    }
    components.update(terms)
    return LoopCandidate(start_s=start_s, end_s=start_s + bars * 2.0, bars=bars, score=score,
                         components=components, name=f"{bars} bars at {start_s}s")


def rack() -> list[LoopCandidate]:
    """Two 4-bar rows and two 2-bar rows, interleaved by measured score."""
    return [candidate(2, 0.0, 0.800), candidate(4, 8.0, 0.790),
            candidate(2, 16.0, 0.780), candidate(4, 24.0, 0.770)]


def edge_drag(user_id: str, before_bars: int, after_bars: int, *, bar_s: float = 2.0) -> dict:
    return {
        "user_id": user_id, "file_id": str(uuid.uuid4()), "field": "loop_edges",
        "predicted": {"start_s": 0.0, "end_s": before_bars * bar_s, "bars": before_bars},
        "corrected": {"start_s": 0.0, "end_s": after_bars * bar_s, "bars": after_bars},
    }


def pick(user_id: str, top: dict, chosen: dict) -> dict:
    return {"user_id": user_id, "file_id": str(uuid.uuid4()), "field": "loop_pick",
            "predicted": {"rank": 1, "bars": top.pop("bars", 4), "components": top},
            "corrected": {"rank": 3, "bars": chosen.pop("bars", 4), "components": chosen}}


# --- cold start -----------------------------------------------------------------------------------


def test_a_new_account_gets_exactly_the_finders_ranking():
    pref = learn_loop_preference(USER_A, [])
    assert pref.is_neutral and pref.strength == 0.0 and pref.n_corrections == 0
    before = rack()
    after = apply_preference(before, pref, USER_A)
    assert [id(c) for c in after] == [id(c) for c in before], "cold start reordered the rack"
    assert [c.to_row() for c in after] == [c.to_row() for c in before]
    assert all("personalization" not in c.components for c in after)


def test_an_account_with_no_loop_corrections_reads_nothing_and_stays_neutral():
    db = InMemoryDatabase()
    db.insert_rows("corrections", [{"user_id": USER_A, "file_id": str(uuid.uuid4()),
                                    "field": "tempo_bpm", "predicted": 90, "corrected": 93}])
    assert read_loop_corrections(db, USER_A) == []
    assert loop_preference_for(db, USER_A).is_neutral


def test_unreadable_payloads_are_skipped_rather_than_guessed_at():
    rows = [
        {"user_id": USER_A, "field": "loop_edges", "predicted": None, "corrected": None},
        {"user_id": USER_A, "field": "loop_edges", "predicted": "??", "corrected": {"bars": "four"}},
        {"user_id": USER_A, "field": "loop_pick", "predicted": {}, "corrected": {}},
        {"user_id": USER_A, "field": "key", "predicted": {"bars": 1}, "corrected": {"bars": 8}},
    ]
    assert learn_loop_preference(USER_A, rows).is_neutral


# --- what it learns -------------------------------------------------------------------------------


def test_a_producer_who_drags_every_loop_out_to_four_bars_gets_four_bars_first():
    rows = [edge_drag(USER_A, 2, 4) for _ in range(12)]
    pref = learn_loop_preference(USER_A, rows)

    assert pref.n_corrections == 12
    assert pref.bar_prior_delta[4] > 0 and pref.bar_prior_delta[2] < 0
    assert pref.longer_votes == 12 and pref.shorter_votes == 0

    before = rack()
    after = apply_preference(before, pref, USER_A)
    assert [c.bars for c in after] == [4, 4, 2, 2], "the lengths this producer keeps did not come first"
    why = pref.explain()
    assert any("4-bar loops rank higher" in r for r in why), why
    assert any("drag loop edges out" in r for r in why), why


def test_a_producer_who_shortens_everything_gets_the_shorter_ones_first():
    rows = [edge_drag(USER_A, 4, 2) for _ in range(12)]
    pref = learn_loop_preference(USER_A, rows)
    assert pref.bar_prior_delta[2] > 0 and pref.bar_prior_delta[4] < 0
    assert pref.shorter_votes == 12 and pref.longer_votes == 0
    after = apply_preference(rack(), pref, USER_A)
    assert [c.bars for c in after] == [2, 2, 4, 4]


def test_bars_are_read_off_a_drag_that_did_not_write_one_down():
    row = {"user_id": USER_A, "field": "loop_edges",
           "predicted": {"start_s": 0.0, "end_s": 4.0, "bars": 2},
           "corrected": {"start_s": 0.0, "end_s": 8.0}}
    pref = learn_loop_preference(USER_A, [row] * 10)
    assert pref.bar_prior_delta[4] > 0, "doubling the span is a vote for four bars"


def test_picking_the_third_row_moves_the_term_it_scored_higher_on():
    rows = [pick(USER_A,
                 top={"bars": 4, "seam": 0.5, "phrase": 0.9, "stability": 0.9,
                      "novelty": 1.0, "onset_lock": 1.0, "recurrence": 0.5},
                 chosen={"bars": 4, "seam": 0.9, "phrase": 0.9, "stability": 0.9,
                         "novelty": 1.0, "onset_lock": 1.0, "recurrence": 0.5})
            for _ in range(10)]
    pref = learn_loop_preference(USER_A, rows)
    assert pref.term_delta["seam"] > 0
    assert set(pref.term_delta) == {"seam"}, "only the term that actually differed may move"
    assert not pref.bar_prior_delta, "both rows were four bars; nothing was said about length"

    smooth = candidate(4, 0.0, 0.780, seam=0.95)
    rough = candidate(4, 8.0, 0.790, seam=0.20)
    after = apply_preference([rough, smooth], pref, USER_A)
    assert after[0] is smooth, "the seam this producer keeps choosing did not win"


def test_the_reasons_are_sentences_a_producer_can_read():
    pref = learn_loop_preference(USER_A, [edge_drag(USER_A, 2, 8) for _ in range(20)])
    text = " ".join(pref.explain())
    assert "8 bars" in text
    assert "corrections" in text
    assert "turn it off" in text
    assert str(PERSONAL_SCORE_MAX) in text or f"{PERSONAL_SCORE_MAX:.2f}" in text
    assert LoopPreference.neutral(USER_A).explain()[0].startswith("No loop corrections yet")
    assert "off for this account" in LoopPreference.neutral(USER_A, enabled=False).explain()[0]


# --- bounded, and never on top of the measurement --------------------------------------------------


def test_the_strength_grows_with_evidence_and_stops():
    assert learn_loop_preference(USER_A, [edge_drag(USER_A, 1, 4)]).strength < 0.2
    many = learn_loop_preference(USER_A, [edge_drag(USER_A, 1, 4) for _ in range(500)])
    assert many.strength == pytest.approx(P.STRENGTH_MAX)
    assert P.STRENGTH_MAX < 1.0, "a producer's history is a strong opinion, never the whole opinion"


def test_the_adjustment_is_bounded_however_lopsided_the_history():
    rows = [edge_drag(USER_A, 1, 8) for _ in range(400)]
    rows += [pick(USER_A,
                  top={"bars": 8, "seam": 0.0, "phrase": 0.0, "stability": 0.0,
                       "novelty": 0.0, "onset_lock": 0.0, "recurrence": 0.0},
                  chosen={"bars": 8, "seam": 1.0, "phrase": 1.0, "stability": 1.0,
                          "novelty": 1.0, "onset_lock": 1.0, "recurrence": 1.0})
             for _ in range(400)]
    pref = learn_loop_preference(USER_A, rows)
    assert all(abs(v) <= BAR_DELTA_MAX + 1e-9 for v in pref.bar_prior_delta.values())
    assert sum(abs(v) for v in pref.term_delta.values()) <= TERM_DELTA_BUDGET + 1e-9

    before = rack() + [candidate(8, 32.0, 0.60), candidate(1, 40.0, 0.95)]
    measured = {id(c): c.score for c in before}
    after = apply_preference(before, pref, USER_A)
    for c in after:
        personal = c.components["personalization"]
        assert abs(personal["delta"]) <= PERSONAL_SCORE_MAX + 1e-9
        assert abs(c.score - measured[id(c)]) <= PERSONAL_SCORE_MAX + 1e-9
        assert 0.0 <= c.score <= 1.0


def test_the_measured_terms_survive_untouched_beside_what_changed():
    pref = learn_loop_preference(USER_A, [edge_drag(USER_A, 2, 4) for _ in range(10)])
    before = rack()
    measured = [(c.score, dict(c.components)) for c in before]
    after = apply_preference(before, pref, USER_A)
    by_start = {c.start_s: c for c in after}
    for (score, components), original in zip(measured, rack(), strict=True):
        c = by_start[original.start_s]
        for term in ("seam", "phrase", "stability", "novelty", "onset_lock", "recurrence"):
            assert c.components[term] == components[term], f"{term} was overwritten"
        personal = c.components["personalization"]
        assert personal["score_measured"] == pytest.approx(score, abs=1e-4)
        assert personal["score_measured"] + personal["delta"] == pytest.approx(c.score, abs=1e-4)
        assert personal["reasons"] and all(isinstance(r, str) for r in personal["reasons"])
        assert personal["why"], "the row has to be able to say why it moved"


def test_a_candidate_without_components_is_carried_through_not_crashed_on():
    """Rows written before these terms existed still rank; they just cannot be personalized."""
    pref = learn_loop_preference(USER_A, [edge_drag(USER_A, 2, 4) for _ in range(10)])
    legacy = LoopCandidate(start_s=0.0, end_s=8.0, bars=4, score=0.9, components=None)  # type: ignore[arg-type]
    after = apply_preference([*rack(), legacy], pref, USER_A)
    assert legacy in after and legacy.score == 0.9

    # a row with components but none of the scored terms still gets its bar count read:
    # ``bars`` is a column, not a measurement that might be missing
    bare = LoopCandidate(start_s=0.0, end_s=8.0, bars=4, score=0.9, components={})
    apply_preference([bare], pref, USER_A)
    assert bare.score > 0.9
    assert bare.components["personalization"]["reasons"] == ["4 bars is a length you keep: +0.018"]


# --- never across accounts --------------------------------------------------------------------------


def test_one_accounts_corrections_never_reach_anothers_ranking():
    db = InMemoryDatabase()
    db.insert_rows("corrections", [edge_drag(USER_A, 1, 8) for _ in range(20)])
    db.insert_rows("corrections", [edge_drag(USER_B, 8, 1) for _ in range(20)])

    a_rows = read_loop_corrections(db, USER_A)
    b_rows = read_loop_corrections(db, USER_B)
    assert len(a_rows) == len(b_rows) == 20
    assert all(r["user_id"] == USER_A for r in a_rows)
    assert all(r["user_id"] == USER_B for r in b_rows)

    a = loop_preference_for(db, USER_A)
    b = loop_preference_for(db, USER_B)
    # opposite histories, opposite preferences: neither leaked into the other
    assert a.bar_prior_delta[8] > 0 and a.bar_prior_delta[1] < 0
    assert b.bar_prior_delta[1] > 0 and b.bar_prior_delta[8] < 0
    assert a == learn_loop_preference(USER_A, a_rows)

    # B's account, ranked alone, is unchanged by everything A ever did
    alone = InMemoryDatabase()
    alone.insert_rows("corrections", b_rows)
    assert loop_preference_for(alone, USER_B).bar_prior_delta == b.bar_prior_delta

    with pytest.raises(ValueError, match="cannot rank for"):
        apply_preference(rack(), a, USER_B)
    with pytest.raises(ValueError, match="another account"):
        learn_loop_preference(USER_A, b_rows)


def test_a_missing_user_id_reads_nothing_rather_than_the_table():
    db = InMemoryDatabase()
    db.insert_rows("corrections", [edge_drag(USER_A, 1, 8) for _ in range(5)])
    assert read_loop_corrections(db, "") == []
    assert read_loop_corrections(db, None) == []  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        learn_loop_preference("", [])
    with pytest.raises(ValueError):
        apply_preference(rack(), LoopPreference.neutral(USER_A), "")


# --- the switch -------------------------------------------------------------------------------------


def test_the_producer_can_turn_it_off():
    db = InMemoryDatabase()
    db.insert_rows("corrections", [edge_drag(USER_A, 2, 8) for _ in range(20)])
    db.insert_rows("profiles", [{"id": USER_A, "user_id": USER_A, "loop_personalization": False}])

    assert personalization_enabled(db, USER_A) is False
    off = loop_preference_for(db, USER_A)
    assert off.is_neutral and off.enabled is False
    before = rack()
    assert [id(c) for c in apply_preference(before, off, USER_A)] == [id(c) for c in before]

    db.update_rows("profiles", {"id": USER_A}, {"loop_personalization": True})
    assert personalization_enabled(db, USER_A) is True
    assert not loop_preference_for(db, USER_A).is_neutral


def test_personalization_defaults_on_when_there_is_no_profile_row():
    db = InMemoryDatabase()
    assert personalization_enabled(db, USER_A) is True
    db.insert_rows("profiles", [{"id": USER_A, "user_id": USER_A}])
    assert personalization_enabled(db, USER_A) is True


# --- cheap enough to run inside a job ----------------------------------------------------------------


def test_the_read_is_one_bounded_query():
    class CountingDb(InMemoryDatabase):
        selects: list[tuple] = []

        def select(self, table, filters=None, limit=None, order=None):
            CountingDb.selects.append((table, dict(filters or {}), limit, order))
            return super().select(table, filters, limit, order)

    db = CountingDb()
    CountingDb.selects = []
    db.insert_rows("corrections", [edge_drag(USER_A, 2, 4) for _ in range(500)])

    pref = loop_preference_for(db, USER_A)

    corrections_reads = [s for s in CountingDb.selects if s[0] == "corrections"]
    assert len(corrections_reads) == 1, CountingDb.selects
    table, filters, limit, order = corrections_reads[0]
    assert filters["user_id"] == USER_A
    assert sorted(filters["field"]) == sorted(P.LOOP_CORRECTION_FIELDS)
    assert limit == P.READ_LIMIT and order == "created_at.desc"
    assert pref.n_corrections == P.READ_LIMIT


def test_the_job_ranks_for_the_files_owner_and_nobody_else():
    """``find_loops`` reads one account's history: the account that owns the file."""
    from lockedgroove.jobs.analyze import personalize_ranking

    db = InMemoryDatabase()
    db.insert_rows("corrections", [edge_drag(USER_A, 2, 4) for _ in range(20)])
    db.insert_rows("corrections", [edge_drag(USER_B, 4, 2) for _ in range(20)])

    a_ranked, a_pref = personalize_ranking(db, {"id": "f1", "user_id": USER_A}, rack(), {})
    b_ranked, b_pref = personalize_ranking(db, {"id": "f2", "user_id": USER_B}, rack(), {})
    assert [c.bars for c in a_ranked] == [4, 4, 2, 2]
    assert [c.bars for c in b_ranked] == [2, 2, 4, 4]
    assert a_pref.user_id == USER_A and b_pref.user_id == USER_B
    assert a_pref.to_dict()["n_corrections"] == b_pref.to_dict()["n_corrections"] == 20

    # a run can opt out, and a file with no owner is a bug, not a shrug
    off_ranked, off_pref = personalize_ranking(db, {"id": "f1", "user_id": USER_A}, rack(),
                                               {"personalize": False})
    assert off_pref.is_neutral and [c.bars for c in off_ranked] == [2, 4, 2, 4]

    # a finder returning plain rows still ranks; there are no components to adjust from
    rows = [{"start_s": 0.0, "end_s": 8.0, "bars": 4, "score": 0.8}]
    plain, plain_pref = personalize_ranking(db, {"id": "f1", "user_id": USER_A}, rows, {})
    assert plain is rows and plain_pref.is_neutral

    from lockedgroove.jobs.common import JobError

    with pytest.raises(JobError, match="no user_id"):
        personalize_ranking(db, {"id": "f3", "user_id": None}, rack(), {})


def test_a_database_that_errors_costs_the_ordering_and_not_the_loops():
    class BrokenDb:
        def select(self, *args, **kwargs):
            raise RuntimeError("postgrest is down")

    assert read_loop_corrections(BrokenDb(), USER_A) == []
    assert personalization_enabled(BrokenDb(), USER_A) is True
    assert loop_preference_for(BrokenDb(), USER_A).is_neutral
