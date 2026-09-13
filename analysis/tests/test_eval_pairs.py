"""Sample pairs: reading a hand-written manifest, scoring a flip, and the whole path on synthetic audio.

The dataset under test is the one that answers the product's question -- point
the loop finder at an original record, does it surface the section the producer
used -- so these tests care about two things: that a pair carrying almost
nothing still loads and still scores what it can, and that the six pair metrics
mean exactly what ``docs/HANDOFF_sample_pairs.md`` says they mean.
"""

from __future__ import annotations

import json
import pathlib
import sys

import numpy as np
import pytest

from lockedgroove.eval import harness as H
from lockedgroove.eval import pairs as P
from lockedgroove.eval.metrics import (
    ALL_METRICS,
    FLIP_IOU_THRESHOLD,
    FLIP_TOP_K,
    METRICS,
    PAIR_METRICS,
    Prediction,
    covered_seconds,
    is_pair_truth,
    score_item,
    score_pair,
    span_iou,
)

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import eval_accuracy  # noqa: E402

SR = 22050


# --------------------------------------------------------------------------
# reading what a human wrote
# --------------------------------------------------------------------------

@pytest.mark.parametrize("raw, want", [
    (64, 64.0), (64.5, 64.5), ("64", 64.0), ("64.5s", 64.5),
    ("1:04", 64.0), ("01:04.5", 64.5), ("1:02:03", 3723.0), ("0:00", 0.0),
    (None, None), ("", None), ("soon", None), ("1:2:3:4", None), (True, None),
])
def test_parse_timestamp_forms(raw, want):
    assert P.parse_timestamp(raw) == want


def test_parse_flip_accepts_every_shape_a_producer_would_write():
    # a span, however it is spelled
    for value in ("1:04-1:12", "1:04 to 1:12", "1:04–1:12", [64, 72], (64.0, 72.0),
                  {"from": "1:04", "to": "1:12"}, {"start": 64, "end": 72},
                  {"at": "1:04", "length_s": 8}):
        span, mark, notes = P.parse_flip(value)
        assert span == (64.0, 72.0), value
        assert mark == 64.0 and not notes

    # bars become a span only with the owner's own BPM: 4 bars at 120 BPM is 8 s
    span, mark, notes = P.parse_flip({"at": 64, "bars": 4, "source_bpm": 120})
    assert span == (64.0, 72.0) and not notes

    # ...and without it, the bars are recorded and no span is invented
    span, mark, notes = P.parse_flip({"at": 64, "bars": 4})
    assert span is None and mark == 64.0
    assert notes and "source_bpm" in notes[0]


def test_parse_flip_degrades_instead_of_raising():
    assert P.parse_flip("1:04") == (None, 64.0, [])
    assert P.parse_flip(64) == (None, 64.0, [])
    span, mark, notes = P.parse_flip({"from": 72, "to": 64})
    assert span is None and mark == 72.0 and notes
    span, mark, notes = P.parse_flip("somewhere in the intro")
    assert span is None and mark is None and notes
    assert P.parse_flip(None) == (None, None, [])


@pytest.mark.parametrize("raw, want", [
    (2, 2.0), ("+2", 2.0), ("-5", -5.0), ("2 st", 2.0), ("+3 semitones", 3.0),
    ("x1.08", 1.08), ("×1.08", 1.08), ("108%", 1.08), ("down 2", -2.0),
    (None, None), ("a bit", None),
])
def test_parse_number_forms(raw, want):
    assert P.parse_number(raw) == want


def test_pair_truth_full_entry_carries_every_field():
    truth, notes = P.pair_truth({
        "id": "pair01", "original": "a.wav", "song": "b.wav",
        "flip": {"from": "1:04", "to": "1:12"},
        "tempo_ratio": 1.08, "pitch_semitones": "+2",
        "original_bpm": 93, "original_key": "Bbm", "filtered": "low-passed",
    })
    assert not notes
    assert truth["kind"] == "sample_pair"
    assert truth["flip_span_s"] == [64.0, 72.0] and truth["flip_mark_s"] == 64.0
    assert truth["tempo_ratio"] == pytest.approx(1.08)
    assert truth["pitch_semitones"] == pytest.approx(2.0)
    # the owner's own knowledge of the record is annotation like any other
    assert truth["bpm"] == pytest.approx(93.0)
    assert truth["key"] == {"tonic": "A#", "mode": "minor"}
    assert P.scorable(truth) and is_pair_truth(truth)


