"""The arrangement as it arrives: what is accepted, what is refused, what is heard.

The song is not persisted anywhere yet, so it reaches compute as job params —
which makes every field of it caller input. These assert the boundary.
"""

from __future__ import annotations

import pytest

from lockedgroove.export.song import (
    MAX_LENGTH_S,
    MAX_TRACKS,
    ExportError,
    Song,
    exported_tracks,
)


def region(**over):
    base = {"id": "r1", "file_id": "f1", "start_s": 0.0, "duration_s": 2.0, "offset_s": 0.0}
    base.update(over)
    return base


def track(**over):
    base = {"id": "t1", "name": "Drums", "position": 0, "regions": [region()]}
    base.update(over)
    return base


def song(**over):
    base = {"name": "Midnight Flip", "bpm": 92.0, "beats_per_bar": 4, "tracks": [track()]}
    base.update(over)
    return base


def test_parses_a_song_and_sorts_lanes_and_regions_into_play_order():
    parsed = Song.parse(song(tracks=[
        track(id="t2", name="Bass", position=1, regions=[region(id="b2", start_s=4.0), region(id="b1", start_s=0.0)]),
        track(id="t1", name="Drums", position=0),
    ]))
    assert [t.name for t in parsed.tracks] == ["Drums", "Bass"]
    assert [r.id for r in parsed.tracks[1].regions] == ["b1", "b2"]
    assert parsed.length_s == 6.0
    assert parsed.bpm == 92.0 and parsed.beats_per_bar == 4


def test_the_length_is_the_furthest_region_end_on_any_lane():
    parsed = Song.parse(song(tracks=[
        track(id="t1", regions=[region(start_s=0.0, duration_s=2.0)]),
        track(id="t2", position=1, regions=[region(id="r2", start_s=10.0, duration_s=1.5)]),
    ]))
    assert parsed.length_s == pytest.approx(11.5)


def test_a_song_with_no_tempo_has_no_bars_and_nothing_invents_one():
    parsed = Song.parse(song(bpm=None))
    assert parsed.bpm is None
    assert parsed.seconds_per_bar() is None
    assert parsed.bar_at(10.0) is None


def test_bar_positions_are_one_based_from_second_zero():
    parsed = Song.parse(song(bpm=120.0, beats_per_bar=4))  # 2 s per bar
    assert parsed.bar_at(0.0) == pytest.approx(1.0)
    assert parsed.bar_at(2.0) == pytest.approx(2.0)
    assert parsed.bar_at(5.0) == pytest.approx(3.5)


@pytest.mark.parametrize("bad,message", [
    ({"tracks": []}, "non-empty"),
    ({"tracks": [track(regions=[])]}, "no regions"),
    ({"tracks": [track(regions=[region(file_id=None)])]}, "file_id"),
    ({"tracks": [track(regions=[region(duration_s=0.001)])]}, "shorter than"),
    ({"tracks": [track(id=None)]}, "id is required"),
    ({"tracks": [track(regions=[region(start_s=float("nan"))])]}, "finite"),
])
def test_a_song_that_cannot_be_rendered_is_refused_with_the_reason(bad, message):
    with pytest.raises(ExportError) as exc:
        Song.parse(song(**bad))
    assert message in str(exc.value)


def test_too_many_lanes_is_refused_before_anything_is_downloaded():
    many = [track(id=f"t{i}", position=i) for i in range(MAX_TRACKS + 1)]
    with pytest.raises(ExportError, match="at most"):
        Song.parse(song(tracks=many))


def test_a_song_longer_than_the_ceiling_is_refused():
    long_region = region(start_s=MAX_LENGTH_S - 1, duration_s=60.0)
    with pytest.raises(ExportError, match="minutes"):
        Song.parse(song(tracks=[track(regions=[long_region])]))


def test_params_are_not_trusted_as_text_control_characters_never_reach_the_readme():
    parsed = Song.parse(song(name="Mid\x00night\nFlip\x07", tracks=[
        track(name="Dr\rums", regions=[region(lineage_line="a" * 900)]),
    ]))
    # Every control character becomes a space, so nothing vanishes and nothing
    # can put a second line into a text file the producer reads.
    assert parsed.name == "Mid night Flip"
    assert "\n" not in parsed.name and "\x00" not in parsed.name
    assert parsed.tracks[0].name == "Dr ums"
    assert len(parsed.tracks[0].regions[0].lineage_line or "") <= 400


def test_lineage_survives_the_wire_with_the_separator_and_the_take():
    parsed = Song.parse(song(tracks=[track(regions=[region(lineage={
        "file_id": "f1", "file_name": "Masquerade", "stem": "drums", "separation_model": "roformer-x",
        "take_start_s": 24.13, "take_end_s": 34.56, "downbeat_s": 0.31, "source_bpm": 95.4,
        "source_beats_per_bar": 4, "cents": 0, "stretch": 1, "reason": "relative minor", "confidence": 0.86,
    })])]))
    lineage = parsed.tracks[0].regions[0].lineage
    assert lineage is not None
    assert lineage.file_name == "Masquerade" and lineage.stem == "drums"
    assert lineage.separation_model == "roformer-x"
    assert lineage.take_start_s == pytest.approx(24.13)
    assert lineage.source_bpm == pytest.approx(95.4)
    assert lineage.confidence == pytest.approx(0.86)


def test_a_region_eats_the_record_faster_when_it_is_resampled():
    parsed = Song.parse(song(tracks=[track(regions=[region(duration_s=10.0, rate=0.964)])]))
    assert parsed.tracks[0].regions[0].source_seconds == pytest.approx(9.64)


# --- mute, solo and what is exported ------------------------------------------


def test_a_muted_lane_is_held_back_and_named_rather_than_silently_dropped():
    parsed = Song.parse(song(tracks=[
        track(id="t1", name="Drums"),
        track(id="t2", name="Horns", position=1, muted=True, regions=[region(id="r2")]),
    ]))
    exported, held = exported_tracks(parsed)
    assert [t.name for t in exported] == ["Drums"]
    assert [t.name for t in held] == ["Horns"]


def test_include_muted_renders_the_muted_lane_at_its_own_fader():
    parsed = Song.parse(song(tracks=[
        track(id="t1", name="Drums"),
        track(id="t2", name="Horns", position=1, muted=True, gain=0.5, regions=[region(id="r2")]),
    ]))
    exported, held = exported_tracks(parsed, include_muted=True)
    assert [t.name for t in exported] == ["Drums", "Horns"]
    assert held == []
    assert exported[1].gain == 0.5


def test_solo_decides_what_is_in_the_zip_and_mute_wins_on_its_own_lane():
    parsed = Song.parse(song(tracks=[
        track(id="t1", name="Drums", soloed=True),
        track(id="t2", name="Bass", position=1, regions=[region(id="r2")]),
        track(id="t3", name="Horns", position=2, soloed=True, muted=True, regions=[region(id="r3")]),
    ]))
    assert parsed.solo_mode is True
    exported, held = exported_tracks(parsed)
    assert [t.name for t in exported] == ["Drums"]
    assert [t.name for t in held] == ["Bass", "Horns"]


def test_a_lane_carries_the_file_ids_it_actually_uses_once_each():
    parsed = Song.parse(song(tracks=[track(regions=[
        region(id="a", file_id="f1"), region(id="b", start_s=2.0, file_id="f2"),
        region(id="c", start_s=4.0, file_id="f1"),
    ])]))
    assert parsed.tracks[0].file_ids == ["f1", "f2"]
