"""Sample-ready loops: what is and is not playing inside a candidate, per stem.

Principle 8: every claim here is pinned to a synthetic fixture whose
arrangement is known bar by bar (``synth.stem_track``), never to a separation
model's output. The fixture's stems sum exactly to its mix, so it is a
*perfect* separation; the bleed cases add the leakage on purpose.

What these tests can prove: the arithmetic, the thresholds, the near-miss
handling, the withholding, and that the finder is unchanged without stems.
What they cannot prove: that the thresholds are right for a real record
separated by a real model (docs/HANDOFF_sample_ready_loops.md says what would).
"""

from __future__ import annotations

import json
import pathlib
import uuid

import numpy as np
import pytest
import soundfile as sf

from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import sha256_file
from lockedgroove.jobs import run_job
from lockedgroove.loops import finder as F
from lockedgroove.loops import sample_ready as S
from lockedgroove.report import AnalysisReport, Beats, Tempo
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import stem_track

SR = 22050
BPM = 90.0
BARS = 16
BAR_S = 4 * 60.0 / BPM
USER = str(uuid.uuid4())

TRUSTED = S.StemSource(model="separation")


def _energies(stems, mix=None, source=TRUSTED):
    return S.stem_energies(stems, SR, mix=mix, source=source)


def _ready(stems, first_bar, bars, mix=None, source=TRUSTED):
    energies = _energies(stems, mix=mix, source=source)
    return S.sample_ready(energies, first_bar * BAR_S, (first_bar + bars) * BAR_S)


@pytest.fixture(scope="module")
def track():
    """Drums, bass and chords throughout; the singer comes in at bar 9."""
    return stem_track(bpm=BPM, sr=SR, bars=BARS)


def report_from_truth(truth: dict) -> AnalysisReport:
    return AnalysisReport(
        tempo=Tempo(bpm=truth["bpm"], confidence=0.95, method="truth"),
        beats=Beats(times_s=truth["beats_s"], confidence=0.95, method="truth",
                    downbeats_s=truth["downbeats_s"], downbeat_phase=0, downbeat_confidence=0.9,
                    downbeat_method="truth", meter="4/4"),
    )


# --- the fixture itself ---------------------------------------------------------------------------


def test_the_fixture_is_a_perfect_separation_with_a_known_arrangement(track):
    mix, stems, truth = track
    assert sorted(stems) == ["bass", "drums", "other", "vocals"]
    assert np.allclose(mix, sum(stems.values()), atol=1e-6)
    assert truth["vocal_free_bars"] == list(range(8))
    assert all(len(s) == len(mix) for s in stems.values())


# --- presence bands -------------------------------------------------------------------------------


def test_vocal_free_before_the_singer_and_not_after(track):
    mix, stems, _ = track
    before = _ready(stems, 0, 8, mix=mix)
    after = _ready(stems, 8, 8, mix=mix)

    clean = before.claim("vocal_free")
    assert clean.value is True and clean.confidence >= 0.9
    assert before.profile["vocals"].presence == S.PRESENCE_ABSENT
    assert "noise floor" in clean.why

    dirty = after.claim("vocal_free")
    assert dirty.value is False and dirty.confidence >= 0.9
    assert after.profile["vocals"].presence == S.PRESENCE_PRESENT
    assert after.claim("fullness").value == 4


@pytest.mark.parametrize("first_bar,expected", [(0, True), (4, True), (8, False), (12, False)])
def test_every_four_bar_span_is_called_correctly(track, first_bar, expected):
    mix, stems, _ = track
    assert _ready(stems, first_bar, 4, mix=mix).claim("vocal_free").value is expected


def test_a_span_that_straddles_the_entry_is_not_clean(track):
    mix, stems, _ = track
    straddling = _ready(stems, 6, 4, mix=mix)  # bars 7-10: the singer enters halfway through
    assert straddling.claim("vocal_free").value is False


# --- the near miss --------------------------------------------------------------------------------


def test_a_held_note_tailing_off_into_the_span_is_not_clean():
    """The singer stops at bar 8; the last note rings into bar 9. Not a clean loop."""
    mix, stems, _ = stem_track(bpm=BPM, sr=SR, bars=BARS, vocal_release_s=1.2,
                               arrangement={"drums": [(0, BARS)], "bass": [(0, BARS)],
                                            "other": [(0, BARS)], "vocals": [(0, 8)]})
    tail = _ready(stems, 8, 4, mix=mix)
    span = tail.profile["vocals"]
    assert span.presence == S.PRESENCE_FAINT
    claim = tail.claim("vocal_free")
    assert claim.value is False
    assert "quiet but not gone" in claim.why
    assert span.loudest_at_s == pytest.approx(8 * BAR_S, abs=0.5)  # the tail is at the top of the span
    # and the bars after the tail has died away are clean again
    assert _ready(stems, 12, 4, mix=mix).claim("vocal_free").value is True


