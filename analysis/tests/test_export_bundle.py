"""Naming, the size cap, the tempo map, the readme and the zip's layout.

Everything a producer sees before they open a single file.
"""

from __future__ import annotations

import io
import zipfile

import pytest

from lockedgroove.export.bundle import (
    DEFAULT_BIT_DEPTH,
    EXPORT_CAP_BYTES,
    ExportPlan,
    ExportTooLargeError,
    HeldBackEntry,
    MidiEntry,
    StemEntry,
    assert_under_cap,
    cap_advice,
    estimate_bytes,
    human_bytes,
    pcm_bytes,
    write_zip,
)
from lockedgroove.export.naming import (
    folder_name,
    midi_filename,
    safe_token,
    stem_filename,
    unique_names,
    zip_filename,
)
from lockedgroove.export.readme import fmt_db, fmt_time, manifest_payload, render_readme
from lockedgroove.export.song import Song
from lockedgroove.export.tempo_map import TICKS_PER_BEAT, TempoEvent, tempo_map_midi, tempo_map_text

# --- naming -------------------------------------------------------------------


def test_a_stem_is_named_so_a_folder_listing_is_the_lane_order():
    names = [stem_filename(i + 1, n, 92.0, "F", "minor") for i, n in enumerate(["Drums", "Bass", "Horns"])]
    assert names == ["01_Drums_92bpm_Fm.flac", "02_Bass_92bpm_Fm.flac", "03_Horns_92bpm_Fm.flac"]
    assert sorted(names) == names


def test_the_key_is_spelled_the_way_the_rest_of_the_product_spells_it():
    assert stem_filename(1, "Keys", 90.0, "D#", "major") == "01_Keys_90bpm_Eb.flac"
    assert stem_filename(1, "Keys", 90.0, "C#", "minor") == "01_Keys_90bpm_C#m.flac"


def test_a_tempo_or_key_nobody_measured_is_left_out_rather_than_invented():
    assert stem_filename(1, "Drums", None, None, None) == "01_Drums.flac"
    assert stem_filename(2, "Drums", 92.0, None, None) == "02_Drums_92bpm.flac"
    assert folder_name("My Song", None, None, None) == "My-Song"


def test_a_lane_name_that_is_not_a_filename_becomes_one():
    assert safe_token("Horns / Trumpet (take 2)") == "Horns-Trumpet-take-2"
    assert safe_token("") == "track"
    assert safe_token("../../etc/passwd") == "etc-passwd"
    assert "/" not in safe_token("a/b") and safe_token("a/b") == "a-b"
    assert stem_filename(1, "  ", 92.0, "F", "minor") == "01_track_92bpm_Fm.flac"


def test_two_lanes_with_the_same_name_do_not_overwrite_each_other():
    names = [stem_filename(1, "Drums", 92, "F", "minor"), stem_filename(1, "Drums", 92, "F", "minor")]
    assert unique_names(names) == ["01_Drums_92bpm_Fm.flac", "01_Drums_92bpm_Fm-2.flac"]


def test_wav_and_flac_share_every_token_but_the_extension():
    assert stem_filename(1, "Drums", 92.0, "F", "minor", "wav") == "01_Drums_92bpm_Fm.wav"
    assert midi_filename(3, "Horns", "melody") == "03_Horns_melody.mid"
    assert zip_filename("Midnight Flip", 92.0, "F", "minor") == "Midnight-Flip_92bpm_Fm_stems.zip"


# --- the size cap --------------------------------------------------------------


def test_the_hard_case_in_the_brief_fits_as_flac_and_the_arithmetic_is_visible():
    # ten lanes, four minutes, 24-bit stereo at 44.1 kHz
    raw = pcm_bytes(10, 240.0, 44100, 2, 24)
    assert raw == 10 * 240 * 44100 * 2 * 3 == 635_040_000
    assert estimate_bytes(10, 240.0, 44100, 2, 24, "flac") < EXPORT_CAP_BYTES
    assert estimate_bytes(10, 240.0, 44100, 2, 24, "wav") < EXPORT_CAP_BYTES
    assert estimate_bytes(10, 240.0, 44100, 2, 16, "flac") < estimate_bytes(10, 240.0, 44100, 2, 24, "flac")


