"""key.py: mean chroma_cqt against the 24 Krumhansl-Schmuckler profiles."""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.analysis import key as key_stage
from lockedgroove.pipeline import Context
from lockedgroove.report import PITCH_CLASSES, AnalysisReport, Key
from lockedgroove.testing import synth

SR = 22050


def _ctx() -> Context:
    return Context(report=AnalysisReport.empty(), sr=SR)


def _covers(k: Key, tonic: str, mode: str) -> bool:
    if (k.tonic, k.mode) == (tonic, mode):
        return True
    return k.alternate is not None and (k.alternate.tonic, k.alternate.mode) == (tonic, mode)


def test_c_major_arpeggio():
    y = synth.arpeggio([60, 64, 67, 72], 90.0, 8.0, SR)
    k = key_stage.run(y, SR, _ctx())
    assert isinstance(k, Key)
    assert (k.tonic, k.mode) == ("C", "major")
    assert k.tonic in PITCH_CLASSES
    assert k.method
    assert 0.0 <= k.confidence <= 1.0


def test_a_minor_arpeggio_or_alternate():
    y = synth.arpeggio([57, 60, 64, 69], 90.0, 8.0, SR)
    k = key_stage.run(y, SR, _ctx())
    assert _covers(k, "A", "minor")
    assert k.alternate is not None
    assert -1.0 <= k.alternate.correlation <= 1.0


def test_scales_are_clear_and_confident():
    c_major = synth.arpeggio([60, 62, 64, 65, 67, 69, 71, 72], 120.0, 8.0, SR)
    a_minor = synth.arpeggio([57, 59, 60, 62, 64, 65, 67, 69], 120.0, 8.0, SR)
    kc = key_stage.run(c_major, SR, _ctx())
    ka = key_stage.run(a_minor, SR, _ctx())
    assert (kc.tonic, kc.mode) == ("C", "major")
    assert (ka.tonic, ka.mode) == ("A", "minor")
    assert kc.confidence > 0.4
    assert ka.confidence > 0.6
    # the relative key is the natural alternate
    assert (kc.alternate.tonic, kc.alternate.mode) == ("A", "minor")


def test_sharps_only_in_tonic_names():
    y = synth.chord_progression([synth.triad("A#"), synth.triad("D#"), synth.triad("F"), synth.triad("A#")], 4, 90.0, SR, repeats=2)
    k = key_stage.run(y, SR, _ctx())
    assert k.tonic in PITCH_CLASSES and "b" not in k.tonic
    assert (k.tonic, k.mode) == ("A#", "major")


def test_loop_based_track_reports_its_pitch_class_family():
    # synth.loop_based_track is an F Dorian vamp (Fm G# A# Cm / D# Fm Cm G#): the pitch-class set is that of
    # C minor / D# major, and C is the most frequent pitch class, so a profile method reports that family.
    y, truth = synth.loop_based_track()
    k = key_stage.run(y, SR, _ctx())
    family = {("F", "minor"), ("C", "minor"), ("D#", "major")}
    assert (k.tonic, k.mode) in family or (k.alternate.tonic, k.alternate.mode) in family


def test_drums_only_has_low_confidence():
    y = synth.drum_loop(90.0, 4, synth.Pattern.boom_bap(), SR)
    k = key_stage.run(y, SR, _ctx())
    assert k.confidence < 0.4


def test_silent_and_short_audio_do_not_raise():
    for y in (synth.silence(3.0, SR), synth.silence(0.05, SR), np.zeros(0, dtype=np.float32), synth.arpeggio([60, 64, 67], 90.0, 0.3, SR)):
        k = key_stage.run(y, SR, _ctx())
        assert isinstance(k, Key)
        assert k.tonic in PITCH_CLASSES
        assert 0.0 <= k.confidence <= 1.0
    assert key_stage.run(synth.silence(3.0, SR), SR, _ctx()).confidence == 0.0


def test_profiles_are_krumhansl_schmuckler():
    assert key_stage.MAJOR_PROFILE[0] == pytest.approx(6.35)
    assert key_stage.MINOR_PROFILE[0] == pytest.approx(6.33)
    assert len(key_stage.MAJOR_PROFILE) == 12 and len(key_stage.MINOR_PROFILE) == 12
