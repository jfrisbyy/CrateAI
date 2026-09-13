"""The six harness metrics on hand-made cases, and the harness on an in-memory dataset."""

from __future__ import annotations

import pathlib
import sys

import numpy as np
import pytest

from lockedgroove.eval import harness as H
from lockedgroove.eval.metrics import (
    METRICS,
    bar_length_s,
    boundary_f_measure,
    bpm_exact,
    bpm_octave,
    check_gates,
    downbeat_median_offset_s,
    downbeat_ok,
    key_exact,
    key_relative,
    key_tuple,
    merge_summaries,
    normalize_tonic,
    parse_key,
    prediction_from_report,
    relative_key,
    score_item,
    section_boundaries_s,
    summarize,
)
from lockedgroove.report import AnalysisReport, Beats, Key, KeyAlternate, Section, Structure, Tempo, UserEdits
from lockedgroove.testing.synth import click_track

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import eval_accuracy  # noqa: E402

# --------------------------------------------------------------------------
# tempo
# --------------------------------------------------------------------------

def test_bpm_exact_within_two_bpm():
    assert bpm_exact(90.0, 91.9)
    assert bpm_exact(92.0, 90.0)
    assert not bpm_exact(90.0, 92.1)
    assert not bpm_exact(None, 90.0)


def test_bpm_octave_error_caught_only_through_alternates():
    # double-time prediction; the report lists half and double
    assert not bpm_exact(180.0, 90.0)
    assert bpm_octave(180.0, 90.0, alternates_bpm=[90.0, 360.0])
    assert bpm_octave(180.0, 90.0, alternates_bpm=[88.5, 360.0])  # within 2 BPM of an alternate
    # no alternates listed: the octave metric does not invent them
    assert not bpm_octave(180.0, 90.0, alternates_bpm=[])
    assert not bpm_octave(180.0, 90.0, alternates_bpm=[87.5, 360.0])
    # exact counts as octave-tolerant too
    assert bpm_octave(91.0, 90.0, alternates_bpm=[])


# --------------------------------------------------------------------------
# key
# --------------------------------------------------------------------------

@pytest.mark.parametrize("raw,want", [("Bb", "A#"), ("Db", "C#"), ("Eb", "D#"), ("Gb", "F#"), ("Ab", "G#"),
                                      ("F#", "F#"), ("c", "C"), ("Cb", "B"), ("E#", "F"), ("B♭", "A#"),
                                      ("H", None), ("", None)])
def test_normalize_tonic_to_sharps(raw, want):
    assert normalize_tonic(raw) == want


@pytest.mark.parametrize("text,want", [("F# minor", ("F#", "minor")), ("Db major", ("C#", "major")),
                                       ("Bbm", ("A#", "minor")), ("Abmaj", ("G#", "major")), ("A", ("A", "major")),
                                       ("Eb:minor", ("D#", "minor")), ("nonsense words", None)])
def test_parse_key_forms(text, want):
    assert parse_key(text) == want


def test_key_exact_normalizes_spelling_and_forms():
    assert key_exact({"tonic": "Bb", "mode": "minor"}, ("A#", "minor"))
    assert key_exact("Db major", {"tonic": "C#", "mode": "major"})
    assert not key_exact(("C", "major"), ("C", "minor"))
    assert not key_exact(("C", "major"), ("G", "major"))
    assert key_tuple(Key(tonic="F", mode="minor", confidence=0.5, method="ks")) == ("F", "minor")


def test_relative_key_and_relative_tolerance():
    assert relative_key("C", "major") == ("A", "minor")
    assert relative_key("A", "minor") == ("C", "major")
    assert relative_key("F", "minor") == ("G#", "major")
    # truth is the relative minor of the prediction
    assert key_relative(("C", "major"), ("A", "minor"))
    assert key_relative(("A", "minor"), ("C", "major"))
    # the report's alternate matches the truth
    assert key_relative(("C", "major"), ("G", "major"), pred_alternate=("G", "major"))
    # parallel key is not relative; unrelated key is not either
    assert not key_relative(("C", "major"), ("C", "minor"))
    assert not key_relative(("C", "major"), ("D#", "minor"))
    assert not key_relative(None, ("C", "major"))


