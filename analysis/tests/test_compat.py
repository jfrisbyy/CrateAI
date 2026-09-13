"""Compatibility: the music theory, before anything is wired to it (principle 8).

Every case here is one a producer would recognise: the relative minor, the fifth, the
break at half the tempo, the drum loop with no key at all, and a key that was only ever
a guess in the first place.
"""

import math

import pytest

from lockedgroove.analysis.compat import (
    CHARACTER_SHIFT,
    MAX_SHIFT,
    TRANSPARENT_MAX,
    USABLE_MAX,
    TrackVitals,
    compare_key,
    compare_tempo,
    compatibility,
    describe,
    direct_relationship,
    fold_tempo,
    is_tonal,
    key_relationship,
    pitch_class,
    stretch_distance,
    vitals_from_report,
)


def vit(bpm=None, bpm_conf=None, tonic=None, mode=None, key_conf=None, file_id=None):
    return TrackVitals(file_id=file_id, bpm=bpm, bpm_confidence=bpm_conf, tonic=tonic, mode=mode,
                       key_confidence=key_conf)


# ---------------------------------------------------------------------------
# key: the relationships
# ---------------------------------------------------------------------------


def test_relative_minor_needs_no_shift_and_is_named_from_the_candidate():
    """A minor under C major: the same seven notes, so nothing is pitched."""
    source = vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="major", key_conf=0.8)
    candidate = vit(bpm=90.0, bpm_conf=0.9, tonic="A", mode="minor", key_conf=0.8)
    key = compare_key(source, candidate)
    assert key.relationship == "relative" and key.semitone_shift == 0
    assert key.compatible and not key.shifts_character
    assert describe(compatibility(source, candidate)) == "relative minor, same tempo"
    # and the other way round the candidate is the relative major
    back = compare_key(candidate, source)
    assert back.relationship == "relative" and back.semitone_shift == 0
    assert describe(compatibility(candidate, source)) == "relative major, same tempo"


def test_relative_is_measured_from_the_right_side():
    assert key_relationship("C", "major", "A", "minor") == ("relative", 0)
    assert key_relationship("A", "minor", "C", "major") == ("relative", 0)
    # D minor is not the relative of C major (that is A minor); it is two semitones off
    assert key_relationship("C", "major", "D", "minor")[1] != 0


def test_the_fifth_up_and_down_are_the_dominant_and_the_subdominant():
    source = vit(bpm=88.0, tonic="C", mode="minor", key_conf=0.9)
    up = compare_key(source, vit(bpm=88.0, tonic="G", mode="minor", key_conf=0.9))
    down = compare_key(source, vit(bpm=88.0, tonic="F", mode="minor", key_conf=0.9))
    assert (up.relationship, up.semitone_shift) == ("dominant", 0)
    assert (down.relationship, down.semitone_shift) == ("subdominant", 0)
    assert "a fifth up" in up.note and "a fifth down" in down.note
    assert up.score == down.score  # the spec ranks them together


def test_a_fifth_in_the_other_mode_is_not_a_fifth_relationship():
    """G major over C minor is a B natural against a B flat, so it has to be pitched."""
    rel, shift = key_relationship("C", "minor", "G", "major")
    assert not (rel == "dominant" and shift == 0)
    assert shift != 0


def test_parallel_major_and_minor():
    assert key_relationship("C", "major", "C", "minor") == ("parallel", 0)
    assert key_relationship("F", "minor", "F", "major") == ("parallel", 0)


def test_an_unrelated_key_takes_the_smallest_shift_that_lands_on_a_relationship():
    """D minor against C minor: two semitones down and it is the same key."""
    rel, shift = key_relationship("C", "minor", "D", "minor")
    assert (rel, shift) == ("same", -2)
    key = compare_key(vit(tonic="C", mode="minor", key_conf=0.9), vit(tonic="D", mode="minor", key_conf=0.9))
    assert not key.shifts_character  # 2 semitones is the edge, not past it
    assert key.score < 1.0  # a shift always costs something