def test_pair_truth_from_almost_nothing_still_scores_something():
    truth, notes = P.pair_truth({"id": "pair02", "original": "a.wav", "flip": "1:04"})
    assert truth["flip_mark_s"] == 64.0 and "flip_span_s" not in truth
    assert truth["mark_tolerance_s"] == pytest.approx(P.MARK_TOLERANCE_S)
    assert P.scorable(truth)
    # a tempo ratio can come from the two BPMs instead
    truth, _ = P.pair_truth({"original": "a.wav", "flip": "1:04", "original_bpm": 90, "song_bpm": 99})
    assert truth["tempo_ratio"] == pytest.approx(1.1)
    # nothing at all is not scorable, and says so rather than raising
    truth, notes = P.pair_truth({"original": "a.wav"})
    assert not P.scorable(truth)


def test_pair_truth_notes_bad_fields_without_dropping_the_pair():
    truth, notes = P.pair_truth({"original": "a.wav", "flip": "1:04", "original_key": "H dorian",
                                 "tempo_ratio": -1})
    assert truth["flip_mark_s"] == 64.0
    assert "key" not in truth and "tempo_ratio" not in truth
    assert len(notes) == 2


# --------------------------------------------------------------------------
# overlap
# --------------------------------------------------------------------------

def test_span_iou_worked_cases_behind_the_threshold():
    flip = (10.0, 20.0)
    assert span_iou(flip, flip) == pytest.approx(1.0)
    # a candidate containing the flip but twice as long: exactly the threshold
    assert span_iou((10.0, 30.0), flip) == pytest.approx(0.5)
    # half the length, inside it: also exactly the threshold
    assert span_iou((10.0, 15.0), flip) == pytest.approx(0.5)
    # a four-bar candidate one bar early: over the threshold
    assert span_iou((7.5, 17.5), flip) == pytest.approx(0.6)
    # the same length, half of it elsewhere: under it
    assert span_iou((15.0, 25.0), flip) == pytest.approx(1 / 3)
    # next door, and inside out
    assert span_iou((20.0, 30.0), flip) == 0.0
    assert span_iou((0.0, 5.0), flip) == 0.0
    assert FLIP_IOU_THRESHOLD == 0.5


def test_covered_seconds_counts_overlaps_once():
    assert covered_seconds([(0.0, 4.0), (2.0, 6.0), (10.0, 12.0)]) == pytest.approx(8.0)
    assert covered_seconds([]) == 0.0


# --------------------------------------------------------------------------
# the six pair metrics, on fabricated candidate lists
# --------------------------------------------------------------------------

def _truth(**over):
    truth = {"kind": "sample_pair", "flip_span_s": [10.0, 20.0], "flip_mark_s": 10.0,
             "mark_tolerance_s": 1.0, "tempo_ratio": 1.08, "pitch_semitones": 2.0}
    truth.update(over)
    return truth


def _pred(loops, **over):
    pred = Prediction(loops=list(loops), tempo_ratio=1.08, pitch_semitones=2.0,
                      transform={"original_bpm": 93.0, "song_bpm": 100.4})
    for k, v in over.items():
        setattr(pred, k, v)
    return pred


def test_flip_found_at_rank_one_is_a_hit_everywhere():
    scores = score_pair(_pred([(10.0, 20.0), (0.0, 10.0)]), _truth())
    assert scores["flip_top1"].value == 1.0
    assert scores["flip_topk"].value == 1.0
    assert scores["flip_mrr"].value == pytest.approx(1.0)
    assert scores["flip_mark"].value == 1.0
    assert scores["flip_top1"].detail["best_iou"] == pytest.approx(1.0)