# --------------------------------------------------------------------------
# downbeats
# --------------------------------------------------------------------------

def test_bar_length_from_downbeats_or_bpm():
    assert bar_length_s([0.0, 2.0, 4.0, 6.0]) == pytest.approx(2.0)
    assert bar_length_s(None, bpm=120.0) == pytest.approx(2.0)
    assert bar_length_s(None, bpm=120.0, beats_per_bar=3) == pytest.approx(1.5)
    assert bar_length_s([1.0]) is None


def test_downbeat_offsets_and_tolerance():
    bar = 2.0  # 120 BPM, 4/4
    truth = [0.0, 2.0, 4.0, 6.0, 8.0]
    close = [t + 0.02 for t in truth]
    assert downbeat_median_offset_s(close, truth, bar) == pytest.approx(0.02)
    assert downbeat_ok(close, truth, bar)
    # one whole bar late is the same phase: passes modulo the bar length
    assert downbeat_ok([t + bar for t in truth], truth, bar)
    # one beat late (a phase error) fails: the offset is a quarter bar
    one_beat = [t + 0.5 for t in truth]
    assert downbeat_median_offset_s(one_beat, truth, bar) == pytest.approx(0.5)
    assert not downbeat_ok(one_beat, truth, bar)
    # 70 ms is outside +-60 ms
    assert not downbeat_ok([t + 0.07 for t in truth], truth, bar)
    # nothing predicted: not ok
    assert not downbeat_ok([], truth, bar)
    assert downbeat_median_offset_s([], truth, bar) is None


# --------------------------------------------------------------------------
# structure boundaries
# --------------------------------------------------------------------------

def _sections(*bounds: float, labels: str = "ABAB") -> list[dict]:
    out = []
    for i in range(len(bounds) - 1):
        out.append({"start_s": bounds[i], "end_s": bounds[i + 1], "label": labels[i % len(labels)]})
    return out


def test_section_boundaries_trim_ends_and_merge_duplicates():
    secs = _sections(0.0, 8.0, 16.0, 24.0, 32.0)
    assert section_boundaries_s(secs) == [8.0, 16.0, 24.0]
    assert section_boundaries_s(secs, trim=False) == [0.0, 8.0, 16.0, 24.0, 32.0]
    assert section_boundaries_s([]) == []
    # a gap between sections still yields distinct boundaries
    gapped = [{"start_s": 0, "end_s": 8}, {"start_s": 9, "end_s": 16}]
    assert section_boundaries_s(gapped) == [8.0, 9.0]


def test_boundary_f_measure_with_one_missed_boundary():
    truth = [8.0, 16.0, 24.0]
    tol = 2.0  # one bar at 120 BPM
    score = boundary_f_measure([8.5, 16.2], truth, tol)
    assert score.matched == 2 and score.n_pred == 2 and score.n_true == 3
    assert score.precision == pytest.approx(1.0)
    assert score.recall == pytest.approx(2 / 3)
    assert score.f == pytest.approx(0.8)
    # perfect
    assert boundary_f_measure(truth, truth, tol).f == pytest.approx(1.0)
    # one-to-one matching: two predictions near one truth count once
    dup = boundary_f_measure([8.0, 8.5], [8.0], tol)
    assert dup.matched == 1 and dup.precision == pytest.approx(0.5)
    # outside the tolerance
    assert boundary_f_measure([12.0], [8.0], tol).f == 0.0
    # nothing predicted
    assert boundary_f_measure([], truth, tol).f == 0.0
    # nothing to find and nothing predicted
    assert boundary_f_measure([], [], tol).f == 1.0


# --------------------------------------------------------------------------
# report -> prediction -> item score
# --------------------------------------------------------------------------