def test_a_shift_past_two_semitones_is_flagged_as_a_character_change():
    source = vit(tonic="C", mode="minor", key_conf=0.9)
    # a tritone away in the same mode is a semitone either side of the two fifths
    near = compare_key(source, vit(tonic="F#", mode="minor", key_conf=0.9))
    assert abs(near.semitone_shift) == 1 and not near.shifts_character
    # C minor's relative major is D# major: already there, nothing to shift
    relative = compare_key(source, vit(tonic="D#", mode="major", key_conf=0.9))
    assert relative.relationship == "relative" and relative.semitone_shift == 0
    # F minor under C major is the far corner: four semitones up to the relative minor
    wide = compare_key(vit(tonic="C", mode="major", key_conf=0.9), vit(tonic="F", mode="minor", key_conf=0.9))
    assert (wide.relationship, wide.semitone_shift) == ("relative", 4)
    assert abs(wide.semitone_shift) > CHARACTER_SHIFT and wide.shifts_character
    assert "up 4 semitones" in describe(compatibility(vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="major",
                                                          key_conf=0.9),
                                                     vit(bpm=90.0, bpm_conf=0.9, tonic="F", mode="minor",
                                                         key_conf=0.9)))


def test_a_shift_beyond_the_callers_limit_is_not_compatible():
    """The default budget reaches everything; a caller who will not pitch past 2 gets fewer answers."""
    source = vit(tonic="C", mode="major", key_conf=0.9)
    candidate = vit(tonic="F", mode="minor", key_conf=0.9)
    assert compare_key(source, candidate, max_semitones=MAX_SHIFT).compatible
    tight = compare_key(source, candidate, max_semitones=CHARACTER_SHIFT)
    assert not tight.compatible and tight.relationship == "unknown" and tight.score == 0.0
    assert "past the 2 allowed" in tight.note
    assert not compatibility(vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="major", key_conf=0.9),
                             vit(bpm=90.0, bpm_conf=0.9, tonic="F", mode="minor", key_conf=0.9),
                             max_semitones=CHARACTER_SHIFT).compatible


def test_zero_shift_relationships_are_preferred_over_pitching_into_the_same_key():
    """C major under C minor already works; do not pitch it two semitones to chase "same"."""
    rel, shift = key_relationship("C", "minor", "C", "major")
    assert (rel, shift) == ("parallel", 0)


def test_no_key_is_more_than_four_semitones_from_a_relationship():
    """Worth writing down: the five relationships cover the circle so well that the default
    budget of six semitones is never the binding constraint. The far corner is four."""
    worst = 0
    for source_tonic in ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"):
        for source_mode in ("major", "minor"):
            for tonic in ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"):
                for mode in ("major", "minor"):
                    rel, shift = key_relationship(source_tonic, source_mode, tonic, mode)
                    assert rel is not None and abs(shift) <= MAX_SHIFT
                    worst = max(worst, abs(shift))
    assert worst == 4


def test_tonic_spelling_accepts_flats_and_sharps():
    assert pitch_class("A#") == pitch_class("Bb") == 10
    assert pitch_class("D♭") == pitch_class("C#") == 1
    assert pitch_class("h") is None and pitch_class("") is None
    assert key_relationship("Bb", "major", "G", "minor") == ("relative", 0)


def test_direct_relationship_is_the_primitive_the_rest_is_built_on():
    assert direct_relationship(0, "major", 0, "major") == "same"
    assert direct_relationship(0, "major", 9, "minor") == "relative"
    assert direct_relationship(0, "minor", 7, "minor") == "dominant"
    assert direct_relationship(0, "minor", 5, "minor") == "subdominant"
    assert direct_relationship(0, "minor", 0, "major") == "parallel"
    assert direct_relationship(0, "minor", 2, "minor") is None


# ---------------------------------------------------------------------------
# tempo: the fold and the bands
# ---------------------------------------------------------------------------


