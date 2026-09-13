"""Export naming: ``{base}[_{stem}]_{bpm}bpm_{key}_{bars}bar.wav`` (OPEN_QUESTIONS D.18, C.13)."""

import pytest

from lockedgroove.loops.naming import bpm_token, key_token, loop_filename, sanitize_base


def test_packet_example():
    assert loop_filename("song", 90, "F", "minor", 4) == "song_90bpm_Fm_4bar.wav"


def test_stem_goes_after_base():
    assert loop_filename("song", 90, "F", "minor", 4, stem="drums") == "song_drums_90bpm_Fm_4bar.wav"


@pytest.mark.parametrize("bpm,token", [
    (90, "90bpm"), (90.0, "90bpm"), (90.04, "90bpm"), (89.96, "90bpm"), (90.05, "90bpm"),
    (92.5, "92.5bpm"), (90.06, "90.1bpm"), (174.25, "174.2bpm"), (90.9, "90.9bpm"), (90.96, "91bpm"),
])
def test_bpm_rounding(bpm, token):
    assert bpm_token(bpm) == token


def test_bpm_must_be_positive():
    with pytest.raises(ValueError):
        bpm_token(0)


@pytest.mark.parametrize("tonic,mode,token", [
    ("F", "minor", "Fm"), ("A#", "major", "Bb"), ("C#", "minor", "C#m"), ("D#", "minor", "Ebm"),
    ("C", "major", "C"), ("C#", "major", "Db"), ("D#", "major", "Eb"), ("F#", "major", "F#"),
    ("G#", "major", "Ab"), ("G#", "minor", "G#m"), ("A#", "minor", "Bbm"), ("F#", "minor", "F#m"),
    ("B", "minor", "Bm"), ("E", "major", "E"),
])
def test_key_spelling(tonic, mode, token):
    assert key_token(tonic, mode) == token


def test_key_accepts_flat_input_and_unicode_accidentals():
    assert key_token("Bb", "major") == "Bb"
    assert key_token("Eb", "minor") == "Ebm"
    assert key_token("A♯", "major") == "Bb"
    assert key_token("f", "min") == "Fm"


def test_key_rejects_garbage():
    with pytest.raises(ValueError):
        key_token("H", "major")
    with pytest.raises(ValueError):
        key_token("C", "dorian")


@pytest.mark.parametrize("raw,clean", [
    ("My Song", "My-Song"), ("my song.wav", "my-song"), ("Take  2 (final).aiff", "Take-2-final"),
    ("weird/name:with*chars?", "namewithchars"), ("C# groove", "C#-groove"), ("../../etc/passwd", "passwd"),
    ("   ", "loop"), ("", "loop"), ("song.v2", "song.v2"), ("--dashes--", "dashes"),
])
def test_sanitize_base(raw, clean):
    # paths reduce to their basename first (no traversal into export paths), then the character rules apply
    assert sanitize_base(raw) == clean


def test_sanitize_caps_length():
    assert len(sanitize_base("x" * 300)) <= 80


def test_full_name_with_messy_base_and_extension():
    assert loop_filename("Dusty Rhodes (take 3).flac", 92.5, "A#", "major", 2, ext=".WAV") == \
        "Dusty-Rhodes-take-3_92.5bpm_Bb_2bar.wav"


def test_missing_bpm_or_key_are_omitted_not_invented():
    assert loop_filename("song", None, "F", "minor", 4) == "song_Fm_4bar.wav"
    assert loop_filename("song", 90, None, None, 1) == "song_90bpm_1bar.wav"
    assert loop_filename("song", None, None, None, 8) == "song_8bar.wav"


def test_only_allowed_characters_survive():
    import re

    name = loop_filename("a b\tcéd!@$%^&*()[]{};'\",<>", 100, "G#", "minor", 4, stem="other stem")
    assert re.fullmatch(r"[A-Za-z0-9._#-]+", name), name
    assert name == "a-b-cd_other-stem_100bpm_G#m_4bar.wav"