def _report(bpm=90.0, alternates=(45.0, 180.0), key=("F", "minor"), alt=None, phase=0, sections=True) -> AnalysisReport:
    beat = 60.0 / bpm
    times = [i * beat for i in range(64)]
    downbeats = [t for i, t in enumerate(times) if i % 4 == phase]
    bar = 4 * beat
    return AnalysisReport(
        tempo=Tempo(bpm=bpm, confidence=0.9, method="test", alternates_bpm=list(alternates)),
        beats=Beats(times_s=times, confidence=0.9, method="test", downbeats_s=downbeats, downbeat_phase=phase,
                    downbeat_confidence=0.7, downbeat_method="test"),
        key=Key(tonic=key[0], mode=key[1], confidence=0.8, method="test",
                alternate=KeyAlternate(tonic=alt[0], mode=alt[1], correlation=0.5) if alt else None),
        structure=Structure(sections=[
            Section(start_s=i * 4 * bar, end_s=(i + 1) * 4 * bar, start_bar=i * 4, bars=4, label="AB"[i % 2],
                    energy=0.5, confidence=0.6) for i in range(4)
        ], loop_period_bars=4, loop_period_confidence=0.5, method="test") if sections else None,
    )


def _truth(bpm=90.0, key=("F", "minor"), phase=0, sections=True) -> dict:
    beat = 60.0 / bpm
    bar = 4 * beat
    truth = {
        "bpm": bpm, "key": {"tonic": key[0], "mode": key[1]},
        "downbeats_s": [phase * beat + b * bar for b in range(16)],
        "beats_s": [i * beat for i in range(64)],
    }
    if sections:
        truth["sections"] = _sections(*[i * 4 * bar for i in range(5)])
    return truth


def test_prediction_from_report_reads_effective_values():
    r = _report(alt=("G#", "major"))
    p = prediction_from_report(r.to_json_dict(), errors={"chords": "not run"})
    assert p.bpm == 90.0 and p.alternates_bpm == [45.0, 180.0]
    assert p.key == ("F", "minor") and p.key_alternate == ("G#", "major")
    assert len(p.downbeats_s) == 16 and p.has_structure and len(p.sections) == 4
    assert p.errors == {"chords": "not run"}
    # the pydantic model works too, and user edits are honored once resolved
    r.user_edits = UserEdits(tempo_bpm=180.0)
    from lockedgroove.report import effective

    assert prediction_from_report(effective(r)).bpm == 180.0


def test_score_item_all_hits():
    scores = score_item(prediction_from_report(_report()), _truth())
    assert set(scores) == set(METRICS)
    assert all(s.applicable for s in scores.values())
    assert all(s.value == pytest.approx(1.0) for s in scores.values())


def test_score_item_octave_error_and_phase_error():
    pred = prediction_from_report(_report(bpm=180.0, alternates=(90.0, 360.0), phase=1))
    scores = score_item(pred, _truth(bpm=90.0, phase=0))
    assert scores["bpm_exact"].value == 0.0 and "off by" in scores["bpm_exact"].reason
    assert scores["bpm_octave"].value == 1.0
    # downbeats one beat late (predicted bar is half the true bar here, so offsets are 1/3 s)
    assert scores["downbeat"].value == 0.0
    assert "median offset" in scores["downbeat"].reason


def test_score_item_skips_missing_truth_and_misses_missing_prediction():
    # truth without key or sections: those metrics are not applicable
    scores = score_item(prediction_from_report(_report()), {"bpm": 90.0})
    assert scores["bpm_exact"].applicable and scores["bpm_exact"].value == 1.0
    assert not scores["key_exact"].applicable and not scores["downbeat"].applicable
    assert not scores["structure_f"].applicable
    # empty report (stages missing): every applicable metric is a miss with the stage's reason
    pred = prediction_from_report(AnalysisReport.empty(), errors={"tempo": "stage not available: No module named x"})
    scores = score_item(pred, _truth())
    assert scores["bpm_exact"].value == 0.0 and scores["bpm_exact"].reason.startswith("tempo: stage not available")
    assert scores["key_exact"].value == 0.0 and scores["key_exact"].reason == "no key in report"
    assert scores["downbeat"].value == 0.0 and scores["structure_f"].value == 0.0
    # sections present in truth but a single one: no internal boundary, structure is skipped
    single = _truth()
    single["sections"] = single["sections"][:1]
    assert not score_item(prediction_from_report(_report()), single)["structure_f"].applicable


