"""The default Phase 0 stage set on synth.loop_based_track(), end to end."""

from __future__ import annotations

import json
import time

import numpy as np

from lockedgroove.pipeline import DEFAULT_STAGES, analyze_array
from lockedgroove.testing import synth

SR = 22050


def test_phase0_pipeline_on_loop_based_track():
    y, truth = synth.loop_based_track()
    t0 = time.perf_counter()
    report, ctx = analyze_array(y, SR, return_context=True)
    elapsed = time.perf_counter() - t0
    assert elapsed < 60.0
    assert ctx.errors == {}
    for field in DEFAULT_STAGES:
        assert getattr(report, field) is not None, field

    assert abs(report.tempo.bpm - truth["bpm"]) <= 2.0
    assert report.tempo.confidence > 0.5

    # key: the fixture is an F Dorian vamp whose pitch-class set is C minor / D# major (see HANDOFF_dsp.md);
    # accept the truth or any key of that family, on the key or its alternate
    family = {("F", "minor"), ("C", "minor"), ("D#", "major")}
    got = {(report.key.tonic, report.key.mode)}
    if report.key.alternate is not None:
        got.add((report.key.alternate.tonic, report.key.alternate.mode))
    assert got & family

    assert len(report.beats.times_s) > 100
    assert report.beats.confidence > 0.5
    assert report.onsets.count > 100
    assert report.structure.loop_period_bars == truth["loop_period_bars"]
    assert len(report.structure.sections) == len(truth["sections"])
    assert 40.0 <= report.groove.swing_pct <= 60.0
    assert -40.0 < report.loudness.integrated_lufs < 0.0
    assert report.spectral.stereo_width == 0.0

    # every section carries method (and confidence where the model has one)
    for field in DEFAULT_STAGES:
        section = getattr(report, field)
        assert section.method
        if hasattr(section, "confidence"):
            assert 0.0 <= section.confidence <= 1.0

    # the report serializes to plain JSON
    json.dumps(report.to_json_dict())


def test_phase0_pipeline_stereo_native_rate():
    y, truth = synth.loop_based_track(sr=44100, sections="AB", section_bars=4)
    stereo = synth.to_stereo(y, width=0.5)
    report, ctx = analyze_array(stereo, 44100, return_context=True)
    assert ctx.errors == {}
    assert abs(report.tempo.bpm - truth["bpm"]) <= 2.0
    assert report.spectral.stereo_width > 0.1
    assert report.file.channels == 2 and report.file.sample_rate == 44100


def test_phase0_pipeline_survives_silence_and_tiny_input():
    for y in (np.zeros(SR * 2, dtype=np.float32), np.zeros(int(SR * 0.05), dtype=np.float32)):
        report, ctx = analyze_array(y, SR, return_context=True)
        assert ctx.errors == {}, ctx.errors
        for field in DEFAULT_STAGES:
            assert getattr(report, field) is not None, field
        assert report.tempo.confidence == 0.0
        json.dumps(report.to_json_dict())
