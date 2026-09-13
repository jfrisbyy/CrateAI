"""quality/metrics.py: the numbers that catch a lossy chain."""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.quality.fixtures import lossy_copy, transient_bed
from lockedgroove.quality.metrics import (
    SILENT_DB,
    air_db,
    band_ratio_db,
    detect_onsets_s,
    measure_stage,
    to_mono,
    transient_concentration,
    transient_retention,
)
from lockedgroove.testing import synth

SR = 44100


def test_band_ratio_is_relative_not_absolute():
    """Level changes must not move it, or it could not be compared across stages."""
    y, _ = transient_bed(SR)
    loud = air_db(y, SR)
    assert air_db(y * 0.01, SR) == pytest.approx(loud, abs=0.01)
    assert air_db(np.stack([y, y]), SR) == pytest.approx(loud, abs=0.01)


def test_band_ratio_finds_the_band_it_is_given():
    high = synth.sine(12000.0, 2.0, SR, amplitude=0.5)
    low = synth.sine(200.0, 2.0, SR, amplitude=0.5)
    assert air_db(high, SR) > -1.0           # essentially all of it is in 8-20 kHz
    assert air_db(low, SR) < -40.0
    assert band_ratio_db(low, SR, 100.0, 400.0) > -1.0


def test_a_lowpass_is_exactly_what_the_bug_looked_like():
    """A brickwall at 8 kHz is the weak-separator failure, and it must be loud."""
    y, _ = transient_bed(SR)
    dulled = lossy_copy(y, SR, 8000.0)
    assert air_db(y, SR) - air_db(dulled, SR) > 15.0


def test_silence_and_empty_do_not_raise():
    assert air_db(np.zeros(SR), SR) == SILENT_DB
    assert air_db(np.zeros(0), SR) == SILENT_DB
    assert band_ratio_db(np.zeros(10), 0) == SILENT_DB
    assert to_mono(np.zeros((2, 0))).size == 0


def test_transient_concentration_is_highest_for_an_impulse():
    impulse = np.zeros(SR, dtype=np.float32)
    impulse[SR // 2] = 1.0
    sharp = transient_concentration(impulse, SR, [0.5])
    smeared = np.zeros(SR, dtype=np.float32)
    smeared[SR // 2 - 400:SR // 2 + 400] = 1.0 / 800
    assert sharp > 0.99
    assert transient_concentration(smeared, SR, [0.5]) < sharp / 2


def test_transient_retention_is_one_when_nothing_changed():
    y, onsets = transient_bed(SR)
    assert transient_retention(y, y, SR, 1.0, onsets) == pytest.approx(1.0)


def test_transient_retention_falls_when_onsets_are_smeared():
    """A decaying-noise convolution keeps the bandwidth and destroys the timing: exactly a vocoder's failure."""
    y, onsets = transient_bed(SR)
    rng = np.random.default_rng(7)
    tail = int(0.06 * SR)
    kernel = rng.standard_normal(tail) * np.exp(-np.arange(tail) / (0.02 * SR))
    kernel /= np.linalg.norm(kernel)
    smeared = np.convolve(y, kernel, mode="same").astype(np.float32)
    smeared_score = transient_retention(y, smeared, SR, 1.0, onsets)
    assert smeared_score < 0.65
    # ...and worse than the same signal left alone, which is the property that matters
    assert smeared_score < transient_retention(y, y, SR, 1.0, onsets)


def test_transient_retention_without_onsets_is_neutral_not_zero():
    """No onsets to compare is 'nothing measured', which must not read as a failure."""
    flat = synth.sine(440.0, 1.0, SR)
    assert transient_retention(flat, flat, SR, 1.0, []) == 1.0


def test_detect_onsets_finds_the_hits_it_was_given():
    y, onsets = transient_bed(SR, seconds=2.0)
    found = detect_onsets_s(y, SR)
    assert len(found) >= len(onsets) - 2
    for t in onsets[:4]:
        assert min(abs(t - f) for f in found) < 0.03


def test_measure_stage_reports_both_directions_as_damage():
    y, onsets = transient_bed(SR)
    dulled = lossy_copy(y, SR, 8000.0)
    loss = measure_stage("separation", y, dulled, SR, 1.0, onsets, note="n")
    assert loss.air_delta_db < 0
    assert loss.air_loss_db == abs(loss.air_delta_db)
    assert loss.to_json()["stage"] == "separation"
    # a stage that adds fizz is measured as a loss too
    fizzy = (y + 0.02 * np.random.default_rng(0).standard_normal(y.size)).astype(np.float32)
    assert measure_stage("stretch", y, fizzy, SR).air_loss_db > 0