def test_summaries_and_gates():
    hits = score_item(prediction_from_report(_report()), _truth())
    misses = score_item(prediction_from_report(_report(bpm=180.0, alternates=(), key=("C", "major"), phase=2)), _truth())
    summary = summarize([hits, misses])
    assert summary["bpm_exact"].n == 2 and summary["bpm_exact"].score == pytest.approx(0.5)
    assert summary["bpm_octave"].score == pytest.approx(0.5)
    assert summary["key_relative"].score == pytest.approx(0.5)
    # the 180 BPM report's sections are half as long, so only one of its three boundaries lands: F = 1/3
    assert summary["structure_f"].score == pytest.approx((1.0 + 1 / 3) / 2)
    pooled = merge_summaries([summary, summarize([hits])])
    assert pooled["bpm_exact"].n == 3 and pooled["bpm_exact"].score == pytest.approx(2 / 3)
    gates = {"mem": {"bpm_exact": 0.8, "structure_f": 0.6, "key_exact": 0.5}, "other": {"bpm_exact": 0.9}}
    results = check_gates({"mem": summary}, gates)
    by_metric = {g.metric: g for g in results}
    assert by_metric["bpm_exact"].passed is False
    assert by_metric["structure_f"].passed is True
    assert by_metric["key_exact"].passed is True
    # a metric with no applicable items is n/a, not a failure
    na = check_gates({"mem": summarize([score_item(prediction_from_report(_report()), {"bpm": 90.0})])},
                     {"mem": {"key_exact": 0.5}})[0]
    assert na.passed is None and not na.applicable


# --------------------------------------------------------------------------
# the harness end to end, in memory
# --------------------------------------------------------------------------

def test_eval_accuracy_scores_in_memory_dataset_without_disk():
    sr = 22050
    items = [
        H.Item("good", _truth(), audio=(click_track(90.0, 2.0, sr), sr)),
        H.Item("octave", _truth(), audio=(click_track(90.0, 2.0, sr), sr)),
        H.Item("bpm_only", {"bpm": 90.0}, audio=(click_track(90.0, 2.0, sr), sr)),
    ]
    reports = {
        "good": _report(),
        "octave": _report(bpm=180.0, alternates=(90.0, 360.0), key=("G#", "major"), phase=1),
        "bpm_only": _report(),
    }

    def analyze(item: H.Item) -> AnalysisReport:
        assert item.audio is not None and item.path is None
        return reports[item.id]

    ds = eval_accuracy.Dataset("mem", items)
    results = eval_accuracy.run_dataset(ds, workers=1, analyze_fn=analyze)
    assert [r.id for r in results] == ["good", "octave", "bpm_only"]
    doc = eval_accuracy.evaluate({"mem": eval_accuracy.DatasetOutcome(ds, results, 0.1)},
                                 gates={"mem": {"bpm_exact": 0.5, "bpm_octave": 0.95, "key_exact": 0.9}},
                                 enforce_gates=True)
    m = doc["datasets"]["mem"]["metrics"]
    assert m["bpm_exact"]["n"] == 3 and m["bpm_exact"]["score"] == pytest.approx(2 / 3)
    assert m["bpm_octave"]["score"] == pytest.approx(1.0)
    assert m["key_exact"]["n"] == 2 and m["key_exact"]["score"] == pytest.approx(0.5)
    assert m["key_relative"]["score"] == pytest.approx(1.0)  # G# major is the relative of F minor
    assert m["downbeat"]["n"] == 2 and m["downbeat"]["score"] == pytest.approx(0.5)
    assert m["structure_f"]["n"] == 2
    gate = {g["metric"]: g for g in doc["gates"]["results"]}
    assert gate["bpm_exact"]["passed"] is True
    assert gate["key_exact"]["passed"] is False
    assert doc["gates"]["passed"] is False
    text = eval_accuracy.render_table(doc)
    assert "mem" in text and "FAIL mem.key_exact" in text and "gate verdict: FAIL" in text
    md = eval_accuracy.render_markdown(doc)
    assert "| mem | 3 |" in md