def test_half_time_and_double_time_share_the_grid():
    """170 over 85 is not a stretch at all, it is the same grid counted twice as fast."""
    assert fold_tempo(170.0, 85.0) == (2.0, 1.0)
    assert fold_tempo(85.0, 170.0) == (0.5, 1.0)
    fast = compare_tempo(vit(bpm=170.0, bpm_conf=0.9), vit(bpm=85.0, bpm_conf=0.9))
    assert fast.fold == "double" and fast.folded_bpm == 170.0
    assert fast.ratio == 1.0 and fast.quality == "transparent" and fast.compatible
    slow = compare_tempo(vit(bpm=85.0, bpm_conf=0.9), vit(bpm=170.0, bpm_conf=0.9))
    assert slow.fold == "half" and slow.folded_bpm == 85.0 and slow.ratio == 1.0
    line = describe(compatibility(vit(bpm=170.0, bpm_conf=0.9, tonic="F", mode="minor", key_conf=0.9),
                                  vit(bpm=85.0, bpm_conf=0.9, tonic="F", mode="minor", key_conf=0.9)))
    assert line == "same key, needs double-time"


def test_the_fold_picks_the_nearest_octave_then_stretches_the_rest():
    factor, ratio = fold_tempo(92.0, 180.0)
    assert factor == 0.5 and math.isclose(ratio, 92.0 / 90.0)
    match = compare_tempo(vit(bpm=92.0, bpm_conf=0.8), vit(bpm=180.0, bpm_conf=0.8))
    assert match.fold == "half" and match.folded_bpm == 90.0
    assert match.quality == "transparent" and round(match.percent, 1) == 2.2


def test_the_fold_is_bounded_so_a_quarter_time_pairing_is_not_claimed():
    factor, _ = fold_tempo(160.0, 40.0)
    assert factor == 2.0  # not 4.0: one octave by default
    assert fold_tempo(160.0, 40.0, max_octaves=2)[0] == 4.0


def test_the_stretch_ratio_is_what_the_candidate_is_multiplied_by():
    match = compare_tempo(vit(bpm=92.0, bpm_conf=0.9), vit(bpm=88.0, bpm_conf=0.9))
    assert math.isclose(match.ratio, 92.0 / 88.0)
    assert match.percent > 0  # the candidate has to speed up to reach the source
    assert "4.5% faster" in describe(compatibility(vit(bpm=92.0, bpm_conf=0.9), vit(bpm=88.0, bpm_conf=0.9)))
    back = compare_tempo(vit(bpm=88.0, bpm_conf=0.9), vit(bpm=92.0, bpm_conf=0.9))
    assert back.percent < 0


def test_the_bands_are_symmetric_in_ratio_space():
    assert stretch_distance(1.0) == 0.0
    assert math.isclose(stretch_distance(1.06), 0.06)
    assert math.isclose(stretch_distance(1 / 1.06), 0.06)
    transparent = compare_tempo(vit(bpm=100.0, bpm_conf=0.9), vit(bpm=100.0 / 1.05, bpm_conf=0.9))
    usable = compare_tempo(vit(bpm=100.0, bpm_conf=0.9), vit(bpm=100.0 / 1.12, bpm_conf=0.9))
    gone = compare_tempo(vit(bpm=100.0, bpm_conf=0.9), vit(bpm=100.0 / 1.20, bpm_conf=0.9))
    assert transparent.quality == "transparent" and transparent.compatible
    assert usable.quality == "usable" and usable.compatible
    assert gone.quality == "out_of_range" and not gone.compatible
    assert not compatibility(vit(bpm=100.0, bpm_conf=0.9), vit(bpm=83.0, bpm_conf=0.9)).compatible


def test_the_caller_can_tighten_the_tolerance_to_transparent_only():
    pair = (vit(bpm=100.0, bpm_conf=0.9), vit(bpm=90.0, bpm_conf=0.9))
    assert compare_tempo(*pair).quality == "usable"
    assert compare_tempo(*pair, tolerance=TRANSPARENT_MAX).quality == "out_of_range"


