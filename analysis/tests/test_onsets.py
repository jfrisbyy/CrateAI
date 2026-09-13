"""onsets.py: onset_detect(backtrack=True); 8 clicks -> 8 onsets within +/- 10 ms."""

from __future__ import annotations

import numpy as np

from lockedgroove.analysis import onsets as onsets_stage
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, Onsets
from lockedgroove.testing import synth

SR = 22050


def _ctx() -> Context:
    return Context(report=AnalysisReport.empty(), sr=SR)


def test_eight_clicks():
    times = [0.5 + 0.4 * i for i in range(8)]
    y = synth.silence(4.5, SR)
    c = synth.click(SR)
    for t in times:
        s = int(round(t * SR))
        y[s:s + len(c)] += c
    o = onsets_stage.run(y, SR, _ctx())
    assert isinstance(o, Onsets)
    assert o.count == 8 == len(o.times_s)
    for got, want in zip(o.times_s, times):
        assert abs(got - want) <= 0.010
    assert o.method
    assert all(isinstance(t, float) for t in o.times_s)


def test_drum_loop_hits_are_found():
    y = synth.drum_loop(90.0, 2, synth.Pattern.boom_bap(), SR)
    o = onsets_stage.run(y, SR, _ctx())
    # 10 distinct hit times per bar in boom_bap, two bars
    assert 16 <= o.count <= 30
    assert o.times_s == sorted(o.times_s)


def test_silent_and_short_audio_do_not_raise():
    for y in (synth.silence(3.0, SR), synth.silence(0.05, SR), np.zeros(0, dtype=np.float32)):
        o = onsets_stage.run(y, SR, _ctx())
        assert o.count == 0 and o.times_s == []


def test_detect_onsets_helper_is_memoized_and_pure():
    y = synth.drum_loop(90.0, 2, synth.Pattern.boom_bap(), SR)
    a = onsets_stage.detect_onsets(y, SR)
    b = onsets_stage.detect_onsets(y, SR)
    assert np.array_equal(a, b)
    a[:] = 0.0  # mutating a returned copy must not poison the cache
    c = onsets_stage.detect_onsets(y, SR)
    assert np.array_equal(b, c)