def test_harness_survives_missing_stages_on_real_pipeline():
    sr = 22050
    y = click_track(120.0, 1.5, sr)
    ds = H.Dataset("clicks", [H.Item("c", _truth(bpm=120.0), audio=(y, sr))])
    results = H.run_dataset(ds, workers=1, stages=["tempo", "beats", "key", "structure"])
    assert len(results) == 1
    scores = results[0].scores
    for metric in METRICS:
        assert scores[metric].applicable
        # either the stage produced a value (hit or miss) or the miss carries the stage's reason
        assert scores[metric].value is not None
        if scores[metric].value < 1.0:
            assert scores[metric].reason
    doc = H.evaluate({"clicks": H.DatasetOutcome(ds, results, 0.0)}, gates={}, enforce_gates=False)
    assert doc["datasets"]["clicks"]["n_items"] == 1
    assert doc["gates"]["passed"] is None


def test_parse_beats_file_and_ballroom_truth_shape():
    text = "0.03 1\n0.70 2\n1.36 3\n2.04 1\n2.70 2\n3.36 3\n"
    beats, downbeats, beats_per_bar = H.parse_beats_file(text)
    assert len(beats) == 6 and downbeats == [0.03, 2.04] and beats_per_bar == 3
    assert bar_length_s(downbeats) == pytest.approx(2.01)


def test_truth_from_corrections_uses_only_corrected_fields():
    report = _report().to_json_dict()
    truth, notes = H.truth_from_corrections(report, {"tempo_bpm": 92.0, "key": {"tonic": "Bb", "mode": "major"}})
    assert truth == {"bpm": 92.0, "key": {"tonic": "A#", "mode": "major"}} and not notes
    truth, notes = H.truth_from_corrections(report, {"downbeat_phase": 2})
    assert truth["downbeats_s"][0] == pytest.approx(2 * 60 / 90) and not notes
    truth, notes = H.truth_from_corrections(None, {"downbeat_phase": 2})
    assert truth == {} and notes
    # section labels alone carry no boundary truth
    assert H.truth_from_corrections(report, {"section_labels": {"0": "hook"}})[0] == {}


def test_corrections_dataset_skips_without_env(tmp_path):
    ds = H.load_corrections(tmp_path, env={})
    assert ds.items == [] and "SUPABASE_URL" in ds.note and "L.36" in ds.note


def test_synthetic_loader_reads_truth_files(tmp_path):
    import json

    import soundfile as sf

    d = tmp_path / "synthetic"
    d.mkdir()
    sf.write(d / "a.wav", np.zeros(2205, dtype=np.float32), 22050)
    (d / "a.json").write_text(json.dumps({"id": "a", "bpm": 90.0, "params": {"structure": "ABAB"}}))
    (d / "b.json").write_text(json.dumps({"id": "b", "bpm": 90.0}))  # no wav
    ds = H.load_synthetic(tmp_path)
    assert [it.id for it in ds.items] == ["a"] and ds.items[0].meta["structure"] == "ABAB"
    assert ds.skipped == [{"id": "b", "reason": "missing wav"}]
    assert H.load_synthetic(tmp_path / "nowhere").note.startswith("not found")


