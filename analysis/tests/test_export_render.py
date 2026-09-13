"""The render: sample alignment, silence, resampling and the declick.

The promise the zip makes is that dropping every stem at zero reconstructs
the session. That is an arithmetic claim, so it is asserted at exact sample
indices rather than listened to.
"""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.export.render import (
    CHANNELS,
    DECLICK_S,
    as_stereo,
    declick,
    peak_dbfs,
    region_window,
    render_region,
    render_track,
    resample_to,
    song_samples,
)
from lockedgroove.export.song import Song

SR = 8000


def region(**over):
    base = {"id": "r1", "file_id": "f1", "start_s": 0.0, "duration_s": 1.0, "offset_s": 0.0}
    base.update(over)
    return base


def one_lane(*regions, **track_over):
    track = {"id": "t1", "name": "Drums", "position": 0, "regions": list(regions)}
    track.update(track_over)
    return Song.parse({"name": "S", "bpm": 120.0, "tracks": [track]})


def ramp(n, channels=2, start=0.0):
    """A source whose value at sample i is i/1000 + start: easy to point at."""
    row = (np.arange(n, dtype=np.float32) / 1000.0) + start
    return np.stack([row] * channels)


# --- alignment -----------------------------------------------------------------


def test_a_split_abuts_exactly_with_no_gap_and_no_overlap():
    # Two regions split at a time that is not a whole sample. Rounding the END
    # (not the length) is what makes them meet.
    a = Song.parse({"name": "S", "tracks": [{"id": "t", "name": "n", "regions": [
        region(id="a", start_s=0.0, duration_s=1.00004),
        region(id="b", start_s=1.00004, duration_s=0.5),
    ]}]}).tracks[0].regions
    start_a, len_a = region_window(a[0], SR)
    start_b, len_b = region_window(a[1], SR)
    assert start_a == 0
    assert start_a + len_a == start_b
    assert len_b > 0


def test_every_lane_is_written_at_the_same_length_whatever_is_on_it():
    song = Song.parse({"name": "S", "bpm": 90.0, "tracks": [
        {"id": "t1", "name": "Drums", "position": 0, "regions": [region(duration_s=3.0)]},
        {"id": "t2", "name": "Bass", "position": 1, "regions": [region(id="r2", start_s=1.0, duration_s=0.5)]},
    ]})
    total = song_samples(song, SR)
    sources = {"f1": ramp(SR * 10)}
    lanes = [render_track(t, sources, SR, total) for t in song.tracks]
    assert {lane.shape for lane in lanes} == {(CHANNELS, total)}
    assert total == 3 * SR