def test_flip_found_further_down_the_rack_is_lenient_only():
    loops = [(0.0, 2.5), (2.5, 5.0), (5.0, 7.5), (10.0, 20.0)]
    scores = score_pair(_pred(loops), _truth())
    assert scores["flip_top1"].value == 0.0 and "rank 4" in scores["flip_top1"].reason
    assert scores["flip_topk"].value == 1.0
    assert scores["flip_mrr"].value == pytest.approx(0.25)
    assert scores["flip_mrr"].detail["first_match_rank"] == 4


def test_flip_outside_the_rack_misses_leniently_too():
    loops = [(0.0, 2.5)] * FLIP_TOP_K + [(10.0, 20.0)]
    scores = score_pair(_pred(loops), _truth())
    assert scores["flip_topk"].value == 0.0
    assert scores["flip_topk"].detail["first_match_rank"] == FLIP_TOP_K + 1
    assert scores["flip_mrr"].value == pytest.approx(1 / (FLIP_TOP_K + 1))
    # the candidate that never overlaps enough is reported as not found, with the best it managed
    scores = score_pair(_pred([(15.0, 25.0)]), _truth())
    assert scores["flip_topk"].value == 0.0 and "not in the top 1" in scores["flip_topk"].reason
    assert scores["flip_topk"].detail["best_iou"] == pytest.approx(1 / 3, abs=1e-3)


def test_no_candidates_is_a_miss_with_the_finder_s_reason():
    pred = _pred([], errors={"loops": "ValueError: no beat grid"})
    scores = score_pair(pred, _truth())
    for m in ("flip_top1", "flip_topk", "flip_mrr", "flip_mark"):
        assert scores[m].applicable and scores[m].value == 0.0
        assert "no beat grid" in scores[m].reason


def test_a_pair_with_only_a_timestamp_scores_only_the_mark():
    truth = {"kind": "sample_pair", "flip_mark_s": 64.0, "mark_tolerance_s": 1.0}
    scores = score_pair(_pred([(60.0, 66.0)]), truth)
    for m in ("flip_top1", "flip_topk", "flip_mrr", "tempo_ratio", "pitch_shift"):
        assert not scores[m].applicable, m
    assert scores["flip_mark"].applicable and scores["flip_mark"].value == 1.0
    assert scores["flip_mark"].detail["covered_s"] == pytest.approx(6.0)


def test_the_mark_tolerance_is_the_owner_s_slack_not_ours():
    truth = {"kind": "sample_pair", "flip_mark_s": 64.0, "mark_tolerance_s": 1.0}
    assert score_pair(_pred([(65.5, 70.0)]), truth)["flip_mark"].value == 0.0
    truth["mark_tolerance_s"] = 3.0
    assert score_pair(_pred([(65.5, 70.0)]), truth)["flip_mark"].value == 1.0
    # covered deeper than the rack is still a miss, and says where it was covered
    truth["mark_tolerance_s"] = 1.0
    loops = [(0.0, 1.0)] * FLIP_TOP_K + [(60.0, 70.0)]
    result = score_pair(_pred(loops), truth)["flip_mark"]
    assert result.value == 0.0 and "rank 11" in result.reason


def test_tempo_ratio_tolerance_and_the_octave_reason():
    scores = score_pair(_pred([(10.0, 20.0)], tempo_ratio=1.0955), _truth())  # +1.4 %
    assert scores["tempo_ratio"].value == 1.0
    scores = score_pair(_pred([(10.0, 20.0)], tempo_ratio=1.2), _truth())     # +11 %
    assert scores["tempo_ratio"].value == 0.0 and "%" in scores["tempo_ratio"].reason
    scores = score_pair(_pred([(10.0, 20.0)], tempo_ratio=0.54), _truth())    # half time
    assert scores["tempo_ratio"].value == 0.0 and scores["tempo_ratio"].reason == "tempo octave"
    scores = score_pair(_pred([(10.0, 20.0)], tempo_ratio=None), _truth())
    assert scores["tempo_ratio"].applicable and scores["tempo_ratio"].value == 0.0


