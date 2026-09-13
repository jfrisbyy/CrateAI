import numpy as np
import pytest

from lockedgroove.combine.align import AlignItem, apply_plan, plan_alignment, semitone_shift, time_stretch
from lockedgroove.combine.layer import Lane, render_layer, soft_limit
from lockedgroove.testing.synth import Pattern, chord_progression, drum_loop, triad

SR = 22050


def test_plan_defaults_to_first_item_and_skips_pitch_on_drums():
    sample = AlignItem("s", bpm=88.0, first_downbeat_s=0.5, tonic="F", mode="minor")
    drums = AlignItem("d", bpm=96.0, first_downbeat_s=0.0, tonic="A", mode="minor", kind="stem", tags=["drums"])
    plan = plan_alignment([sample, drums])
    assert plan.target_bpm == 88.0 and plan.target_tonic == "F"
    s, d = plan.items
    assert s.stretch_ratio == 1.0 and s.pitch_semitones == 0.0 and abs(s.offset_s + 0.5) < 1e-9
    assert abs(d.stretch_ratio - 88 / 96) < 1e-9
    assert d.pitch_semitones == 0.0 and "non-tonal" in d.reason


def test_plan_pitch_matches_nearest_key():
    assert semitone_shift("A", "F") == -4 and semitone_shift("F", "A") == 4 and semitone_shift("C", "F#") == 6
    a = AlignItem("a", bpm=90.0, tonic="F", mode="minor")
    b = AlignItem("b", bpm=90.0, tonic="G", mode="minor")
    plan = plan_alignment([a, b], target_key=("F", "minor"))
    assert plan.items[1].pitch_semitones == -2.0


def test_time_stretch_changes_length_by_ratio():
    y = drum_loop(96.0, 2, Pattern.four_on_floor(), SR)
    out = time_stretch(y, SR, 96 / 88, engine="librosa")
    assert out.shape[0] == 1
    assert abs(out.shape[1] - len(y) * 88 / 96) < 0.02 * len(y)


def test_two_loops_combine_on_the_target_grid():
    """Two loops at 88 and 96 BPM combine to a render whose grid reads as 88 (BUILD_PACKET section 9 test)."""
    y88 = chord_progression([triad("F", "minor"), triad("G#", "major")] * 2, 4, 88.0, SR, repeats=1)
    y96 = drum_loop(96.0, 4, Pattern.four_on_floor(), SR)
    items = [AlignItem("a", bpm=88.0, tonic="F", mode="minor"),
             AlignItem("b", bpm=96.0, tonic=None, mode=None, tonal=False, tags=["drums"])]
    plan = plan_alignment(items)
    a = apply_plan(y88, SR, plan.items[0], engine="librosa")
    b = apply_plan(y96, SR, plan.items[1], engine="librosa")
    mix = render_layer([Lane(a, gain_db=-6, lowpass_hz=4000), Lane(b, gain_db=0, highpass_hz=60)], SR)
    assert mix.shape[0] == 2 and np.max(np.abs(mix)) <= 0.98 + 1e-6
    pytest.importorskip("lockedgroove.analysis.tempo")
    from lockedgroove.pipeline import analyze_array

    report = analyze_array(mix, SR, stages=["tempo", "beats"])
    if report.tempo is not None:
        assert min(abs(report.tempo.bpm - 88.0), abs(report.tempo.bpm - 176.0), abs(report.tempo.bpm - 44.0)) < 2.0
        assert report.tempo.confidence > 0.9


def test_render_layer_offsets_gains_and_mute():
    one = np.ones((1, SR), dtype=np.float32) * 0.5
    lanes = [Lane(one, offset_s=0.0), Lane(one, offset_s=0.5, gain_db=-6.0), Lane(one, offset_s=0.0, muted=True)]
    out = render_layer(lanes, SR, limiter=False)
    assert out.shape == (2, int(1.5 * SR))
    assert abs(out[0, 100] - 0.5) < 1e-6
    assert abs(out[0, int(0.75 * SR)] - (0.5 + 0.5 * 10 ** (-6 / 20))) < 1e-5
    assert abs(out[0, int(1.25 * SR)] - 0.5 * 10 ** (-6 / 20)) < 1e-5


def test_negative_offset_crops_and_limiter_caps():
    one = np.ones((1, SR), dtype=np.float32)
    out = render_layer([Lane(one, offset_s=-0.5), Lane(one * 0.9)], SR)
    assert out.shape[1] == SR
    assert np.max(np.abs(out)) <= 0.98 + 1e-6
    assert np.max(np.abs(soft_limit(np.array([0.2, 0.7, 1.5, -3.0], dtype=np.float32)))) < 0.98 + 1e-6
    assert soft_limit(np.array([0.2], dtype=np.float32))[0] == pytest.approx(0.2)