def test_a_region_lands_at_its_own_sample_and_the_lane_is_silent_either_side():
    song = one_lane(region(start_s=0.5, duration_s=0.25, offset_s=0.0))
    total = song_samples(song, SR)
    lane = render_track(song.tracks[0], {"f1": np.ones((2, SR * 2), dtype=np.float32)}, SR, total,
                        declick_s=0.0)
    assert np.all(lane[:, : SR // 2] == 0)
    assert np.allclose(lane[:, SR // 2: SR // 2 + SR // 4], 1.0)
    assert lane.shape[-1] == round(0.75 * SR)


def test_a_region_plays_from_its_offset_not_the_files_zero():
    song = one_lane(region(start_s=0.0, duration_s=0.1, offset_s=0.5))
    lane = render_track(song.tracks[0], {"f1": ramp(SR * 2)}, SR, song_samples(song, SR), declick_s=0.0)
    assert lane[0, 0] == pytest.approx((0.5 * SR) / 1000.0)


def test_two_overlapping_regions_on_one_lane_both_sound():
    # The scheduler keys pieces by region, so two takes on one lane both play;
    # a DAW that trimmed the one underneath would be making the arrangement
    # decision for the producer.
    song = one_lane(region(id="a", start_s=0.0, duration_s=1.0), region(id="b", start_s=0.5, duration_s=1.0))
    lane = render_track(song.tracks[0], {"f1": np.ones((2, SR * 4), dtype=np.float32)}, SR,
                        song_samples(song, SR), declick_s=0.0)
    assert lane[0, SR // 4] == pytest.approx(1.0)
    assert lane[0, int(0.75 * SR)] == pytest.approx(2.0)


def test_asking_for_audio_past_the_end_of_the_record_gives_silence_not_an_error():
    song = one_lane(region(start_s=0.0, duration_s=1.0, offset_s=0.9))
    lane = render_track(song.tracks[0], {"f1": np.ones((2, SR), dtype=np.float32)}, SR,
                        song_samples(song, SR), declick_s=0.0)
    assert lane[0, 0] == pytest.approx(1.0)
    assert lane[0, -1] == 0.0


def test_a_region_beyond_the_songs_end_never_writes_past_the_buffer():
    song = one_lane(region(id="a", start_s=0.0, duration_s=2.0), region(id="b", start_s=1.5, duration_s=2.0))
    total = round(1.0 * SR)  # deliberately shorter than the song
    lane = render_track(song.tracks[0], {"f1": np.ones((2, SR * 8), dtype=np.float32)}, SR, total)
    assert lane.shape[-1] == total


# --- gain ---------------------------------------------------------------------


def test_lane_gain_and_region_gain_are_both_baked_in():
    song = one_lane(region(gain=0.5), gain=0.5)
    lane = render_track(song.tracks[0], {"f1": np.ones((2, SR * 2), dtype=np.float32)}, SR,
                        song_samples(song, SR), track_gain=song.tracks[0].gain, declick_s=0.0)
    assert lane[0, SR // 2] == pytest.approx(0.25)


def test_peak_is_measured_not_normalised():
    song = one_lane(region(gain=2.0))
    lane = render_track(song.tracks[0], {"f1": np.full((2, SR * 2), 0.8, dtype=np.float32)}, SR,
                        song_samples(song, SR), declick_s=0.0)
    assert float(np.max(lane)) == pytest.approx(1.6)  # nothing limits or normalises
    assert peak_dbfs(lane) == pytest.approx(20 * np.log10(1.6), abs=1e-4)
    assert peak_dbfs(np.zeros((2, 10), dtype=np.float32)) == float("-inf")


# --- resampling ----------------------------------------------------------------


def test_a_resampled_region_eats_the_record_faster_and_still_fills_its_window():
    song = one_lane(region(duration_s=1.0, rate=2.0))
    lane = render_track(song.tracks[0], {"f1": ramp(SR * 4)}, SR, song_samples(song, SR), declick_s=0.0)
    assert lane.shape[-1] == SR
    # rate 2 consumes two seconds of the record in one second of song, so the
    # song's halfway point is the record's one-second mark. (The very last
    # sample is not asserted: a band-limited resampler rings at the end of a
    # ramp, which is a property of the test signal, not of the render.)
    assert lane[0, SR // 2] == pytest.approx(SR / 1000.0, rel=1e-4)


def test_resampling_moves_pitch_with_tempo_the_way_a_sampler_does():
    hz = 200.0
    tone = np.sin(2 * np.pi * hz * np.arange(SR * 4, dtype=np.float32) / SR).astype(np.float32)
    song = one_lane(region(duration_s=1.0, rate=2.0))
    lane = render_track(song.tracks[0], {"f1": np.stack([tone, tone])}, SR, song_samples(song, SR),
                        declick_s=0.0)
    spectrum = np.abs(np.fft.rfft(lane[0].astype(np.float64)))
    peak_hz = float(np.fft.rfftfreq(lane.shape[-1], 1 / SR)[int(np.argmax(spectrum))])
    assert peak_hz == pytest.approx(2 * hz, rel=0.02)


def test_resample_to_always_returns_exactly_the_asked_for_length():
    for n_in, n_out in [(1000, 1037), (1037, 1000), (1, 50), (4096, 4096), (10, 3)]:
        out = resample_to(np.ones((2, n_in), dtype=np.float32), n_out)
        assert out.shape == (2, n_out), (n_in, n_out)


def test_resample_falls_back_to_interpolation_when_the_dsp_stack_is_missing(monkeypatch):
    import builtins

    real_import = builtins.__import__

    def no_librosa(name, *args, **kwargs):
        if name == "librosa":
            raise ModuleNotFoundError("librosa")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_librosa)
    out = resample_to(np.stack([np.linspace(0, 1, 100, dtype=np.float32)] * 2), 200)
    assert out.shape == (2, 200)
    assert out[0, 0] == pytest.approx(0.0) and out[0, -1] == pytest.approx(1.0)


# --- the declick ---------------------------------------------------------------


def test_the_export_applies_the_same_2ms_ramp_the_session_plays_with():
    n = SR
    y = np.ones((2, n), dtype=np.float32)
    faded = declick(y.copy(), SR)
    fade = int(DECLICK_S * SR + 0.5)
    assert faded[0, 0] < 1.0 and faded[0, fade - 1] == pytest.approx(1.0)
    assert faded[0, -1] < 1.0 and faded[0, n - fade] == pytest.approx(1.0)
    assert np.allclose(faded[0, fade:n - fade], 1.0)


def test_the_ramp_never_swallows_a_region_shorter_than_itself():
    y = np.ones((2, 4), dtype=np.float32)
    faded = declick(y.copy(), SR)
    assert faded.shape == (2, 4)
    assert float(np.max(faded)) > 0


def test_a_declick_of_zero_leaves_the_material_exactly_alone():
    y = np.ones((2, 100), dtype=np.float32)
    assert np.array_equal(declick(y.copy(), SR, 0.0), y)


# --- shapes --------------------------------------------------------------------


def test_a_mono_record_comes_out_stereo_so_a_daw_never_has_to_guess():
    mono = np.ones((SR,), dtype=np.float32)
    assert as_stereo(mono).shape == (2, SR)
    song = one_lane(region())
    lane = render_track(song.tracks[0], {"f1": mono}, SR, song_samples(song, SR))
    assert lane.shape[0] == CHANNELS


def test_more_than_two_channels_is_taken_down_to_two():
    assert as_stereo(np.ones((4, 100), dtype=np.float32)).shape == (2, 100)


def test_a_region_whose_source_was_never_loaded_is_a_loud_failure_not_silence():
    song = one_lane(region(file_id="missing"))
    with pytest.raises(KeyError, match="missing"):
        render_track(song.tracks[0], {}, SR, song_samples(song, SR))


def test_rendering_a_region_does_not_modify_the_source_array():
    source = np.ones((2, SR * 2), dtype=np.float32)
    before = source.copy()
    song = one_lane(region(gain=0.5))
    render_region(source, SR, song.tracks[0].regions[0], gain=0.5)
    assert np.array_equal(source, before)