def test_pitch_shift_is_scored_modulo_an_octave():
    # a key-derived shift only ever claims a pitch class: -10 st and +2 st are the same claim
    scores = score_pair(_pred([(10.0, 20.0)], pitch_semitones=2.0), _truth(pitch_semitones=-10.0))
    assert scores["pitch_shift"].value == 1.0
    scores = score_pair(_pred([(10.0, 20.0)], pitch_semitones=2.0), _truth(pitch_semitones=3.0))
    assert scores["pitch_shift"].value == 0.0 and "not +3 st" in scores["pitch_shift"].reason
    # a detune inside half a semitone still lands on the semitone we claim
    scores = score_pair(_pred([(10.0, 20.0)], pitch_semitones=2.0), _truth(pitch_semitones=1.6))
    assert scores["pitch_shift"].value == 1.0


def test_pair_metrics_never_appear_for_the_other_datasets():
    scores = score_item(Prediction(bpm=90.0), {"bpm": 90.0})
    assert set(scores) == set(METRICS)
    scores = score_item(_pred([(10.0, 20.0)]), _truth())
    assert set(scores) == set(ALL_METRICS)
    assert all(not scores[m].applicable for m in METRICS)


# --------------------------------------------------------------------------
# the loader
# --------------------------------------------------------------------------

def _write_wav(path: pathlib.Path, seconds: float = 1.0, sr: int = SR) -> None:
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.zeros(int(seconds * sr), dtype=np.float32), sr)


def _manifest(data_dir: pathlib.Path, items: list[dict]) -> pathlib.Path:
    d = data_dir / "sample_pairs"
    d.mkdir(parents=True, exist_ok=True)
    path = d / "pairs.json"
    path.write_text(json.dumps({"dataset": "sample_pairs", "audio_dir": "audio", "items": items}))
    return path


def test_loader_says_where_to_put_the_files_when_there_are_none(tmp_path):
    ds = H.load_sample_pairs(tmp_path)
    assert ds.items == [] and ds.note
    assert "sample_pairs" in ds.note and "pairs.json" in ds.note
    assert "sample_pairs.example.json" in ds.note


def test_loader_reads_a_hand_written_manifest(tmp_path):
    audio = tmp_path / "sample_pairs" / "audio"
    for name in ("record.wav", "song.wav", "other.wav"):
        _write_wav(audio / name)
    _manifest(tmp_path, [
        {"id": "pair01", "original": "record.wav", "song": "song.wav",
         "flip": {"from": "0:04", "to": "0:08"}, "tempo_ratio": 1.08, "pitch_semitones": "+2",
         "notes": "the horn line"},
        {"id": "pair02", "original": "other", "flip": "0:11", "tolerance_s": 4},
        {"id": "missing", "original": "nope.wav", "flip": "0:01"},
        {"id": "nothing_known", "original": "record.wav"},
        "not an object",
    ])
    ds = H.load_sample_pairs(tmp_path)
    assert [it.id for it in ds.items] == ["pair01", "pair02"]
    first = ds.items[0]
    assert first.path.endswith("record.wav")
    assert first.truth["flip_span_s"] == [4.0, 8.0]
    assert first.truth["song_path"].endswith("song.wav")
    assert first.truth["pitch_semitones"] == 2.0
    second = ds.items[1]
    assert second.truth["flip_mark_s"] == 11.0 and "song_path" not in second.truth
    assert second.truth["mark_tolerance_s"] == 4.0
    assert second.path.endswith("other.wav")  # named without its suffix
    reasons = {s["id"]: s["reason"] for s in ds.skipped}
    assert reasons["missing"] == "the original is not in the audio folder"
    assert "nothing to score" in reasons["nothing_known"]
    assert "item5" in reasons


def test_loader_keeps_the_owner_s_words_out_of_the_shared_results(tmp_path):
    audio = tmp_path / "sample_pairs" / "audio"
    _write_wav(audio / "record.wav")
    _manifest(tmp_path, [
        {"id": "pair01", "original": "record.wav", "flip": "0:04",
         "title": "a record I own", "artist": "someone", "notes": "private"},
        # the diagnostics a broken entry produces must not quote it either
        {"id": "pair02", "original": "record.wav", "song": "A Famous Song.wav",
         "flip": "the bit after the break", "original_key": "H dorian", "original_bpm": 90},
        {"id": "pair03", "original": "Some Record I Own.wav", "flip": "0:04"},
    ])
    ds = H.load_sample_pairs(tmp_path)
    dumped = json.dumps([it.meta for it in ds.items] + ds.skipped)
    for secret in ("a record I own", "someone", "private", "record.wav", "A Famous Song",
                   "the bit after the break", "H dorian", "Some Record I Own", str(tmp_path)):
        assert secret not in dumped, secret
    first = ds.items[0]
    assert first.meta["flip_mark_s"] == 4.0 and first.meta["has_song"] is False
    assert ds.items[1].meta["notes"] == ["flip timestamp unreadable", "key unreadable",
                                         "the song is not in the audio folder"]


