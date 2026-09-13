import numpy as np
import pytest
import soundfile as sf

from lockedgroove.stems.separate import MODELS, FakeSeparator, StemAudio, separate_file, stem_name_from_filename
from lockedgroove.testing.synth import Pattern, chord_progression, drum_loop, mix, triad

SR = 22050


def test_stem_names_parse_from_audio_separator_outputs():
    assert stem_name_from_filename("song_(Drums)_htdemucs_ft.wav") == "drums"
    assert stem_name_from_filename("song_(No Vocals)_bs.wav") == "instrumental"
    assert stem_name_from_filename("song_(Instrumental)_bs.wav") == "instrumental"
    assert stem_name_from_filename("song.wav") is None


def test_fake_separator_returns_every_stem_for_each_model(tmp_path):
    y = mix(drum_loop(90, 2, Pattern.boom_bap(), SR), chord_progression([triad("F", "minor")], 4, 90, SR, repeats=2))
    path = tmp_path / "mix.wav"
    sf.write(path, np.stack([y, y]).T, SR)
    for model, spec in MODELS.items():
        stems = separate_file(str(path), model, backend=FakeSeparator())
        assert [s.name for s in stems] == spec["stems"]
        for s in stems:
            assert s.y.shape == (2, len(y)) and s.sr == SR
    # the low band lands in the bass stem
    stems = {s.name: s for s in separate_file(str(path), "htdemucs_ft", backend=FakeSeparator())}
    assert np.abs(stems["bass"].y).mean() < np.abs(stems["other"].y).mean() + 1.0


def test_unknown_model_and_missing_stems():
    with pytest.raises(ValueError):
        separate_file("x.wav", "nope", backend=FakeSeparator())

    class Broken:
        def separate(self, path, model):
            return [StemAudio("drums", np.zeros((2, 10), np.float32), SR)]

    with pytest.raises(RuntimeError):
        separate_file("x.wav", "htdemucs_ft", backend=Broken())