def test_one_quiet_adlib_is_not_clean_even_where_the_mean_alone_would_pass():
    """A 120 ms background ad-lib in four otherwise empty bars. The mean says
    clean; the loudest 50 ms says otherwise, and the loudest 50 ms is right."""
    mix, stems, _ = stem_track(bpm=BPM, sr=SR, bars=BARS, adlibs=[(2.5, 0.12)], adlib_ms=120.0)
    ready = _ready(stems, 0, 4, mix=mix)
    span = ready.profile["vocals"]

    assert span.rel_mean_db < S.ABSENT_MEAN_REL_DB      # the span mean is at the noise floor
    assert span.rel_peak_db > S.ABSENT_PEAK_REL_DB      # one window is not
    assert span.presence == S.PRESENCE_FAINT
    claim = ready.claim("vocal_free")
    assert claim.value is False
    assert span.loudest_at_s == pytest.approx(2.5 * BAR_S, abs=0.2)
    assert any("quiet vocal is still in here" in r for r in S.reasons(ready))
    # the same four bars without the ad-lib are clean
    clean_mix, clean_stems, _ = stem_track(bpm=BPM, sr=SR, bars=BARS)
    assert _ready(clean_stems, 0, 4, mix=clean_mix).claim("vocal_free").value is True


def test_the_near_miss_is_less_confident_the_quieter_it_gets():
    confidences = []
    for gain in (0.35, 0.12, 0.06):
        mix, stems, _ = stem_track(bpm=BPM, sr=SR, bars=BARS, adlibs=[(2.5, gain)], adlib_ms=120.0)
        claim = _ready(stems, 0, 4, mix=mix).claim("vocal_free")
        assert claim.value is False
        confidences.append(claim.confidence)
    assert confidences == sorted(confidences, reverse=True)


def test_a_loud_hit_just_before_the_span_does_not_count_as_inside_it():
    """The window that would straddle the start is exactly the edge a producer
    is placing, so no frame may reach outside the span."""
    n = int(round(4.0 * SR))
    vocals = np.zeros(n, dtype=np.float32)
    vocals[int(0.95 * SR):int(1.00 * SR)] = 0.8   # one syllable, ending where the loop starts
    bed = 0.2 * np.sin(2 * np.pi * 110 * np.arange(n) / SR).astype(np.float32)
    ready = S.sample_ready(_energies({"vocals": vocals, "other": bed}), 1.0, 3.0)
    assert ready.profile["vocals"].presence == S.PRESENCE_ABSENT
    assert ready.claim("vocal_free").value is True
    # move the start 100 ms earlier and the same syllable is inside the loop
    earlier = S.sample_ready(_energies({"vocals": vocals, "other": bed}), 0.9, 3.0)
    assert earlier.claim("vocal_free").value is False


# --- the other shapes -----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def arranged():
    """Bars 5-8 are the break; bars 9-12 are a lone bass; bars 13-16 are the full band."""
    return stem_track(bpm=BPM, sr=SR, bars=BARS, arrangement={
        "drums": [(0, 8), (12, 16)],
        "bass": [(0, 4), (8, 16)],
        "other": [(0, 4), (12, 16)],
        "vocals": [(12, 16)],
    })


def test_the_break_is_drums_only_and_a_full_band_span_is_not(arranged):
    mix, stems, _ = arranged
    brk = _ready(stems, 4, 4, mix=mix)
    assert brk.claim("drums_only").value is True
    assert brk.claim("drums_only").confidence >= 0.8
    assert brk.claim("fullness").value == 1
    assert brk.claim("vocal_free").value is True
    assert "break" in brk.claim("drums_only").why
    assert any("break" in r for r in S.reasons(brk))

    full = _ready(stems, 12, 4, mix=mix)
    assert full.claim("drums_only").value is False
    assert full.claim("fullness").value == 4


def test_drums_free_spans_are_the_ones_you_lay_your_own_drums_under(arranged):
    mix, stems, _ = arranged
    lone_bass = _ready(stems, 8, 4, mix=mix)
    assert lone_bass.claim("drums_free").value is True
    assert lone_bass.claim("drums_only").value is False
    assert any("lay your own" in r for r in S.reasons(lone_bass))

    assert _ready(stems, 0, 4, mix=mix).claim("drums_free").value is False


