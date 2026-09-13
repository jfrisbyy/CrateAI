import numpy as np
import pytest

from lockedgroove.analysis.beat_tracking import available_backends, default_backend, track_beats
from lockedgroove.testing.synth import click_track

SR = 22050


def test_librosa_backend_tracks_a_click():
    y = click_track(120.0, 8.0, SR)
    res = track_beats(y, SR, backend="librosa", start_bpm=120.0)
    assert abs(res.bpm - 120.0) < 2.0
    assert len(res.beats_s) >= 14
    spacing = np.diff(res.beats_s)
    assert abs(float(np.median(spacing)) - 0.5) < 0.03
    assert res.downbeats_s is None and res.method.startswith("librosa")


def test_unknown_backend_and_default():
    with pytest.raises(ValueError):
        track_beats(click_track(100, 2.0, SR), SR, backend="madmom")
    assert default_backend() in available_backends()
    assert "librosa" in available_backends()


def test_beatnet_falls_back_when_missing(monkeypatch):
    if "beatnet" in available_backends():
        pytest.skip("BeatNet installed; fallback path not exercised")
    res = track_beats(click_track(100, 3.0, SR), SR, backend="beatnet")
    assert any("used librosa" in n for n in res.notes)
    assert abs(res.bpm - 100.0) < 2.0 or abs(res.bpm - 200.0) < 2.0 or abs(res.bpm - 50.0) < 2.0


def test_short_audio_does_not_raise():
    res = track_beats(np.zeros(100, dtype=np.float32), SR, backend="librosa")
    assert res.beats_s == [] and res.notes