def test_a_closer_tempo_scores_higher_and_a_fold_costs_a_little():
    exact = compare_tempo(vit(bpm=90.0, bpm_conf=0.9), vit(bpm=90.0, bpm_conf=0.9))
    near = compare_tempo(vit(bpm=90.0, bpm_conf=0.9), vit(bpm=88.0, bpm_conf=0.9))
    edge = compare_tempo(vit(bpm=90.0, bpm_conf=0.9), vit(bpm=90.0 / (1 + USABLE_MAX), bpm_conf=0.9))
    folded = compare_tempo(vit(bpm=90.0, bpm_conf=0.9), vit(bpm=45.0, bpm_conf=0.9))
    assert exact.score == 1.0 > near.score > edge.score
    assert math.isclose(edge.score, 0.5, abs_tol=1e-6)
    assert folded.score < exact.score  # same grid, but the literal agreement ranks first


# ---------------------------------------------------------------------------
# the missing values: a drum break has no key, and that is the common case
# ---------------------------------------------------------------------------


def test_a_file_with_no_key_fits_everything_and_the_claim_rests_on_tempo():
    source = vit(bpm=90.0, bpm_conf=0.9, tonic="F", mode="minor", key_conf=0.85)
    would_be_a_break = vit(bpm=90.0, bpm_conf=0.9)
    match = compatibility(source, would_be_a_break)
    assert match.compatible and match.key.relationship == "unknown" and match.key.compatible
    assert match.score == match.tempo.score == 1.0
    assert "tempo alone" in match.method
    assert describe(match) == "no key detected, tempo only"
    # the key that is missing does not drag the confidence down; only tempo bounds it
    assert match.confidence == 0.9 and match.confidence_bound_by.endswith("tempo")


def test_a_keyless_break_at_a_different_tempo_still_says_what_the_stretch_is():
    match = compatibility(vit(bpm=90.0, bpm_conf=0.9, tonic="F", mode="minor", key_conf=0.85),
                          vit(bpm=87.0, bpm_conf=0.9))
    assert describe(match) == "no key detected, 3.4% faster"


def test_a_file_with_no_tempo_leans_on_key_alone():
    match = compatibility(vit(bpm=90.0, bpm_conf=0.9, tonic="F", mode="minor", key_conf=0.8),
                          vit(tonic="G#", mode="major", key_conf=0.8))
    assert match.tempo.quality == "unknown" and match.tempo.compatible
    assert match.key.relationship == "relative"
    assert match.score == match.key.score and "key alone" in match.method
    assert describe(match) == "relative major, no tempo detected"


def test_nothing_measured_is_not_a_match_worth_a_confidence():
    match = compatibility(vit(), vit())
    assert match.confidence == 0.0 and match.confidence_bound_by == ""
    assert "nothing was measured" in match.confidence_reason


def test_drum_material_has_no_key_whatever_the_chroma_said():
    """The key stage always returns a best profile; a break reads ~0.37 (HANDOFF_dsp choice 11).
    That is a number about the chroma, not about the music, so non-tonal material is keyless here,
    exactly as it is keyless to the layer render (combine.align.AlignItem.is_tonal)."""
    assert is_tonal("original", [], "loop.wav")
    assert not is_tonal("original", ["drums", "dusty"], "loop.wav")
    assert not is_tonal("stem", [], "Drums.wav")
    assert is_tonal("stem", ["bass"], "bass.wav")
    break_vitals = TrackVitals(bpm=90.0, bpm_confidence=0.9, tonic="F#", mode="minor",
                               key_confidence=0.37, tonal=False)
    assert not break_vitals.has_key
    match = compatibility(vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="minor", key_conf=0.9), break_vitals)
    assert match.key.relationship == "unknown" and match.compatible
    assert describe(match) == "no key detected, tempo only"
    assert "non-tonal" in match.key.note
    # the break's own key confidence does not bind a claim that never used it
    assert match.confidence == 0.9


def test_an_uncertain_key_is_kept_and_hedged_not_discarded():
    """0.42 is a real measurement of a tonal file. The spec's answer to a shaky key is to carry
    the confidence through, not to throw the key away."""
    match = compatibility(vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="major", key_conf=0.42),
                          vit(bpm=90.0, bpm_conf=0.9, tonic="A", mode="minor", key_conf=0.9))
    assert match.key.relationship == "relative" and match.confidence == 0.42