def test_public_dataset_loaders_on_fake_layouts(tmp_path):
    import soundfile as sf

    silent = np.zeros(2205, dtype=np.float32)
    # giantsteps key: one item with audio, one annotation without audio
    gk = tmp_path / "giantsteps_key"
    (gk / "annotations" / "key").mkdir(parents=True)
    (gk / "audio").mkdir()
    (gk / "annotations" / "key" / "1.LOFI.key").write_text("Eb minor")
    (gk / "annotations" / "key" / "2.LOFI.key").write_text("C major")
    sf.write(gk / "audio" / "1.LOFI.wav", silent, 22050)
    ds = H.load_giantsteps_key(tmp_path)
    assert [it.id for it in ds.items] == ["1.LOFI"]
    assert ds.items[0].truth == {"key": {"tonic": "D#", "mode": "minor"}}
    assert ds.skipped == [{"id": "2.LOFI", "reason": "missing audio"}]
    # giantsteps tempo: v2 preferred, 0.0 skipped, v1 kept in meta
    gt = tmp_path / "giantsteps_tempo"
    (gt / "annotations_v2" / "tempo").mkdir(parents=True)
    (gt / "annotations" / "tempo").mkdir(parents=True)
    (gt / "audio").mkdir()
    (gt / "annotations_v2" / "tempo" / "1.LOFI.bpm").write_text("127.0\n")
    (gt / "annotations" / "tempo" / "1.LOFI.bpm").write_text("126\n")
    (gt / "annotations_v2" / "tempo" / "2.LOFI.bpm").write_text("0.0\n")
    sf.write(gt / "audio" / "1.LOFI.wav", silent, 22050)
    sf.write(gt / "audio" / "2.LOFI.wav", silent, 22050)
    ds = H.load_giantsteps_tempo(tmp_path)
    assert [it.id for it in ds.items] == ["1.LOFI"] and ds.items[0].truth == {"bpm": 127.0}
    assert ds.items[0].meta == {"annotation": "v2", "bpm_v1": 126.0}
    assert ds.skipped[0]["reason"].startswith("no tempo annotation")
    # ballroom: beats at the annotated level, downbeats from id 1, bpm from the median IBI, genre from the folder
    br = tmp_path / "ballroom"
    (br / "annotations").mkdir(parents=True)
    (br / "BallroomData" / "Waltz").mkdir(parents=True)
    (br / "annotations" / "Media-1.beats").write_text("0.5 1\n1.0 2\n1.5 3\n2.0 1\n2.5 2\n3.0 3\n")
    sf.write(br / "BallroomData" / "Waltz" / "Media-1.wav", silent, 22050)
    ds = H.load_ballroom(tmp_path)
    assert len(ds.items) == 1
    truth = ds.items[0].truth
    assert truth["bpm"] == pytest.approx(120.0) and truth["downbeats_s"] == [0.5, 2.0] and truth["meter"] == "3/4"
    assert ds.items[0].meta["genre"] == "Waltz"
    # missing dataset directories give a note, never an exception; unknown names do raise
    assert H.load_ballroom(tmp_path / "nowhere").note.startswith("not found")
    assert H.load_dataset("giantsteps_key", tmp_path / "nowhere").note.startswith("not found")
    with pytest.raises(ValueError):
        H.load_dataset("nope", tmp_path)


def test_parallel_run_records_a_crashed_worker_instead_of_hanging(tmp_path):
    # Items on disk so the spawn pool is used; the worker dies without ever
    # sending a result, the way a native crash does. The run must still finish.
    import soundfile as sf

    sr = 22050
    y = click_track(120.0, 1.0, sr)
    items = []
    for i in range(2):
        path = tmp_path / f"c{i}.wav"
        sf.write(path, y, sr)
        items.append(H.Item(f"c{i}", _truth(bpm=120.0), path=str(path)))
    ds = H.Dataset("crash", items)
    results = H.run_dataset(ds, workers=2, worker_fn=H._crash_worker, stall_timeout_s=2.0)
    assert [r.id for r in results] == ["c0", "c1"]
    for r in results:
        assert "lost" in r.prediction.errors["analysis"]
        assert r.scores["bpm_exact"].value == 0.0