def test_flac_is_estimated_smaller_than_wav_for_the_same_song():
    assert estimate_bytes(8, 180.0, 44100, 2, 24, "flac") < estimate_bytes(8, 180.0, 44100, 2, 24, "wav")


def test_a_song_over_the_cap_is_refused_with_both_numbers_and_something_to_do():
    huge = estimate_bytes(24, 900.0, 48000, 2, 24, "wav")
    assert huge > EXPORT_CAP_BYTES
    with pytest.raises(ExportTooLargeError) as exc:
        assert_under_cap(huge, detail=cap_advice("wav", 24))
    message = str(exc.value)
    assert "GB" in message and "cap is" in message
    assert "FLAC" in message and "16-bit" in message


def test_the_advice_does_not_suggest_what_the_caller_already_did():
    assert "FLAC" not in cap_advice("flac", 16)
    assert "16-bit" not in cap_advice("flac", 16)


def test_human_bytes_reads_like_a_size():
    assert human_bytes(1536) == "2 KB"
    assert human_bytes(200 * 1024 * 1024) == "200 MB"
    assert human_bytes(2 * 1024 ** 3) == "2.00 GB"


# --- the tempo map -------------------------------------------------------------


def test_the_tempo_map_is_a_midi_conductor_track_a_daw_can_read():
    mido = pytest.importorskip("mido")
    data = tempo_map_midi([TempoEvent(0.0, 92.0, 4)], 192.0, tonic="F", mode="minor")
    midi = mido.MidiFile(file=io.BytesIO(data))
    assert midi.ticks_per_beat == TICKS_PER_BEAT
    kinds = {m.type for m in midi.tracks[0]}
    assert {"set_tempo", "time_signature", "end_of_track"} <= kinds
    tempo = next(m for m in midi.tracks[0] if m.type == "set_tempo")
    assert mido.tempo2bpm(tempo.tempo) == pytest.approx(92.0, abs=0.01)
    sig = next(m for m in midi.tracks[0] if m.type == "time_signature")
    assert (sig.numerator, sig.denominator) == (4, 4)
    assert next(m for m in midi.tracks[0] if m.type == "key_signature").key == "Fm"
    # it carries the grid and nothing else: no notes to import by accident
    assert not any(m.type in ("note_on", "note_off") for m in midi.tracks[0])


def test_the_tempo_track_ends_where_the_song_ends():
    mido = pytest.importorskip("mido")
    midi = mido.MidiFile(file=io.BytesIO(tempo_map_midi([TempoEvent(0.0, 120.0, 4)], 8.0)))
    assert midi.length == pytest.approx(8.0, abs=0.01)


def test_a_three_four_session_says_so():
    mido = pytest.importorskip("mido")
    midi = mido.MidiFile(file=io.BytesIO(tempo_map_midi([TempoEvent(0.0, 100.0, 3)], 10.0)))
    sig = next(m for m in midi.tracks[0] if m.type == "time_signature")
    assert sig.numerator == 3


def test_the_writer_takes_a_curve_so_a_measured_drift_drops_straight_in():
    mido = pytest.importorskip("mido")
    events = [TempoEvent(0.0, 90.0, 4), TempoEvent(8.0, 120.0, 4)]
    midi = mido.MidiFile(file=io.BytesIO(tempo_map_midi(events, 16.0)))
    tempos = [round(mido.tempo2bpm(m.tempo)) for m in midi.tracks[0] if m.type == "set_tempo"]
    assert tempos == [90, 120]
    assert midi.length == pytest.approx(16.0, abs=0.05)


def test_the_text_map_says_the_same_thing_without_a_midi_library():
    text = tempo_map_text([TempoEvent(0.0, 92.0, 4)], 192.0, sample_rate=44100, tonic="F", mode="minor")
    assert "length_s\t192.000000" in text
    assert "sample_rate\t44100" in text
    assert "key\tFm" in text
    assert "0.000000\t1.0000\t92.0000\t4/4" in text


def test_a_map_with_no_events_is_refused_rather_than_written_empty():
    with pytest.raises(ValueError):
        tempo_map_midi([], 10.0)