def test_a_lone_bass_note_is_not_ranked_as_a_great_find_but_a_break_is(arranged):
    mix, stems, _ = arranged
    assert _ready(stems, 8, 4, mix=mix).ranking_factor == pytest.approx(S.LONE_STEM_FACTOR)
    assert _ready(stems, 4, 4, mix=mix).ranking_factor == pytest.approx(1.0)   # the break
    assert _ready(stems, 12, 4, mix=mix).ranking_factor == pytest.approx(1.0)  # the full band
    assert _ready(stems, 0, 4, mix=mix).ranking_factor == pytest.approx(1.0)


def test_fullness_counts_only_what_is_usable(arranged):
    mix, stems, _ = arranged
    lone = _ready(stems, 8, 4, mix=mix).claim("fullness")
    assert lone.value == 1 and lone.extra["of"] == 4 and lone.extra["stems_present"] == ["bass"]
    assert lone.confidence > 0.0
    assert any("only the bass is playing" in r for r in S.reasons(_ready(stems, 8, 4, mix=mix)))


# --- separation quality ---------------------------------------------------------------------------


def test_bleed_lowers_confidence_without_inventing_a_vocal(track):
    mix, stems, _ = track
    clean = _ready(stems, 0, 4, mix=mix).claim("vocal_free")

    bled = dict(stems)
    bled["vocals"] = (stems["vocals"] + 0.005 * stems["drums"] + 0.004 * stems["other"]).astype(np.float32)
    ready = _ready(bled, 0, 4, mix=mix)
    claim = ready.claim("vocal_free")

    assert claim.value is True                      # still the right answer
    assert claim.confidence < clean.confidence      # ...believed less
    assert ready.profile["vocals"].isolation_db < 60.0
    assert S.SEPARATION_CAVEAT in ready.caveats


def test_heavy_bleed_is_a_cant_tell_not_a_clean_loop_and_not_a_confident_no(track):
    """A leaked snare and a quiet vocal look the same on a level meter. The
    claim stays conservative (not clean) and says it is a coin flip."""
    mix, stems, _ = track
    bled = dict(stems)
    bled["vocals"] = (stems["vocals"] + 0.03 * stems["drums"]).astype(np.float32)
    ready = _ready(bled, 0, 4, mix=mix)
    claim = ready.claim("vocal_free")
    span = ready.profile["vocals"]

    assert claim.value is False                     # never "clean" off a smeared stem
    assert span.leakage_suspected and span.leaks_from == "drums"
    assert span.leakage_correlation > S.LEAKAGE_CORRELATION
    assert claim.confidence == pytest.approx(S.LEAKAGE_CONF_CAP)
    assert "leakage" in claim.why
    assert any("as likely to be leakage" in c for c in ready.caveats)


def test_a_real_quiet_vocal_is_not_dismissed_as_leakage():
    """The ad-lib does not follow the drums, so it is not written off as bleed."""
    mix, stems, _ = stem_track(bpm=BPM, sr=SR, bars=BARS, adlibs=[(2.5, 0.12)], adlib_ms=120.0)
    ready = _ready(stems, 0, 4, mix=mix)
    span = ready.profile["vocals"]
    assert span.presence == S.PRESENCE_FAINT
    assert not span.leakage_suspected
    assert ready.claim("vocal_free").confidence > S.LEAKAGE_CONF_CAP


def test_sustained_bleed_shows_up_as_a_stem_that_never_goes_quiet(track):
    mix, stems, _ = track
    bled = dict(stems)
    bled["vocals"] = (stems["vocals"] + 0.02 * stems["other"]).astype(np.float32)
    ready = _ready(bled, 0, 4, mix=mix)
    assert ready.profile["vocals"].isolation_db < S.ISOLATION_GOOD_DB
    assert any("weakly evidenced" in c for c in ready.caveats)
    assert ready.claim("vocal_free").confidence < _ready(stems, 0, 4, mix=mix).claim(
        "vocal_free").confidence


def test_separation_quality_is_monotonic_in_isolation():
    assert S.separation_quality(S.ISOLATION_POOR_DB - 10) == 0.0
    assert S.separation_quality(S.ISOLATION_GOOD_DB + 10) == 1.0
    assert 0.0 < S.separation_quality(40.0) < 1.0
    assert S.quality_factor(0.0) == pytest.approx(S.TRUST_FLOOR)
    assert S.quality_factor(999.0) == pytest.approx(1.0)


# --- withholding ----------------------------------------------------------------------------------


