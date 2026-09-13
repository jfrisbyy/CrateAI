import numpy as np
import soundfile as sf

from lockedgroove.ingest import compute_peaks, file_info_for, load_audio, sha256_file
from lockedgroove.pipeline import analyze_array, to_mono
from lockedgroove.testing.synth import click_track


def test_load_audio_roundtrip(tmp_path):
    sr = 44100
    y = np.stack([click_track(120, 2.0, sr), click_track(120, 2.0, sr) * 0.5])
    path = tmp_path / "clicks.wav"
    sf.write(path, y.T, sr, subtype="PCM_24")
    loaded, lsr = load_audio(str(path))
    assert lsr == sr
    assert loaded.shape == (2, sr * 2)
    mono, _ = load_audio(str(path), mono=True)
    assert mono.shape == (sr * 2,)
    info = file_info_for(str(path), loaded, lsr)
    assert info.channels == 2 and info.format == "wav" and abs(info.duration_s - 2.0) < 1e-6
    assert len(sha256_file(str(path))) == 64


def test_peaks_shape_and_range():
    y = click_track(120, 1.0)
    peaks = compute_peaks(y, points=100)
    assert peaks["points"] == 100 and len(peaks["min"]) == 100 and len(peaks["max"]) == 100
    assert min(peaks["min"]) >= -1.0 and max(peaks["max"]) <= 1.0
    assert max(peaks["max"]) > 0.5


def test_to_mono_accepts_both_layouts():
    y = np.random.default_rng(0).standard_normal((2, 100)).astype(np.float32)
    assert to_mono(y).shape == (100,)
    assert to_mono(y.T).shape == (100,)


def test_pipeline_unknown_stage_rejected():
    import pytest

    with pytest.raises(ValueError):
        analyze_array(click_track(120, 1.0), 22050, stages=["nope"])


def test_pipeline_survives_missing_stage_module():
    # stage modules land in Phase 0/4; until then the report ships with the section None
    report, ctx = analyze_array(click_track(120, 1.0), 22050, stages=["tags"], return_context=True)
    assert report.file.duration_s > 0
    assert report.tags == [] or ctx.errors.get("tags")
