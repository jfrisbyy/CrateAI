"""beats.py: beat_track with the tempo hint; downbeat phase from low-band onset energy."""

from __future__ import annotations

import numpy as np

from lockedgroove.analysis import beats as beats_stage
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, Beats, Tempo
from lockedgroove.testing import synth

SR = 22050
BPM = 90.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT


def _ctx(bpm: float | None = BPM, **options) -> Context:
    report = AnalysisReport.empty()
    if bpm is not None:
        report.tempo = Tempo(bpm=bpm, confidence=0.9, method="test", alternates_bpm=[bpm / 2, bpm * 2])
    return Context(report=report, sr=SR, options=dict(options))


def _kick_on_one(offset_s: float = 0.0) -> np.ndarray:
    # kick on the one plus hats on every beat (Pattern.kick_on_one has hats on steps 0, 4, 8, 12)
    return synth.drum_loop(BPM, 8, synth.Pattern.kick_on_one(), SR, offset_s=offset_s)


def _phase_error_s(downbeats: list[float], offset_s: float) -> float:
    d = (np.asarray(downbeats) - offset_s) % BAR
    d = np.minimum(d, BAR - d)
    return float(np.max(d))


def test_kick_on_one_recovers_phase():
    b = beats_stage.run(_kick_on_one(), SR, _ctx())
    assert isinstance(b, Beats)
    assert len(b.times_s) >= 28
    assert len(b.downbeats_s) >= 7
    assert _phase_error_s(b.downbeats_s, 0.0) < 0.06
    assert b.downbeat_confidence > 0.5
    assert b.downbeat_method and b.method
    assert b.meter == "4/4"
    # the beat at time zero survives refinement, so bar 0 keeps its downbeat
    assert abs(b.downbeats_s[0]) < 0.06 and b.downbeat_phase == 0
    # downbeats are members of the beat grid at the reported phase
    idx = [min(range(len(b.times_s)), key=lambda i: abs(b.times_s[i] - d)) for d in b.downbeats_s]
    assert all(i % 4 == b.downbeat_phase for i in idx)


def test_kick_on_one_with_one_beat_offset_recovers_phase():
    b = beats_stage.run(_kick_on_one(offset_s=BEAT), SR, _ctx())
    assert _phase_error_s(b.downbeats_s, BEAT) < 0.06
    assert b.downbeat_confidence > 0.5
    assert abs(b.downbeats_s[0] - BEAT) < 0.06


def test_beats_land_on_the_grid_for_programmed_drums():
    y = synth.drum_loop(BPM, 8, synth.Pattern.boom_bap(), SR)
    b = beats_stage.run(y, SR, _ctx())
    truth = np.arange(32) * BEAT
    errs = []
    for t in b.times_s:
        if t > truth[-1] + 0.1:
            continue
        errs.append(abs(t - truth[np.argmin(np.abs(truth - t))]))
    errs = np.array(errs)
    assert len(errs) >= 30
    assert np.median(errs) < 0.015
    assert np.mean(errs < 0.03) > 0.9
    assert b.confidence > 0.8
    assert abs((b.downbeats_s[0]) % BAR) < 0.06 or abs((b.downbeats_s[0]) % BAR - BAR) < 0.06


def test_four_on_the_floor_has_low_downbeat_confidence():
    y = synth.drum_loop(BPM, 8, synth.Pattern.four_on_floor(), SR)
    b = beats_stage.run(y, SR, _ctx())
    assert b.downbeat_confidence < 0.3
    assert 0.0 <= b.confidence <= 1.0


def test_meter_option_regroups_downbeats():
    y = synth.drum_loop(BPM, 8, synth.Pattern.kick_on_one(), SR, beats_per_bar=3)
    b = beats_stage.run(y, SR, _ctx(meter="3/4"))
    assert b.meter == "3/4"
    assert len(b.downbeats_s) >= 6
    d = np.diff(b.downbeats_s)
    assert np.allclose(d, 3 * BEAT, atol=0.08)
    assert b.downbeat_phase in (0, 1, 2)


def test_runs_without_tempo_hint():
    b = beats_stage.run(_kick_on_one(), SR, _ctx(bpm=None))
    assert len(b.times_s) > 10
    assert b.notes  # says the prior was used


def test_silent_and_short_audio_do_not_raise():
    for y in (synth.silence(3.0, SR), synth.silence(0.05, SR), np.zeros(0, dtype=np.float32), synth.click_track(90.0, 0.4, SR)):
        b = beats_stage.run(y, SR, _ctx())
        assert isinstance(b, Beats)
        assert 0.0 <= b.confidence <= 1.0
        assert 0.0 <= b.downbeat_confidence <= 1.0
        assert len(b.downbeats_s) <= len(b.times_s)


def test_deterministic_and_sorted():
    y = synth.drum_loop(BPM, 4, synth.Pattern.boom_bap(), SR)
    a = beats_stage.run(y, SR, _ctx())
    b = beats_stage.run(y, SR, _ctx())
    assert a == b
    assert a.times_s == sorted(a.times_s)
    assert all(isinstance(t, float) for t in a.times_s)
