"""combine/align.py: the stretcher has to be measurably better than the phase vocoder.

The product fits one record to another constantly, and the ratios that takes are
0.73 to 0.85. The plain phase vocoder smears them: measured on a break under a
tonal bed it keeps a little over half of each onset's sharpness. These tests are
the gate that keeps the engine that replaced it honest - and they run against the
in-repo phase-locked vocoder too, so the guarantee does not depend on an optional
dependency being installed.
"""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.combine.align import (
    ENGINES,
    ItemPlan,
    apply_plan,
    available_engines,
    engine_installed,
    is_coupled,
    pitch_shift,
    reset_engine_cache,
    stretch_and_shift,
    stretch_engine,
    time_stretch,
    varispeed,
)
from lockedgroove.quality.fixtures import transient_bed
from lockedgroove.quality.metrics import air_db, transient_retention

SR = 44100
RATIOS = (0.73, 0.83)
# What the phase vocoder manages on this fixture; anything we ship must clear it.
LIBROSA_CEILING = 0.65


@pytest.fixture(scope="module")
def bed():
    return transient_bed(SR)


def _kept(y, onsets, ratio, engine):
    out = stretch_and_shift(y, SR, ratio, 0.0, engine=engine)[0]
    return transient_retention(y, out, SR, ratio, onsets), air_db(out, SR) - air_db(y, SR)


@pytest.mark.parametrize("ratio", RATIOS)
def test_the_default_engine_beats_the_phase_vocoder_on_transients(bed, ratio):
    y, onsets = bed
    chosen = stretch_engine()
    mine, _ = _kept(y, onsets, ratio, chosen)
    theirs, _ = _kept(y, onsets, ratio, "librosa")
    assert theirs < LIBROSA_CEILING, "the baseline moved; re-measure before trusting the gate"
    assert mine > theirs + 0.05, f"{chosen} kept {mine:.3f} of the onsets, librosa kept {theirs:.3f}"


@pytest.mark.parametrize("ratio", RATIOS)
def test_the_in_repo_vocoder_alone_already_beats_it(bed, ratio):
    """No optional dependency involved: this is the floor the product can always stand on."""
    y, onsets = bed
    mine, air = _kept(y, onsets, ratio, "phase_locked")
    theirs, _ = _kept(y, onsets, ratio, "librosa")
    assert mine > theirs + 0.05
    assert mine > 0.70
    assert abs(air) < 0.5


@pytest.mark.parametrize("ratio", RATIOS)
def test_no_engine_we_ship_moves_the_air_band(bed, ratio):
    """A stretcher has no business changing the spectrum; the vocoder does, by up to 0.9 dB."""
    y, onsets = bed
    for engine in [e for e in ENGINES if e != "varispeed" and engine_installed(e) and e != "librosa"]:
        _, air = _kept(y, onsets, ratio, engine)
        assert abs(air) < 0.5, f"{engine} moved 8-20 kHz by {air:+.2f} dB"


def test_lengths_are_exactly_the_ratio(bed):
    y, _ = bed
    for engine in [e for e in ENGINES if e != "varispeed" and engine_installed(e)]:
        for ratio in (*RATIOS, 1.18):
            out = time_stretch(y, SR, ratio, engine=engine)
            assert out.shape[0] == 1
            assert abs(out.shape[1] - y.size / ratio) < 0.02 * y.size, engine


def test_pitch_shift_keeps_the_length_and_moves_the_pitch(bed):
    from lockedgroove.testing import synth

    tone = synth.sine(440.0, 2.0, SR, amplitude=0.5)
    for engine in [e for e in ENGINES if e != "varispeed" and engine_installed(e)]:
        out = pitch_shift(tone, SR, 12.0, engine=engine)[0]
        assert abs(out.size - tone.size) < 0.02 * tone.size, engine
        freqs = np.fft.rfftfreq(out.size, 1 / SR)
        peak = freqs[np.argmax(np.abs(np.fft.rfft(out * np.hanning(out.size))))]
        assert abs(peak - 880.0) < 25.0, f"{engine} landed on {peak:.0f} Hz"


def test_a_coupled_move_is_a_resample_and_loses_nothing(bed):
    """Speeding a record up and letting the pitch follow is a turntable, not a stretcher."""
    y, onsets = bed
    assert is_coupled(2.0, 12.0) and is_coupled(0.5, -12.0)
    assert not is_coupled(0.83, 0.0)
    out = stretch_and_shift(y, SR, 1.5, 12.0 * np.log2(1.5))[0]
    assert abs(out.size - y.size / 1.5) < 0.01 * y.size
    # a resample keeps the onsets intact: nothing is being reconstructed
    assert transient_retention(y, out, SR, 1.5, onsets) > 0.9
    assert np.allclose(out, varispeed(y, SR, 1.5)[0])


@pytest.mark.parametrize("ratio,semitones", [(0.83, 3.0), (0.73, 6.0)])
def test_stretch_and_shift_in_one_pass_is_never_worse_than_two(bed, ratio, semitones):
    """Stretching and then shifting runs the signal through the same smearing twice."""
    y, onsets = bed
    one = stretch_and_shift(y, SR, ratio, semitones)[0]
    two = pitch_shift(time_stretch(y, SR, ratio), SR, semitones)[0]
    kept_one = transient_retention(y, one, SR, ratio, onsets)
    kept_two = transient_retention(y, two, SR, ratio, onsets)
    assert kept_one > kept_two - 0.08
    assert abs(one.size - y.size / ratio) < 0.02 * y.size


@pytest.mark.parametrize("ratio,semitones", [(0.83, 3.0), (0.73, 6.0)])
def test_the_in_repo_vocoder_gains_the_most_from_the_single_pass(bed, ratio, semitones):
    """It stretches once and resamples for the pitch, instead of vocoding twice."""
    y, onsets = bed
    one = stretch_and_shift(y, SR, ratio, semitones, engine="phase_locked")[0]
    two = pitch_shift(time_stretch(y, SR, ratio, engine="phase_locked"), SR, semitones,
                      engine="phase_locked")[0]
    assert (transient_retention(y, one, SR, ratio, onsets)
            > transient_retention(y, two, SR, ratio, onsets) + 0.03)


def test_apply_plan_uses_both_values():
    plan = ItemPlan(file_id="f", stretch_ratio=0.9, pitch_semitones=2.0, offset_s=0.0, reason="")
    y = np.zeros((2, SR), dtype=np.float32)
    y[:, ::1000] = 1.0
    out = apply_plan(y, SR, plan)
    assert out.shape[0] == 2
    assert abs(out.shape[1] - SR / 0.9) < 0.02 * SR


def test_engine_selection_prefers_quality_and_never_picks_the_vocoder():
    reset_engine_cache()
    chosen = stretch_engine()
    assert chosen != "librosa"
    assert chosen == available_engines()[0]
    assert "phase_locked" in available_engines(), "the floor must always be available"
    with pytest.raises(ValueError):
        stretch_engine("nope")


def test_identity_and_empty_are_left_alone():
    y = np.zeros((2, 100), dtype=np.float32)
    assert np.array_equal(stretch_and_shift(y, SR, 1.0, 0.0), y)
    assert stretch_and_shift(np.zeros((2, 0), dtype=np.float32), SR, 0.8, 0.0).shape == (2, 0)
    with pytest.raises(ValueError):
        time_stretch(y, SR, -1.0)