# --- the readme ----------------------------------------------------------------


def sample_song():
    return Song.parse({
        "name": "Midnight Flip",
        "bpm": 92.0,
        "beats_per_bar": 4,
        "master_gain": 0.8,
        "key": {"tonic": "F", "mode": "minor", "from_file_name": "Masquerade"},
        "tracks": [
            {"id": "t1", "name": "Drums", "position": 0, "gain": 0.79,
             "provenance": "Masquerade, drums, separated: roformer-x",
             "regions": [{"id": "r1", "file_id": "f1", "start_s": 0.0, "duration_s": 10.4, "offset_s": 24.13,
                          "rate": 0.964,
                          "lineage_line": "Masquerade / drums / bars 9-16 / x0.964",
                          "source_bars": {"from_bar": 9, "to_bar": 16, "bars": 8},
                          "lineage": {"file_name": "Masquerade", "stem": "drums",
                                      "separation_model": "roformer-x",
                                      "separation_model_label": "the strong separator",
                                      "source_bpm": 95.4, "downbeat_s": 0.31,
                                      "reason": "relative minor", "confidence": 0.86}}]},
            {"id": "t2", "name": "Horns", "position": 1, "muted": True,
             "regions": [{"id": "r2", "file_id": "f2", "start_s": 0.0, "duration_s": 4.0, "offset_s": 0.0}]},
        ],
    })


def sample_plan():
    return ExportPlan(
        folder="Midnight-Flip_92bpm_Fm",
        zip_name="Midnight-Flip_92bpm_Fm_stems.zip",
        stems=[StemEntry(position=1, track_id="t1", name="Drums", filename="01_Drums_92bpm_Fm.flac",
                         gain=0.79, muted=False, soloed=False,
                         provenance="Masquerade, drums, separated: roformer-x", peak_dbfs=-3.4)],
        held_back=[HeldBackEntry(position=2, name="Horns", reason="muted", provenance="Moonlight, other")],
        midi=[MidiEntry(midi_id="m1", kind="drums", filename="01_Drums_drums.mid",
                        storage_path="derived/u/f1/midi/drums.mid", source_file_id="f1", lane="Drums")],
        has_tempo_map=True,
    )


def readme_text(**over):
    args = dict(generated_at="2026-09-13 12:00 UTC", fmt="flac", bit_depth=DEFAULT_BIT_DEPTH,
                sample_rate=44100, channels=2, length_samples=458_640,
                tempo_events=[TempoEvent(0.0, 92.0, 4)])
    args.update(over)
    return render_readme(sample_song(), sample_plan(), **args)


def test_the_readme_says_what_the_export_is_and_how_to_drop_it_into_a_daw():
    text = readme_text()
    assert "Midnight Flip" in text
    assert "92 BPM, 4/4" in text
    assert "tempo_map.mid" in text
    assert "00:00:00.000" in text
    assert "458640 samples" in text
    assert "FLAC, 24-bit, 44100 Hz, stereo" in text


def test_the_readme_carries_the_lineage_line_the_browser_derived():
    text = readme_text()
    assert "Masquerade / drums / bars 9-16 / x0.964" in text
    assert "roformer-x" in text
    assert "relative minor" in text and "0.86" in text
    assert "95.4 BPM" in text
    assert "downbeat" in text


def test_the_readme_says_where_each_region_sits_in_the_song_in_bars():
    text = readme_text()
    assert "bar 1.00 ->" in text


def test_the_readme_is_explicit_about_what_is_baked_in_and_what_is_not():
    text = readme_text()
    assert "-2.0 dB (baked in)" in text            # the lane, 0.79 linear
    assert "Master level  -1.9 dB" in text         # 0.8 linear, reported not applied
    assert "NOT baked into the stems" in text
    assert "no limiter" in text and "normalisation" in text


def test_a_muted_lane_is_named_in_the_readme_rather_than_vanishing():
    text = readme_text()
    assert "Not exported" in text
    assert "Horns" in text and "(muted)" in text
    assert "unmute them and export again" in text


