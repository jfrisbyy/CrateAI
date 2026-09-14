"""The loop closed end to end: the web writes a correction, the rack moves for that account.

Everything in :mod:`test_loop_prefs` is about the reader in isolation. This is
the wire. It starts from an empty database, replays the exact rows the web's
route handlers insert -- ``tests/fixtures/loop_corrections_from_web.json`` is
written by ``web/app/api/loops/corrections.test.ts`` from the routes themselves,
so a payload that drifts on either side fails on both -- and then runs the real
``find_loops`` job over a real record.

Three accounts share one database and hold opposite histories:

* one keeps dragging four-bar offers out to eight bars;
* one has never corrected anything;
* one keeps pulling them in to two.

What must hold: the rack moves the way each producer's own corrections point,
does not move at all for the one with no history, and never moves because of
anyone else's. Cold start and the off switch have to land on the same rack the
finder would have written on its own -- not close to it, the same one.
"""

from __future__ import annotations

import json
import pathlib
import types
import uuid

import pytest
import soundfile as sf

from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import sha256_file
from lockedgroove.jobs import run_job
from lockedgroove.learn.loop_prefs import PERSONAL_SCORE_MAX
from lockedgroove.report import AnalysisReport, Beats, Section, Structure, Tempo
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import loop_based_track

SR = 22050
BPM = 90.0
TOP_K = 12
FIXTURE = pathlib.Path(__file__).parent / "fixtures" / "loop_corrections_from_web.json"


# --- the crate ------------------------------------------------------------------------------------


def _report(truth: dict) -> dict:
    """What the analysis stages measured, from the synth's own ground truth.

    Built from truth rather than run through the stages so that what moves here
    is the ranking and the history, never a beat tracker having a better day.
    """
    sections = [Section(start_s=s["start_s"], end_s=s["end_s"], start_bar=s["start_bar"], bars=s["bars"],
                        label=s["label"], energy=0.5, confidence=0.9) for s in truth["sections"]]
    report = AnalysisReport(
        tempo=Tempo(bpm=truth["bpm"], confidence=0.95, method="truth", alternates_bpm=[]),
        beats=Beats(times_s=truth["beats_s"], confidence=0.95, method="truth",
                    downbeats_s=truth["downbeats_s"], downbeat_phase=0,
                    downbeat_confidence=0.9, downbeat_method="truth", meter="4/4"),
        structure=Structure(sections=sections, loop_period_bars=truth["loop_period_bars"],
                            loop_period_confidence=0.8, method="truth"))
    return report.model_dump(mode="json")