def test_stand_in_stems_withhold_every_claim(track):
    mix, stems, _ = track
    source = S.StemSource.from_model("bandsplit" + S.FAKE_MODEL_SUFFIX)
    assert source.trusted is False
    ready = _ready(stems, 0, 4, mix=mix, source=source)

    for name in S.CLAIM_NAMES:
        claim = ready.claim(name)
        assert claim.value is None and claim.confidence == 0.0
        assert claim.withheld and "stand-in" in claim.withheld
    assert S.STANDIN_CAVEAT in ready.caveats
    assert ready.ranking_factor == 1.0
    assert ready.profile["vocals"].presence in (S.PRESENCE_ABSENT, S.PRESENCE_FAINT, S.PRESENCE_PRESENT)
    assert S.holds(ready.to_dict(), "vocal_free") is False  # withheld never matches a query
    assert "stand-in" in S.reasons(ready)[0]


def test_a_real_model_label_is_trusted():
    assert S.StemSource.from_model("some-separator").trusted is True
    assert S.StemSource.from_model(None).trusted is True


@pytest.mark.parametrize("name", ["backing", "no_vocals", "vocals_removed", "instrumental"])
def test_a_stem_named_for_what_was_taken_out_of_it_is_not_that_stem(track, name):
    """"no_vocals" is the instrumental; answering the vocal question from it
    would invert the answer."""
    mix, stems, _ = track
    rest = {name: stems["drums"] + stems["bass"] + stems["other"]}
    ready = S.sample_ready(_energies(rest, mix=mix), 0.0, 4 * BAR_S)
    assert ready.claim("vocal_free").withheld


def test_a_separation_without_a_vocal_stem_withholds_only_that_claim(track):
    mix, stems, _ = track
    two_stem = {"backing": stems["drums"] + stems["bass"] + stems["other"]}
    ready = S.sample_ready(_energies(two_stem, mix=mix), 0.0, 4 * BAR_S)
    assert ready.claim("vocal_free").withheld
    assert ready.claim("drums_free").withheld
    assert ready.claim("fullness").value == 1


def test_a_vocals_plus_instrumental_separation_still_answers_the_vocal_question(track):
    mix, stems, _ = track
    two = {"vocals": stems["vocals"], "instrumental": stems["drums"] + stems["bass"] + stems["other"]}
    ready = S.sample_ready(_energies(two, mix=mix), 0.0, 4 * BAR_S)
    assert ready.claim("vocal_free").value is True
    assert ready.claim("drums_free").withheld and ready.claim("drums_only").withheld


def test_no_stems_at_all_is_nothing_to_measure():
    assert S.stem_energies({}, SR) is None
    assert S.stem_energies({"vocals": np.zeros(0, dtype=np.float32)}, SR) is None


# --- the shape of what gets stored ------------------------------------------------------------------


def test_every_claim_carries_a_value_a_confidence_and_a_reason_and_is_json_safe(track):
    mix, stems, _ = track
    stored = _ready(stems, 0, 4, mix=mix).to_dict()
    json.dumps(stored)  # it goes into the jsonb column

    assert set(stored) == {"source", "claims", "profile", "caveats", "ranking_factor", "reasons"}
    assert set(stored["claims"]) == set(S.CLAIM_NAMES)
    for claim in stored["claims"].values():
        assert set(claim) >= {"value", "confidence", "why"}
        assert 0.0 <= claim["confidence"] <= 1.0
        assert isinstance(claim["why"], str) and claim["why"]
    for span in stored["profile"].values():
        assert span["presence"] in (S.PRESENCE_ABSENT, S.PRESENCE_FAINT, S.PRESENCE_PRESENT)
        assert span["mean_db"] <= 0.0 and span["peak_db"] >= span["mean_db"] - 1e-6
    assert stored["source"]["trusted"] is True
    assert stored["caveats"]


def test_a_stem_shorter_than_the_span_counts_as_silence_where_it_stops():
    short = np.concatenate([np.full(SR, 0.3, dtype=np.float32)])
    ready = S.sample_ready(_energies({"vocals": short, "drums": np.tile(short, 4)}), 0.0, 4.0)
    assert ready.profile["vocals"].mean_db < ready.profile["drums"].mean_db - 5.0


# --- the finder ------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def finder_runs(track):
    mix, stems, truth = track
    report = report_from_truth(truth)
    without = F.find_loops(mix, SR, report, bars=(4,), top_k=None)
    with_stems = F.find_loops(mix, SR, report, bars=(4,), top_k=None, stems=stems,
                              stem_source=TRUSTED)
    return without, with_stems