# ---------------------------------------------------------------------------
# confidence: a claim is never surer than what it is built on (principle 2)
# ---------------------------------------------------------------------------


def test_confidence_is_bounded_by_the_weakest_input_the_claim_uses():
    source = vit(bpm=90.0, bpm_conf=0.95, tonic="C", mode="major", key_conf=0.42)
    candidate = vit(bpm=90.0, bpm_conf=0.93, tonic="A", mode="minor", key_conf=0.88)
    match = compatibility(source, candidate)
    assert match.key.relationship == "relative" and match.score > 0.9
    assert match.confidence == 0.42
    assert match.confidence_bound_by == "source_key"
    assert "0.42" in match.confidence_reason
    # the same pair with the weak key on the other side names the other side
    flipped = compatibility(vit(bpm=90.0, bpm_conf=0.95, tonic="C", mode="major", key_conf=0.9),
                            vit(bpm=90.0, bpm_conf=0.93, tonic="A", mode="minor", key_conf=0.3))
    assert flipped.confidence == 0.3 and flipped.confidence_bound_by == "candidate_key"


def test_a_confident_key_does_not_rescue_a_shaky_tempo():
    match = compatibility(vit(bpm=90.0, bpm_conf=0.2, tonic="C", mode="major", key_conf=0.95),
                          vit(bpm=90.0, bpm_conf=0.95, tonic="C", mode="major", key_conf=0.95))
    assert match.score == 1.0 and match.confidence == 0.2
    assert match.confidence_bound_by == "source_tempo"


def test_a_measured_value_with_no_recorded_confidence_is_a_zero_not_a_one():
    match = compatibility(vit(bpm=90.0, tonic="C", mode="major", key_conf=0.9),
                          vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="major", key_conf=0.9))
    assert match.confidence == 0.0 and match.confidence_bound_by == "source_tempo"


def test_the_per_axis_matches_carry_their_own_bounded_confidence():
    source = vit(bpm=90.0, bpm_conf=0.7, tonic="C", mode="major", key_conf=0.4)
    candidate = vit(bpm=90.0, bpm_conf=0.5, tonic="C", mode="major", key_conf=0.9)
    match = compatibility(source, candidate)
    assert match.tempo.confidence == 0.5 and match.key.confidence == 0.4
    assert match.confidence == min(match.tempo.confidence, match.key.confidence)


# ---------------------------------------------------------------------------
# the combined result
# ---------------------------------------------------------------------------


def test_every_result_carries_a_method_and_a_reason_that_names_measured_things():
    match = compatibility(vit(bpm=92.0, bpm_conf=0.9, tonic="C", mode="major", key_conf=0.9),
                          vit(bpm=90.0, bpm_conf=0.9, tonic="A", mode="minor", key_conf=0.9))
    assert match.method and match.tempo.method and match.key.method
    assert match.reason == describe(match) == "relative minor, 2.2% faster"
    assert "90" in match.tempo.note and "A minor" in match.key.note


def test_ranking_puts_the_obvious_answer_first():
    source = vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="minor", key_conf=0.9)
    same = compatibility(source, vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="minor", key_conf=0.9))
    relative = compatibility(source, vit(bpm=90.0, bpm_conf=0.9, tonic="D#", mode="major", key_conf=0.9))
    fifth = compatibility(source, vit(bpm=90.0, bpm_conf=0.9, tonic="G", mode="minor", key_conf=0.9))
    parallel = compatibility(source, vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="major", key_conf=0.9))
    shifted = compatibility(source, vit(bpm=90.0, bpm_conf=0.9, tonic="D", mode="minor", key_conf=0.9))
    stretched = compatibility(source, vit(bpm=96.0, bpm_conf=0.9, tonic="C", mode="minor", key_conf=0.9))
    assert same.score > relative.score > fifth.score > parallel.score
    assert same.score > shifted.score and same.score > stretched.score
    assert all(0.0 <= m.score <= 1.0 for m in (same, relative, fifth, parallel, shifted, stretched))