@pytest.fixture(scope="module")
def crate(tmp_path_factory):
    """One record on disk: sixteen bars, ABAB, built on a four-bar loop."""
    tmp = tmp_path_factory.mktemp("crate")
    y, truth = loop_based_track(bpm=BPM, sr=SR, loop_bars=4, sections="ABAB", section_bars=8)
    wav = tmp / "record.wav"
    sf.write(wav, y, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    storage = LocalStorage(tmp / "bucket")
    path = f"library/shared/{sha[:2]}/{sha}.wav"
    storage.upload(path, str(wav))
    return types.SimpleNamespace(storage=storage, sha=sha, path=path, report=_report(truth),
                                 loop_period_bars=int(truth["loop_period_bars"]))


def add_account(db: InMemoryDatabase, crate, history: str | None) -> tuple[str, dict]:
    """A user, their copy of the record, and the corrections the web logged for them."""
    user_id = str(uuid.uuid4())
    file = db.insert_file({"user_id": user_id, "sha256": f"{user_id[:8]}{crate.sha}"[:64],
                           "original_filename": "record.wav", "storage_path": crate.path,
                           "status": "ready", "report": crate.report})
    if history:
        db.insert_rows("corrections", [
            {"user_id": user_id, "file_id": file["id"], "field": row["field"],
             "predicted": row["predicted"], "corrected": row["corrected"]}
            for row in json.loads(FIXTURE.read_text())["histories"][history]
        ])
    return user_id, file


def rack_for(db: InMemoryDatabase, crate, user_id: str, file: dict, **params) -> tuple[list[dict], dict]:
    """Run the real ``find_loops`` job and return its rack in the order it was written."""
    job = db.insert_job({"user_id": user_id, "file_id": file["id"], "kind": "analyze",
                         "params": {"task": "find_loops", "bars": [1, 2, 4, 8], "top_k": TOP_K, **params}})
    final = run_job(job["id"], db, crate.storage)
    assert final["status"] == "done", final["error"]
    by_id = {r["id"]: r for r in db.select("loops", {"file_id": file["id"], "origin": "finder"})}
    return [by_id[i] for i in final["result"]["loop_ids"]], final["result"]


def bars_of(rack: list[dict]) -> list[int | None]:
    return [r["bars"] for r in rack]


def first_rank_with(rack: list[dict], bars: int) -> int | None:
    """Where the first ``bars``-bar row sits in the rack, or None when there is none."""
    return next((i + 1 for i, r in enumerate(rack) if r["bars"] == bars), None)


# --- the wire -------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def three_accounts(crate):
    """Three accounts, one database, opposite histories, one loop search each."""
    db = InMemoryDatabase()
    long_id, long_file = add_account(db, crate, "drags_out_to_eight")
    cold_id, cold_file = add_account(db, crate, None)
    short_id, short_file = add_account(db, crate, "pulls_in_to_two")

    long_rack, long_result = rack_for(db, crate, long_id, long_file)
    cold_rack, cold_result = rack_for(db, crate, cold_id, cold_file)
    short_rack, short_result = rack_for(db, crate, short_id, short_file)
    return types.SimpleNamespace(
        db=db, crate=crate,
        long_=types.SimpleNamespace(user_id=long_id, file=long_file, rack=long_rack, result=long_result),
        cold=types.SimpleNamespace(user_id=cold_id, file=cold_file, rack=cold_rack, result=cold_result),
        short=types.SimpleNamespace(user_id=short_id, file=short_file, rack=short_rack, result=short_result),
    )


def test_an_account_with_no_corrections_gets_the_measured_rack_and_nothing_written_on_it(three_accounts):
    """Cold start is today's ranking exactly, not a personalization that happens to be zero."""
    cold = three_accounts.cold
    assert len(cold.rack) == TOP_K
    assert all(r["components"] is not None and "personalization" not in r["components"] for r in cold.rack)
    assert cold.result["personalization"]["neutral"] is True
    assert cold.result["personalization"]["n_corrections"] == 0
    assert "No loop corrections yet" in cold.result["personalization"]["why"][0]
    # the record's own four-bar loop is what the measurement puts first (half one of the ranking)
    assert cold.rack[0]["bars"] == three_accounts.crate.loop_period_bars


def test_a_producer_who_keeps_dragging_loops_out_gets_the_long_ones_offered(three_accounts):
    """Fourteen rows written by the web move a length class into the rack it was never in."""
    long_, cold = three_accounts.long_, three_accounts.cold

    assert long_.result["personalization"]["n_corrections"] == 14, "it read someone else's rows, or missed its own"
    assert long_.result["personalization"]["bar_prior_delta"]["8"] > 0
    assert long_.result["personalization"]["bar_prior_delta"]["4"] < 0

    assert first_rank_with(cold.rack, 8) is None, "the measured rack already offered eight bars; nothing to show"
    rank = first_rank_with(long_.rack, 8)
    assert rank is not None, f"eight bars never made the rack: {bars_of(long_.rack)}"
    assert bars_of(long_.rack) != bars_of(cold.rack)


def test_a_producer_who_keeps_pulling_loops_in_gets_the_short_ones_first(three_accounts):
    """The same wire, the other way: two-bar rows climb and four-bar rows give way."""
    short, cold = three_accounts.short, three_accounts.cold

    assert short.result["personalization"]["bar_prior_delta"]["2"] > 0
    assert short.result["personalization"]["bar_prior_delta"]["4"] < 0

    before = first_rank_with(cold.rack, 2)
    after = first_rank_with(short.rack, 2)
    assert before is not None and after is not None
    assert after < before, f"the two-bar rows did not climb: {bars_of(cold.rack)} -> {bars_of(short.rack)}"
    assert sum(1 for r in short.rack[:5] if r["bars"] == 2) > sum(1 for r in cold.rack[:5] if r["bars"] == 2)


def test_the_three_racks_are_three_different_racks(three_accounts):
    """Opposite histories in one database: the only thing that decided each rack was its own account."""
    long_, short, cold = three_accounts.long_, three_accounts.short, three_accounts.cold
    orders = [bars_of(long_.rack), bars_of(cold.rack), bars_of(short.rack)]
    assert len({tuple(o) for o in orders}) == 3, orders

    # each rack is long in the direction its own producer keeps correcting towards
    eights = [sum(1 for b in o if b == 8) for o in orders]
    twos = [sum(1 for b in o if b == 2) for o in orders]
    assert eights[0] > 0 and eights[1] == eights[2] == 0, f"eight bars reached the wrong racks: {eights}"
    assert twos[2] > twos[0] > twos[1], f"two-bar rows reached the wrong racks: {twos}"

    for account, wanted in ((long_, "8 bars"), (short, "2 bars")):
        why = " ".join(account.result["personalization"]["why"])
        assert wanted in why and "your corrections only" in why
        assert str(account.user_id) not in why


def test_every_adjusted_row_says_what_moved_it_and_by_how_much(three_accounts):
    """Nothing measured is overwritten, and the producer can read why a row is where it is."""
    for account in (three_accounts.long_, three_accounts.short):
        for row in account.rack:
            personal = row["components"]["personalization"]
            assert set(personal) >= {"applied", "delta", "score_measured", "reasons", "why", "score_cap"}
            assert abs(personal["delta"]) <= PERSONAL_SCORE_MAX + 1e-9
            assert personal["score_measured"] + personal["delta"] == pytest.approx(row["score"], abs=1e-3)
            assert 0.0 <= row["score"] <= 1.0
            for term in ("seam", "phrase", "stability", "novelty", "onset_lock", "recurrence"):
                assert isinstance(row["components"][term], float)
            if personal["applied"]:
                assert personal["reasons"], "a row that moved has to say why"


# --- refusing it ------------------------------------------------------------------------------------


def test_one_run_can_opt_out_and_lands_on_the_measured_rack_exactly(three_accounts):
    """``params.personalize = false``: the harness's switch, and support's."""
    s = three_accounts
    measured, result = rack_for(s.db, s.crate, s.long_.user_id, s.long_.file, personalize=False)
    assert [(r["start_s"], r["end_s"], r["score"]) for r in measured] == \
           [(r["start_s"], r["end_s"], r["score"]) for r in s.cold.rack]
    assert all("personalization" not in r["components"] for r in measured)
    assert result["personalization"]["enabled"] is False


def test_the_producer_can_turn_it_off_and_get_the_measurement_back(three_accounts):
    """``profiles.loop_personalization = false``: the switch on the account, end to end."""
    s = three_accounts
    s.db.insert_rows("profiles", [{"id": s.long_.user_id, "user_id": s.long_.user_id,
                                   "loop_personalization": False}])
    off, result = rack_for(s.db, s.crate, s.long_.user_id, s.long_.file)

    assert [(r["start_s"], r["end_s"], r["score"]) for r in off] == \
           [(r["start_s"], r["end_s"], r["score"]) for r in s.cold.rack]
    assert all("personalization" not in r["components"] for r in off)
    assert result["personalization"]["enabled"] is False
    assert "off for this account" in result["personalization"]["why"][0]

    s.db.update_rows("profiles", {"id": s.long_.user_id}, {"loop_personalization": True})
    back, _ = rack_for(s.db, s.crate, s.long_.user_id, s.long_.file)
    assert bars_of(back) == bars_of(s.long_.rack), "turning it back on did not restore their ranking"


# --- the fixture is the contract ----------------------------------------------------------------------


def test_the_replayed_rows_are_the_shapes_the_reader_documents():
    """A guard on the fixture itself: the web can only feed this reader what it reads."""
    from lockedgroove.learn.loop_prefs import LOOP_CORRECTION_FIELDS, SCORED_TERMS, learn_loop_preference

    fixture = json.loads(FIXTURE.read_text())
    user = str(uuid.uuid4())
    for name, rows in fixture["histories"].items():
        assert rows, name
        for row in rows:
            assert row["field"] in LOOP_CORRECTION_FIELDS
            if row["field"] == "loop_pick":
                assert set(row["predicted"]) <= {"bars", "rank", "components"}
                assert set(row["predicted"].get("components", {})) <= set(SCORED_TERMS)
            else:
                assert set(row["predicted"]) <= {"start_s", "end_s", "bars"}
        # every row the web wrote is evidence: none of them is skipped as unreadable
        pref = learn_loop_preference(user, [{**r, "user_id": user} for r in rows])
        assert pref.n_corrections == len(rows), f"{name}: the reader threw rows away"