def test_stems_do_not_change_a_single_loop_score(finder_runs):
    """Same span, same score, bit for bit, with stems or without."""
    without, with_stems = finder_runs
    assert without
    by_start = {round(c.start_s, 6): c for c in with_stems}
    for c in without:
        other = by_start[round(c.start_s, 6)]
        assert other.score == c.score
        assert other.bars == c.bars and other.end_s == c.end_s
        for key in ("seam", "seam_mel", "seam_rms", "seam_raw", "seam_wrap", "stability", "novelty",
                    "onset_lock", "onset_distance_ms", "interior_boundaries", "grid", "bar_index",
                    "weights", "extrapolated_end"):
            assert other.components[key] == c.components[key]
        assert "sample_ready" not in c.components          # nothing added when there are no stems


def test_a_repeat_with_the_singer_over_it_is_its_own_loop(finder_runs):
    """Without stems the second half folds onto the first as "the same loop".
    It is the same chords, and it is not the same find."""
    without, with_stems = finder_runs
    assert len(with_stems) > len(without)
    bars_with = {round(c.start_s / BAR_S) for c in with_stems}
    assert {0, 8} <= bars_with
    assert 8 not in {round(c.start_s / BAR_S) for c in without}


def test_the_finder_marks_the_vocal_free_loops(finder_runs, track):
    _, with_stems = finder_runs
    _, _, truth = track
    for c in with_stems:
        block = c.components["sample_ready"]
        assert set(block["claims"]) == set(S.CLAIM_NAMES)
        entered = c.start_s + c.duration_s > 8 * BAR_S - 1e-6
        assert block["claims"]["vocal_free"]["value"] is (not entered)
    assert any(S.holds(c, "vocal_free") for c in with_stems)


def test_show_me_the_vocal_free_four_bar_loops(finder_runs):
    _, with_stems = finder_runs
    vocal_free = S.filter_loops(with_stems, vocal_free=True, bars=4)
    assert vocal_free and all(c.start_s + c.duration_s <= 8 * BAR_S + 1e-6 for c in vocal_free)
    assert len(vocal_free) < len(with_stems)
    assert S.filter_loops(with_stems, bars=8) == []
    assert S.filter_loops(with_stems, drums_only=True) == []
    assert len(S.filter_loops(with_stems, min_stems=3)) >= len(vocal_free)

    ranked = S.sort_loops(with_stems, prefer=("vocal_free",))
    assert ranked[0] in vocal_free
    assert [c for c in ranked if S.holds(c, "vocal_free")] == ranked[:len(vocal_free)]
    scores = [c.score for c in ranked[:len(vocal_free)]]
    assert scores == sorted(scores, reverse=True)


def test_filters_never_answer_with_loops_nobody_measured(finder_runs):
    without, _ = finder_runs
    assert S.filter_loops(without, vocal_free=True) == []
    assert S.claim_of(without[0], "vocal_free") is None
    assert S.holds(without[0], "vocal_free") is False


def test_the_finder_orders_by_score_times_the_ranking_factor(arranged):
    mix, stems, truth = arranged
    report = report_from_truth(truth)
    ranked = F.find_loops(mix, SR, report, bars=(4,), top_k=None, stems=stems, stem_source=TRUSTED)
    keys = [c.score * c.components["sample_ready"]["ranking_factor"] for c in ranked]
    assert keys == sorted(keys, reverse=True)
    factors = {round(c.start_s / BAR_S): c.components["sample_ready"]["ranking_factor"] for c in ranked}
    assert factors[8] == pytest.approx(S.LONE_STEM_FACTOR)   # bars 9-12: the lone bass
    assert factors[4] == pytest.approx(1.0)                  # bars 5-8: the break


def test_stand_in_stems_reach_the_candidates_as_withheld_claims(track):
    mix, stems, truth = track
    ranked = F.find_loops(mix, SR, report_from_truth(truth), bars=(4,), top_k=3, stems=stems,
                          stem_source=S.StemSource.from_model("x" + S.FAKE_MODEL_SUFFIX))
    assert ranked
    for c in ranked:
        block = c.components["sample_ready"]
        assert block["source"]["trusted"] is False
        assert all(claim["value"] is None for claim in block["claims"].values())
    assert S.filter_loops(ranked, vocal_free=True) == []


def test_the_finder_ignores_stems_it_cannot_use(track):
    mix, stems, truth = track
    report = report_from_truth(truth)
    plain = F.find_loops(mix, SR, report, bars=(4,), top_k=3)
    empty = F.find_loops(mix, SR, report, bars=(4,), top_k=3, stems={})
    assert [c.score for c in empty] == [c.score for c in plain]
    assert all("sample_ready" not in c.components for c in empty)


# --- the job path ------------------------------------------------------------------------------------