def test_to_json_is_a_plain_dict_the_api_can_return():
    match = compatibility(vit(bpm=90.0, bpm_conf=0.9, tonic="C", mode="major", key_conf=0.9),
                          vit(bpm=88.0, bpm_conf=0.9, tonic="A", mode="minor", key_conf=0.9))
    js = match.to_json()
    assert js["reason"] == match.reason and js["tempo"]["ratio"] == match.tempo.ratio
    assert js["key"]["relationship"] == "relative"
    assert set(js) >= {"score", "confidence", "confidence_bound_by", "confidence_reason", "method",
                       "compatible", "reason", "tempo", "key"}


def test_the_module_is_pure_arithmetic():
    """No audio, no database, no network: the imports say so and the tests rely on it."""
    import ast
    import pathlib

    import lockedgroove.analysis.compat as mod

    tree = ast.parse(pathlib.Path(mod.__file__).read_text())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
    assert imported == {"__future__", "collections", "math", "dataclasses", "typing", "report"}


def test_vitals_from_report_reads_the_effective_values():
    from lockedgroove.report import AnalysisReport, FileInfo, Key, Tempo

    report = AnalysisReport(
        file=FileInfo(id="abc", duration_s=4.0, sample_rate=22050, channels=1),
        tempo=Tempo(bpm=88.0, confidence=0.77, method="test"),
        key=Key(tonic="F", mode="minor", confidence=0.61, method="test"),
    )
    v = vitals_from_report(report)
    assert (v.file_id, v.bpm, v.bpm_confidence) == ("abc", 88.0, 0.77)
    assert (v.tonic, v.mode, v.key_confidence) == ("F", "minor", 0.61)
    assert v.has_tempo and v.has_key and v.tonal
    empty = vitals_from_report(AnalysisReport())
    assert not empty.has_tempo and not empty.has_key

    from lockedgroove.report import Tag

    drums = AnalysisReport(
        file=FileInfo(id="d", kind="stem", original_filename="Drums.wav"),
        tempo=Tempo(bpm=90.0, confidence=0.9, method="test"),
        key=Key(tonic="F#", mode="minor", confidence=0.37, method="test"),
        tags=[Tag(tag="drums", confidence=0.9)],
    )
    read = vitals_from_report(drums)
    assert not read.tonal and not read.has_key and read.has_tempo


def test_fold_tempo_refuses_a_tempo_that_is_not_a_tempo():
    with pytest.raises(ValueError):
        fold_tempo(90.0, 0.0)
    with pytest.raises(ValueError):
        stretch_distance(0.0)


# ---------------------------------------------------------------------------
# parity: the web mirrors this module, and both sides assert the same table
# ---------------------------------------------------------------------------


def test_the_parity_table_still_describes_this_module():
    """web/lib/compat/parity.json is the contract between this module and its TypeScript
    mirror (web/lib/compat/theory.ts). Both suites assert against it, so neither side can
    drift into saying something different about the same pair of files.

    Regenerate after a deliberate change to the theory:

        uv run python -c "import json,pathlib; from lockedgroove.analysis.compat import *; \
            p=pathlib.Path('../web/lib/compat/parity.json'); d=json.loads(p.read_text()); \
            [c.__setitem__('expected', compatibility(TrackVitals(**c['source']), \
                TrackVitals(**c['candidate']), **c['options']).to_json()) for c in d['cases']]; \
            p.write_text(json.dumps(d, indent=2) + '\\n')"
    """
    import json
    import pathlib

    path = pathlib.Path(__file__).resolve().parents[2] / "web" / "lib" / "compat" / "parity.json"
    table = json.loads(path.read_text())
    assert table["version"] == 1 and len(table["cases"]) >= 20
    for case in table["cases"]:
        got = compatibility(TrackVitals(**case["source"]), TrackVitals(**case["candidate"]),
                            **case["options"]).to_json()
        assert got == case["expected"], f"{case['name']} drifted from the parity table"
