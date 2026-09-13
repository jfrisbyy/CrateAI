"""The three forms of the AnalysisReport (Pydantic, JSON Schema, TypeScript) agree."""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from gen_report_types import SCHEMA_PATH, TS_PATH, render_schema, render_ts  # noqa: E402

from lockedgroove.report import (  # noqa: E402
    AnalysisReport,
    Beats,
    FileInfo,
    Key,
    KeyEdit,
    Section,
    Structure,
    Tempo,
    UserEdits,
    effective,
    hedge_word,
    json_schema,
)


def test_json_schema_file_is_current():
    assert SCHEMA_PATH.exists(), "run scripts/gen_report_types.py"
    assert SCHEMA_PATH.read_text() == render_schema(json_schema())


def test_typescript_types_are_current():
    assert TS_PATH.exists(), "run scripts/gen_report_types.py"
    assert TS_PATH.read_text() == render_ts(json_schema())


def test_empty_report_validates_against_schema():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(SCHEMA_PATH.read_text())
    report = AnalysisReport.empty(FileInfo(id="x", duration_s=1.0, sample_rate=44100, channels=2))
    jsonschema.validate(report.to_json_dict(), schema)


def test_sections_default_to_null():
    r = AnalysisReport.empty()
    d = r.to_json_dict()
    for section in ("tempo", "beats", "key", "chords", "onsets", "groove", "structure", "drums",
                    "sample_use", "instrumentation", "loudness", "spectral", "effects_estimates"):
        assert d[section] is None


def _report_with_grid() -> AnalysisReport:
    beat = 60.0 / 90.0
    times = [i * beat for i in range(32)]
    return AnalysisReport(
        tempo=Tempo(bpm=90.0, confidence=0.9, method="librosa", alternates_bpm=[45.0, 180.0]),
        beats=Beats(times_s=times, confidence=0.9, method="librosa",
                    downbeats_s=[t for i, t in enumerate(times) if i % 4 == 1],
                    downbeat_phase=1, downbeat_confidence=0.5, downbeat_method="lowband"),
        key=Key(tonic="F", mode="minor", confidence=0.7, method="ks"),
        structure=Structure(sections=[Section(start_s=0, end_s=10, start_bar=0, bars=4, label="A", energy=0.5, confidence=0.6)],
                            loop_period_bars=4, loop_period_confidence=0.7, method="ssm"),
    )


def test_effective_applies_tempo_edit_and_marks_user_method():
    r = _report_with_grid()
    r.user_edits = UserEdits(tempo_bpm=180.0)
    e = effective(r)
    assert e.tempo.bpm == 180.0
    assert e.tempo.method == "user"
    assert e.tempo.confidence == 1.0
    # doubling the tempo doubles the grid density
    assert len(e.beats.times_s) == 2 * len(r.beats.times_s) - 1
    # the stored report is untouched
    assert r.tempo.bpm == 90.0


def test_effective_halving_thins_the_grid():
    r = _report_with_grid()
    r.user_edits = UserEdits(tempo_bpm=45.0)
    e = effective(r)
    assert len(e.beats.times_s) == 16


def test_effective_downbeat_phase_edit():
    r = _report_with_grid()
    r.user_edits = UserEdits(downbeat_phase=2)
    e = effective(r)
    assert e.beats.downbeat_phase == 2
    assert e.beats.downbeats_s[0] == pytest.approx(2 * 60 / 90)
    assert e.beats.downbeat_method == "user"


def test_effective_first_downbeat_click_sets_phase():
    r = _report_with_grid()
    beat = 60 / 90
    r.user_edits = UserEdits(first_downbeat_s=3 * beat + 0.02)  # click near beat 3
    e = effective(r)
    assert e.beats.downbeat_phase == 3
    assert e.beats.downbeats_s[0] == pytest.approx(3 * beat)


def test_effective_key_and_section_labels():
    r = _report_with_grid()
    r.user_edits = UserEdits(key=KeyEdit(tonic="G#", mode="major"), section_labels={"0": "hook"})
    e = effective(r)
    assert (e.key.tonic, e.key.mode, e.key.method) == ("G#", "major", "user")
    assert e.structure.sections[0].label == "hook"
    assert e.structure.sections[0].confidence == 1.0


def test_meter_edit_regroups_downbeats():
    r = _report_with_grid()
    r.user_edits = UserEdits(meter="3/4", downbeat_phase=0)
    e = effective(r)
    assert e.beats.meter == "3/4"
    assert e.beats.downbeats_s[1] == pytest.approx(3 * 60 / 90)


@pytest.mark.parametrize("conf,word", [(0.95, ""), (0.8, ""), (0.7, "likely"), (0.6, "likely"),
                                       (0.5, "roughly"), (0.4, "roughly"), (0.39, "I can't tell"),
                                       (0.0, "I can't tell"), (None, "not measured")])
def test_hedge_bands(conf, word):
    assert hedge_word(conf) == word