def test_a_session_with_no_tempo_says_so_instead_of_inventing_a_grid():
    song = Song.parse({"name": "Sketch", "tracks": [
        {"id": "t1", "name": "Drums", "regions": [
            {"id": "r1", "file_id": "f1", "start_s": 0.0, "duration_s": 4.0, "offset_s": 0.0}]},
    ]})
    plan = ExportPlan(folder="Sketch", zip_name="Sketch_stems.zip",
                      stems=[StemEntry(1, "t1", "Drums", "01_Drums.flac", 1.0, False, False)],
                      has_tempo_map=False)
    text = render_readme(song, plan, generated_at="now", fmt="flac", bit_depth=24, sample_rate=44100,
                         channels=2, length_samples=176400)
    assert "no measured tempo" in text
    assert "tempo_map.mid" not in text
    assert "still line up" in text


def test_the_readme_is_plain_ascii_and_stable():
    text = readme_text()
    text.encode("ascii")  # raises if anything crept in
    assert readme_text() == text


def test_a_clipped_lane_is_shouted_about_because_nothing_here_normalises():
    plan = sample_plan()
    plan.stems[0].peak_dbfs = 1.3
    plan.stems[0].clipped = True
    text = render_readme(sample_song(), plan, generated_at="now", fmt="flac", bit_depth=24,
                         sample_rate=44100, channels=2, length_samples=10)
    assert "CLIPPED" in text and "+1.3 dBFS" in text


def test_the_manifest_carries_the_same_facts_as_data():
    payload = manifest_payload(sample_song(), sample_plan(), generated_at="2026-09-13 12:00 UTC", fmt="flac",
                               bit_depth=24, sample_rate=44100, channels=2, length_samples=458_640,
                               tempo_events=[TempoEvent(0.0, 92.0, 4)])
    assert payload["song"]["bpm"] == 92.0
    assert payload["song"]["master_gain_baked"] is False
    assert payload["audio"]["limiter"] is False and payload["audio"]["declick_ms"] == 2.0
    assert payload["stems"][0]["file"] == "stems/01_Drums_92bpm_Fm.flac"
    assert payload["stems"][0]["gain_baked"] is True
    assert payload["not_exported"][0]["name"] == "Horns"
    assert payload["midi"][0]["file"] == "midi/01_Drums_drums.mid"
    assert payload["tempo_map"]["events"][0]["bpm"] == 92.0


def test_times_and_gains_read_the_way_the_session_shows_them():
    assert fmt_time(192.47) == "3:12.470"
    assert fmt_time(None) == "--"
    assert fmt_db(1.0) == "+0.0 dB"
    assert fmt_db(0.5) == "-6.0 dB"
    assert fmt_db(0.0) == "-inf dB"


# --- the zip -------------------------------------------------------------------


def test_everything_unzips_into_one_folder_with_audio_stored_and_text_deflated(tmp_path):
    stem = tmp_path / "01_Drums.flac"
    stem.write_bytes(b"x" * 5000)
    out = tmp_path / "song.zip"
    size = write_zip(str(out), "Midnight-Flip_92bpm_Fm",
                     [("stems/01_Drums.flac", str(stem))],
                     [("README.txt", "hello"), ("song.json", "{}")])
    assert size == out.stat().st_size
    with zipfile.ZipFile(out) as zf:
        names = sorted(zf.namelist())
        assert names == ["Midnight-Flip_92bpm_Fm/README.txt", "Midnight-Flip_92bpm_Fm/song.json",
                         "Midnight-Flip_92bpm_Fm/stems/01_Drums.flac"]
        assert zf.getinfo("Midnight-Flip_92bpm_Fm/stems/01_Drums.flac").compress_type == zipfile.ZIP_STORED
        assert zf.getinfo("Midnight-Flip_92bpm_Fm/README.txt").compress_type == zipfile.ZIP_DEFLATED
        assert zf.read("Midnight-Flip_92bpm_Fm/README.txt") == b"hello"


def test_the_cap_is_checked_again_against_the_real_bytes_while_writing(tmp_path):
    big = tmp_path / "big.wav"
    big.write_bytes(b"0" * 4096)
    with pytest.raises(ExportTooLargeError):
        write_zip(str(tmp_path / "out.zip"), "F", [("stems/big.wav", str(big))], [], cap=1024)