def test_loader_survives_a_broken_manifest(tmp_path):
    d = tmp_path / "sample_pairs"
    d.mkdir(parents=True)
    (d / "pairs.json").write_text("{not json")
    ds = H.load_sample_pairs(tmp_path)
    assert not ds.items and "not valid JSON" in ds.note
    (d / "pairs.json").write_text(json.dumps({"dataset": "sample_pairs"}))
    assert "no 'items' list" in H.load_sample_pairs(tmp_path).note
    (d / "pairs.json").write_text(json.dumps({"items": [{"original": "gone.wav", "flip": "0:01"}]}))
    ds = H.load_sample_pairs(tmp_path)
    assert not ds.items and ds.skipped and "none could be scored" in ds.note


def test_sample_pairs_is_a_registered_dataset(tmp_path):
    assert "sample_pairs" in H.DATASETS and "sample_pairs" in H.LOADERS
    ds = H.load_dataset("sample_pairs", tmp_path)
    assert ds.name == "sample_pairs" and ds.note
    names, explicit = eval_accuracy.resolve_datasets(["all"])
    assert "sample_pairs" in names and not explicit
    names, explicit = eval_accuracy.resolve_datasets(["sample_pairs"])
    assert names == ["sample_pairs"] and explicit


def test_the_shipped_example_manifest_is_a_working_manifest():
    doc = json.loads(H.sample_pairs_example_path().read_text())
    assert doc["dataset"] == "sample_pairs" and doc["items"]
    for entry in [*doc["items"], doc["_the_least_you_can_get_away_with"]]:
        truth, notes = P.pair_truth(entry)
        assert not notes, (entry["id"], notes)
        assert P.scorable(truth), entry["id"]
    full, bars, rough = doc["items"]
    assert P.pair_truth(full)[0]["flip_span_s"] == [64.0, 72.0]
    # two bars at 93 BPM is 5.16 s, from the owner's own BPM
    span = P.pair_truth(bars)[0]["flip_span_s"]
    assert span[0] == 47.0 and span[1] - span[0] == pytest.approx(2 * 4 * 60 / 93)
    assert "flip_span_s" not in P.pair_truth(rough)[0]
    assert P.pair_truth(rough)[0]["mark_tolerance_s"] == 5.0


def test_gates_may_name_a_pair_metric(tmp_path):
    path = tmp_path / "gates.json"
    path.write_text(json.dumps({"_notes": ["x"], "sample_pairs": {"flip_topk": 0.5, "nonsense": 0.9}}))
    assert eval_accuracy.load_gates(path) == {"sample_pairs": {"flip_topk": 0.5}}


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

def test_the_report_prints_the_pair_family_as_its_own_table():
    truth = _truth()
    items = [H.Item("pair01", truth), H.Item("pair02", truth)]
    ds = H.Dataset("sample_pairs", items)
    results = H.run_dataset(ds, workers=1, analyze_fn=lambda it: H.ItemRun(
        it.id, _pred([(10.0, 20.0)] if it.id == "pair01" else [(0.0, 5.0)])))
    doc = H.evaluate({"sample_pairs": H.DatasetOutcome(ds, results, 0.1)}, gates={}, enforce_gates=False)
    metrics = doc["datasets"]["sample_pairs"]["metrics"]
    assert metrics["flip_top1"]["n"] == 2 and metrics["flip_top1"]["score"] == pytest.approx(0.5)
    assert metrics["tempo_ratio"]["score"] == pytest.approx(1.0)
    text = H.render_table(doc)
    assert "sample pairs: did the finder surface the section the producer used?" in text
    assert all(m in text for m in PAIR_METRICS)
    assert "sample_pairs.flip_top1" in text  # the miss reasons cover the pair family too
    md = H.render_markdown(doc)
    assert "## Sample pairs" in md and "flip_mrr" in md


