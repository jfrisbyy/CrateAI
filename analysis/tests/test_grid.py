"""Pure grid helpers: bar grid, 16th grid, nearest-grid offsets, bar index."""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.analysis import grid
from lockedgroove.report import _beats_per_bar

BEAT = 60.0 / 90.0


def _beats(n: int = 16, offset: float = 0.0) -> np.ndarray:
    return offset + np.arange(n) * BEAT


@pytest.mark.parametrize("meter,expected", [("4/4", 4), ("3/4", 3), ("6/8", 2), ("5/4", 5), ("7/8", 7), ("garbage", 4), ("", 4)])
def test_beats_per_bar_matches_report(meter, expected):
    assert grid.beats_per_bar(meter) == expected
    assert grid.beats_per_bar(meter) == _beats_per_bar(meter)


def test_beat_period_is_median_interval():
    beats = _beats(8)
    assert grid.beat_period_s(beats) == pytest.approx(BEAT)
    assert grid.beat_period_s(np.array([1.0])) == 0.0
    assert grid.beat_period_s(np.array([])) == 0.0


def test_extend_beats_covers_the_file():
    beats = _beats(8, offset=2.0)  # 2.0 .. 6.67
    ext = grid.extend_beats(beats, duration_s=10.0)
    assert ext[0] <= 0.0 + 1e-9 or ext[0] < BEAT  # a grid point at or before the first beat period
    assert ext[-1] >= 10.0 - BEAT - 1e-6
    assert np.allclose(np.diff(ext), BEAT, atol=1e-6)
    # the original beats are still on the grid
    for b in beats:
        assert np.min(np.abs(ext - b)) < 1e-6


def test_bar_grid_from_downbeats_and_extrapolation():
    beats = _beats(16)
    downbeats = beats[1::4]  # phase 1
    bars = grid.bar_grid(beats, downbeats, meter="4/4", duration_s=16 * BEAT)
    # bar starts are the downbeats, extended to cover the whole file
    assert bars[0] == pytest.approx(BEAT)  # a negative extrapolated bar start is dropped
    assert np.allclose(np.diff(bars), 4 * BEAT, atol=1e-6)
    assert bars[-1] < 16 * BEAT
    assert bars[-1] + 4 * BEAT >= 16 * BEAT - 1e-9


def test_bar_grid_without_downbeats_uses_beats():
    beats = _beats(12)
    bars = grid.bar_grid(beats, [], meter="3/4", duration_s=12 * BEAT)
    assert np.allclose(bars, beats[::3])


def test_bar_index_and_partial_pickup():
    bars = np.array([1.0, 3.0, 5.0])
    assert grid.bar_index(0.5, bars) == 0  # pickup before the first bar joins bar 0
    assert grid.bar_index(1.0, bars) == 0
    assert grid.bar_index(2.99, bars) == 0
    assert grid.bar_index(3.0, bars) == 1
    assert grid.bar_index(99.0, bars) == 2
    assert grid.bar_indices([0.5, 3.5, 6.0], bars).tolist() == [0, 1, 2]
    assert grid.bar_index(1.0, np.array([])) == 0


def test_sixteenth_grid_straight():
    beats = _beats(4)
    g = grid.sixteenth_grid(beats)
    expected = np.arange(0, 4 * 4) * BEAT / 4  # covers up to the extrapolated 4th beat
    assert len(g) >= 16
    assert np.allclose(g[:16], expected, atol=1e-6)


def test_sixteenth_grid_swung_matches_synth_convention():
    from lockedgroove.testing.synth import step_time_in_beat

    beats = _beats(2)
    g = grid.sixteenth_grid(beats, swing_pct=62.0)
    for step in range(4):
        assert g[step] == pytest.approx(step_time_in_beat(step, 62.0) * BEAT, abs=1e-6)
    assert grid.step_fraction(2, 66.7) == pytest.approx(0.667)
    assert grid.step_fraction(1, 50.0) == pytest.approx(0.25)


def test_sixteenth_grid_extends_to_cover_duration():
    beats = _beats(4, offset=1.0)
    g = grid.sixteenth_grid(beats, extend_to_s=6.0)
    assert g[0] <= BEAT / 4 + 1e-9  # extrapolated backwards to (near) zero
    assert g[-1] >= 6.0 - BEAT / 4 - 1e-9
    assert np.all(np.diff(g) > 0)


def test_nearest_grid_offsets_sign_and_magnitude():
    g = np.array([0.0, 0.5, 1.0, 1.5])
    offsets, idx = grid.nearest_grid_offsets_ms([0.02, 0.48, 1.0, 1.7], g)
    assert offsets.tolist() == pytest.approx([20.0, -20.0, 0.0, 200.0], abs=1e-6)
    assert idx.tolist() == [0, 1, 2, 3]
    offsets, idx = grid.nearest_grid_offsets_ms([], g)
    assert offsets.size == 0 and idx.size == 0


def test_beat_positions():
    beats = _beats(4)
    bidx, frac = grid.beat_positions([0.0, BEAT * 0.5, BEAT * 1.25, BEAT * 3.9], beats)
    assert bidx.tolist() == [0, 0, 1, 3]
    assert frac.tolist() == pytest.approx([0.0, 0.5, 0.25, 0.9], abs=1e-6)
    # before the first beat and after the last beat are clipped to the edge beats
    bidx, frac = grid.beat_positions([-0.1, 10.0], beats)
    assert bidx.tolist() == [0, 3]