def _library(tmp_path, model: str, stems: dict, mix: np.ndarray, truth: dict):
    """A mix file with its report, its stem files and its ``stems`` rows."""
    storage = LocalStorage(tmp_path / "bucket")
    db = InMemoryDatabase()
    wav = tmp_path / "record.wav"
    sf.write(wav, mix, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    path = f"library/{USER}/{sha[:2]}/{sha}.wav"
    storage.upload(path, str(wav))
    file = db.insert_file({"user_id": USER, "sha256": sha, "original_filename": "record.wav",
                           "storage_path": path, "status": "ready"})
    db.update_file(file["id"], {"report": report_from_truth(truth).to_json_dict(),
                                "duration_s": len(mix) / SR, "sample_rate": SR, "channels": 1})
    for name, y in stems.items():
        stem_wav = tmp_path / f"{name}.wav"
        sf.write(stem_wav, y, SR, subtype="PCM_16")
        stem_path = f"derived/{USER}/{file['id']}/stems/{model}/{name}.wav"
        storage.upload(stem_path, str(stem_wav))
        stem_file = db.insert_file({"user_id": USER, "sha256": sha256_file(str(stem_wav)),
                                    "original_filename": f"record_{name}.wav", "storage_path": stem_path,
                                    "kind": "stem", "parent_file_id": file["id"], "status": "ready"})
        db.insert_rows("stems", [{"user_id": USER, "file_id": file["id"], "stem": name,
                                  "model": model, "stem_file_id": stem_file["id"]}])
    return db, storage, db.get_file(file["id"])


def _find_loops_job(db, file, **params):
    params = {"task": "find_loops", "bars": [4], "top_k": 6, **params}
    return db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze", "params": params})


def test_the_job_picks_up_the_stems_and_writes_the_flags_on_the_rows(tmp_path, track):
    mix, stems, truth = track
    db, storage, file = _library(tmp_path, "separation", stems, mix, truth)

    final = run_job(_find_loops_job(db, file)["id"], db, storage)

    assert final["status"] == "done", final["error"]
    result = final["result"]
    assert result["stems_used"] == ["bass", "drums", "other", "vocals"]
    assert result["stem_model"] == "separation" and result["stems_trusted"] is True
    assert result["sample_ready_counts"]["vocal_free"] > 0
    assert result["sample_ready_counts"]["drums_only"] == 0

    rows = db.select("loops", {"file_id": file["id"], "origin": "finder"})
    assert rows and len(rows) == result["count"]
    for row in rows:
        block = row["components"]["sample_ready"]
        assert set(block["claims"]) == set(S.CLAIM_NAMES)
        assert block["source"]["model"] == "separation"
        json.dumps(row["components"])
    vocal_free = S.filter_loops(rows, vocal_free=True, bars=4)
    assert vocal_free and all(r["start_s"] + 4 * BAR_S <= 8 * BAR_S + 1e-6 for r in vocal_free)
    assert any("no vocal in this span" in r["components"]["reasons"] for r in vocal_free)


def test_the_job_withholds_claims_when_the_stems_are_the_stand_in(tmp_path, track):
    mix, stems, truth = track
    db, storage, file = _library(tmp_path, "bandsplit" + S.FAKE_MODEL_SUFFIX, stems, mix, truth)

    final = run_job(_find_loops_job(db, file)["id"], db, storage)

    assert final["status"] == "done", final["error"]
    assert final["result"]["stems_trusted"] is False
    assert final["result"]["sample_ready_counts"] == {"vocal_free": 0, "drums_free": 0, "drums_only": 0}
    rows = db.select("loops", {"file_id": file["id"], "origin": "finder"})
    assert rows
    for row in rows:
        claims = row["components"]["sample_ready"]["claims"]
        assert all(c["value"] is None and c["withheld"] for c in claims.values())
    assert S.filter_loops(rows, vocal_free=True) == []


def test_the_job_without_stems_writes_exactly_what_it_used_to(tmp_path, track):
    mix, stems, truth = track
    db, storage, file = _library(tmp_path, "separation", {}, mix, truth)

    final = run_job(_find_loops_job(db, file)["id"], db, storage)

    assert final["status"] == "done", final["error"]
    assert final["result"]["stems_used"] == []
    assert "sample_ready_counts" not in final["result"]
    rows = db.select("loops", {"file_id": file["id"], "origin": "finder"})
    assert rows and all("sample_ready" not in r["components"] for r in rows)


def test_use_stems_false_skips_the_stem_load(tmp_path, track):
    mix, stems, truth = track
    db, storage, file = _library(tmp_path, "separation", stems, mix, truth)

    final = run_job(_find_loops_job(db, file, use_stems=False)["id"], db, storage)

    assert final["status"] == "done", final["error"]
    assert final["result"]["stems_used"] == []
    rows = db.select("loops", {"file_id": file["id"], "origin": "finder"})
    assert rows and all("sample_ready" not in r["components"] for r in rows)


def test_a_broken_stem_row_costs_the_claims_not_the_loops(tmp_path, track):
    mix, stems, truth = track
    db, storage, file = _library(tmp_path, "separation", stems, mix, truth)
    for row in db.select("stems", {"file_id": file["id"]}):
        db.update_rows("stems", {"id": row["id"]}, {"stem_file_id": str(uuid.uuid4())})

    final = run_job(_find_loops_job(db, file)["id"], db, storage)

    assert final["status"] == "done", final["error"]
    assert final["result"]["stems_used"] == []
    assert final["result"]["count"] > 0


# --- where the stems came from ----------------------------------------------------------------
#
# Trust used to be inferred from the model *name*: anything not ending in
# `-fake` was fully trusted, so a claim off `kuielab_other` -- the separator that
# cost 17.6 dB of 8-20 kHz on a real upload -- read exactly like one off
# BS-Roformer. The `stems` row has carried the tier and a confidence since
# 20260913000800; these tests hold the reader to them.


def _stem_row(model, **cols):
    return {"model": model, "is_stand_in": False, **cols}


def test_a_row_from_before_the_quality_columns_behaves_as_it_always_did():
    """No `model_tier` key at all means the database predates the migration."""
    src = S.StemSource.from_row({"model": "htdemucs_ft"})
    assert src.trusted is True
    assert src.confidence == 1.0
    assert src.tier is None


def test_a_null_tier_is_unknown_and_unknown_is_not_fine():
    """The column exists and this row was written without one. The migration says untrusted."""
    src = S.StemSource.from_row(_stem_row("htdemucs_ft", model_tier=None))
    assert src.trusted is False
    assert "unknown" in (src.note or "")


@pytest.mark.parametrize("tier,trusted", [("reference", True), ("strong", True),
                                          ("baseline", False), ("weak", False), ("stand_in", False)])
def test_only_the_top_two_tiers_may_carry_a_claim(tier, trusted):
    """The same pair as `stems_trustworthy_idx` in the migration."""
    assert S.StemSource.from_row(_stem_row("m", model_tier=tier)).trusted is trusted


def test_a_weak_separation_says_which_tier_it_was_rather_than_calling_itself_a_stand_in():
    src = S.StemSource.from_row(_stem_row("kuielab_other", model_tier="weak"))
    assert "weak" in (src.note or "")
    assert src.tier == "weak"


def test_the_stand_in_is_caught_by_the_column_and_by_the_name():
    by_column = S.StemSource.from_row({"model": "htdemucs_ft", "is_stand_in": True, "model_tier": "strong"})
    by_name = S.StemSource.from_row({"model": "htdemucs_ft-fake", "is_stand_in": False, "model_tier": "strong"})
    for src in (by_column, by_name):
        assert src.trusted is False
        assert src.tier == "stand_in"


def test_a_set_of_stems_is_only_as_good_as_its_worst_separation():
    src = S.StemSource.from_rows([
        _stem_row("bs_roformer", model_tier="reference", quality_confidence=0.9),
        _stem_row("kuielab_other", model_tier="weak", quality_confidence=0.35),
    ])
    assert src.trusted is False
    assert src.confidence == pytest.approx(0.35)
    assert src.model == "bs_roformer, kuielab_other"


def test_a_set_of_good_stems_stays_trusted_and_takes_the_lower_ceiling():
    src = S.StemSource.from_rows([
        _stem_row("bs_roformer", model_tier="reference", quality_confidence=0.9),
        _stem_row("htdemucs_ft", model_tier="strong", quality_confidence=0.75),
    ])
    assert src.trusted is True
    assert src.confidence == pytest.approx(0.75)


def test_no_stems_at_all_is_not_an_error():
    assert S.StemSource.from_rows([]).model is None


# --- what the tier does to a claim ------------------------------------------------------------


def _source_at(tier, confidence):
    return S.StemSource.from_row(_stem_row("m", model_tier=tier, quality_confidence=confidence))


def test_a_claim_is_never_more_certain_than_the_separation_under_it(track):
    """The whole rule, in one assertion."""
    _mix, stems, _truth = track
    reference = _ready(stems, 0, 4, source=_source_at("reference", 0.9))
    strong = _ready(stems, 0, 4, source=_source_at("strong", 0.75))
    vocal_ref = reference.claim("vocal_free")
    vocal_strong = strong.claim("vocal_free")
    assert vocal_ref.value is vocal_strong.value, "the same span is the same span"
    assert vocal_ref.confidence <= 0.9
    assert vocal_strong.confidence <= 0.75


def test_the_ceiling_only_lowers_a_confidence_that_was_above_it(track):
    """A claim the measurement already hedged is not lifted by a good separator."""
    _mix, stems, _truth = track
    hedged = _ready(stems, 1, 4, source=_source_at("reference", 0.9))
    for name in S.CLAIM_NAMES:
        claim = hedged.claim(name)
        if claim.confidence is not None:
            assert claim.confidence <= 0.9


def test_a_weak_separation_withholds_every_claim_and_says_why(track):
    _mix, stems, _truth = track
    ready = _ready(stems, 0, 4, source=S.StemSource.from_row(_stem_row("kuielab_other", model_tier="weak")))
    for name in S.CLAIM_NAMES:
        assert ready.claim(name).value is None
    assert any("weak" in c for c in ready.caveats)
    # and it does not call a real separator a development stand-in
    assert not any("stand-in" in c for c in ready.caveats)


def test_a_weak_separation_makes_no_content_adjustment_to_the_ranking(track):
    _mix, stems, _truth = track
    weak = _ready(stems, 0, 4, source=S.StemSource.from_row(_stem_row("kuielab_other", model_tier="weak")))
    assert weak.ranking_factor == 1.0


def test_the_source_travels_with_the_loop_so_the_web_can_show_it(track):
    _mix, stems, _truth = track
    ready = _ready(stems, 0, 4, source=_source_at("strong", 0.75))
    d = ready.source.to_dict()
    assert d["tier"] == "strong"
    assert d["confidence"] == pytest.approx(0.75)
    assert json.dumps(d)


# --- the shape the web reads ------------------------------------------------------------------
#
# `web/lib/report/sampleReady.ts` parses `loops.components.sample_ready`. A
# hand-written fixture on that side would be the web's *idea* of this shape, and
# an idea drifts -- which is how the separator registry ended up three models
# deep out of six. So the blocks the web tests against are generated here, from
# the same fixture audio and the same code path that writes them in production,
# and this test fails when the committed file no longer matches.

WEB_FIXTURE = (
    pathlib.Path(__file__).resolve().parents[2] / "web" / "lib" / "report" / "sampleReadyFixture.json"
)


def _web_fixture_blocks(track):
    """One block per case the web has to render differently."""
    _mix, stems, _truth = track
    strong = S.StemSource.from_row(_stem_row("htdemucs_ft", model_tier="strong", quality_confidence=0.75))
    weak = S.StemSource.from_row(_stem_row("kuielab_other", model_tier="weak", quality_confidence=0.35))
    stand_in = S.StemSource.from_row({"model": "htdemucs_ft-fake", "is_stand_in": True})
    return {
        "_generated_by": "analysis/tests/test_loops_sample_ready.py::test_the_web_fixture_is_current",
        "vocal_free_span": _ready(stems, 0, 4, source=strong).to_dict(),
        "vocal_over_it_span": _ready(stems, 9, 4, source=strong).to_dict(),
        "weak_separation": _ready(stems, 0, 4, source=weak).to_dict(),
        "stand_in": _ready(stems, 0, 4, source=stand_in).to_dict(),
    }


def test_the_web_fixture_is_current(track):
    blocks = _web_fixture_blocks(track)
    rendered = json.dumps(blocks, indent=2, sort_keys=True) + "\n"
    if WEB_FIXTURE.read_text() != rendered:
        WEB_FIXTURE.write_text(rendered)
        pytest.fail(f"{WEB_FIXTURE.name} was stale and has been rewritten; commit it and re-run")


def test_the_generated_blocks_cover_what_the_web_branches_on(track):
    blocks = _web_fixture_blocks(track)
    assert blocks["vocal_free_span"]["claims"]["vocal_free"]["value"] is True
    assert blocks["vocal_over_it_span"]["claims"]["vocal_free"]["value"] is False
    assert blocks["weak_separation"]["source"]["trusted"] is False
    weak_chips = blocks["weak_separation"]["reasons"]
    assert weak_chips == ["stems came from a weak-tier separator: no claim about this span"]
    assert "stand-in" not in weak_chips[0], "a real separator is not a development stand-in"
    assert blocks["stand_in"]["source"]["tier"] == "stand_in"
    for name, block in blocks.items():
        if name.startswith("_"):
            continue
        assert isinstance(block["reasons"], list)
        assert isinstance(block["caveats"], list) and block["caveats"]