def test_an_ungated_dataset_fails_loudly_rather_than_silently():
    """sample_pairs has no gate, so a run of it alone fails -- and has to say why."""
    truth = _truth()
    ds = H.Dataset("sample_pairs", [H.Item("pair01", truth)])
    results = H.run_dataset(ds, workers=1, analyze_fn=lambda it: H.ItemRun(it.id, _pred([(10.0, 20.0)])))
    doc = H.evaluate({"sample_pairs": H.DatasetOutcome(ds, results, 0.1)},
                     gates={"synthetic": {"bpm_exact": 0.5}}, enforce_gates=True)
    assert doc["gates"]["passed"] is False
    assert doc["gates"]["notes"] == ["no gate applied to any scored item"]
    text = H.render_table(doc)
    assert "no gate applied to any scored item" in text and "gate verdict: FAIL" in text
    assert "no gate applied to any scored item" in H.render_markdown(doc)


# --------------------------------------------------------------------------
# the whole path, on synthetic audio, with no real records anywhere
# --------------------------------------------------------------------------

def test_synthetic_pair_is_a_real_flip_of_a_known_section():
    pair = P.synthetic_pair("demo", sr=SR, bpm=96.0, semitones=2, section_bars=4, sections="AB",
                            used_section=1)
    entry = pair["entry"]
    assert entry["flip"] == {"from": 10.0, "to": 20.0}
    assert entry["tempo_ratio"] == pytest.approx(2 ** (2 / 12), rel=1e-3)
    assert entry["pitch_semitones"] == 2
    original, sr = pair["original"]
    song, song_sr = pair["song"]
    assert sr == song_sr == SR
    assert len(original) / sr == pytest.approx(20.0, abs=0.05)
    # the flip is the section played faster, so it is shorter than what it was cut from
    assert len(song) / sr == pytest.approx(2 * 10.0 / entry["tempo_ratio"], abs=0.2)


def test_synthetic_pair_set_runs_the_whole_path(tmp_path):
    manifest = P.write_synthetic_pair_set(tmp_path / "sample_pairs", sr=SR, small=True)
    assert manifest.is_file() and (tmp_path / "sample_pairs" / "audio").is_dir()

    ds = H.load_sample_pairs(tmp_path)
    assert [it.id for it in ds.items] == ["synthetic_01", "synthetic_02"]
    results = {r.id: r for r in H.run_dataset(ds, workers=1)}

    full = results["synthetic_01"]
    assert not [e for k, e in full.prediction.errors.items() if k != "transform"], full.prediction.errors
    for metric in PAIR_METRICS:
        assert full.scores[metric].applicable, metric
    # the record is measured, the song is measured, and the alignment between them is right
    assert full.prediction.tempo_ratio and full.prediction.pitch_semitones is not None
    assert full.scores["tempo_ratio"].value == 1.0, full.scores["tempo_ratio"].detail
    assert full.scores["pitch_shift"].value == 1.0, full.scores["pitch_shift"].detail
    # the finder does propose the used section somewhere in the rack it returns
    assert full.scores["flip_top1"].detail["best_iou"] >= 0.9, full.scores["flip_top1"].detail
    assert full.scores["flip_mrr"].value >= 0.0
    # the owner's own BPM for the record scores the ordinary metrics too
    assert full.scores["bpm_exact"].applicable and full.scores["bpm_exact"].value == 1.0

    sparse = results["synthetic_02"]
    assert sparse.scores["flip_mark"].applicable
    for metric in ("flip_top1", "flip_topk", "flip_mrr", "tempo_ratio", "pitch_shift"):
        assert not sparse.scores[metric].applicable, metric

    doc = H.evaluate({"sample_pairs": H.DatasetOutcome(ds, list(results.values()), 1.0)},
                     gates={}, enforce_gates=False)
    assert "## Sample pairs" in H.render_markdown(doc)
    assert doc["datasets"]["sample_pairs"]["items"][0]["prediction"]["n_loops"] > 0
