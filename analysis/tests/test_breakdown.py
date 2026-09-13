"""The breakdown composer only speaks from the report; nulls become 'not measured'; hedges follow the bands."""

from __future__ import annotations

from lockedgroove.breakdown.compare import compare
from lockedgroove.breakdown.compose import SECTION_ORDER, compose, requires_for
from lockedgroove.breakdown.words import key_display, key_token, step_name, steps_phrase, with_hedge
from lockedgroove.report import (
    AnalysisReport,
    Beats,
    Chords,
    ChordSegment,
    DrumHit,
    DrumPattern,
    Drums,
    EffectsEstimates,
    Estimate,
    FileInfo,
    Groove,
    Instrumentation,
    InstrumentationSection,
    InstrumentEvent,
    Key,
    KeyAlternate,
    Loudness,
    Onsets,
    SampleUse,
    Section,
    SidechainEstimate,
    Spectral,
    Structure,
    Tempo,
    TimingDeviation,
    UserEdits,
)


def full_report(bpm=88.0, tempo_conf=0.92, key_conf=0.85, with_drums=True) -> AnalysisReport:
    beat = 60.0 / bpm
    times = [i * beat for i in range(64)]
    downbeats = times[::4]
    return AnalysisReport(
        file=FileInfo(id="a", duration_s=64 * beat, sample_rate=44100, channels=2),
        analysis_version=1,
        tempo=Tempo(bpm=bpm, confidence=tempo_conf, method="librosa", alternates_bpm=[bpm / 2, bpm * 2]),
        beats=Beats(times_s=times, confidence=0.9, method="librosa", downbeats_s=downbeats, downbeat_phase=0,
                    downbeat_confidence=0.7, downbeat_method="lowband"),
        key=Key(tonic="F", mode="minor", confidence=key_conf, method="ks",
                alternate=KeyAlternate(tonic="G#", mode="major", correlation=0.6)),
        onsets=Onsets(times_s=times, method="librosa", count=len(times)),
        groove=Groove(swing_pct=58.0, timing_deviation_ms=TimingDeviation(mean=2.0, std=6.0), feel="swung",
                      method="grid", confidence=0.8),
        structure=Structure(sections=[
            Section(start_s=0, end_s=8 * 4 * beat, start_bar=0, bars=8, label="A", energy=0.4, confidence=0.7),
            Section(start_s=8 * 4 * beat, end_s=16 * 4 * beat, start_bar=8, bars=8, label="B", energy=0.7, confidence=0.7),
        ], loop_period_bars=2, loop_period_confidence=0.75, method="ssm"),
        drums=Drums(source_estimate="sampled_break", source_confidence=0.7, patterns=[
            DrumPattern(section_index=0,
                        kick=[DrumHit(step=0, velocity=1.0, frequency=1.0), DrumHit(step=10, velocity=0.8, frequency=0.9)],
                        snare=[DrumHit(step=4, velocity=1.0, frequency=1.0), DrumHit(step=12, velocity=1.0, frequency=1.0),
                               DrumHit(step=11, velocity=0.3, frequency=0.8)],
                        hat=[DrumHit(step=s, velocity=0.6, frequency=1.0) for s in range(0, 16, 2)],
                        accents=[0, 4, 12], density_per_bar=12.0, ghost_notes=[11]),
        ], method="stem") if with_drums else None,
        sample_use=SampleUse(is_loop_based=True, chop_count_estimate=4, chop_reordering_detected=True,
                             chop_order=[0, 1, 0, 2], pitch_shift_semitones_estimate=1.0, sample_bars=list(range(0, 16)),
                             confidence=0.65, method="recurrence"),
        instrumentation=Instrumentation(per_section=[
            InstrumentationSection(section_index=0, present=["drums", "other"], entries=[], exits=[]),
            InstrumentationSection(section_index=1, present=["drums", "bass", "other"],
                                   entries=[InstrumentEvent(instrument="bass", bar=8)],
                                   exits=[InstrumentEvent(instrument="drums", bar=15)]),
        ], method="stem_rms", confidence=0.8),
        loudness=Loudness(integrated_lufs=-12.5, true_peak_dbtp=-0.8, loudness_range_lu=4.2, method="bs1770"),
        spectral=Spectral(centroid_hz_mean=1800.0, stereo_width=0.3, low_high_ratio_db=8.0, method="stft"),
        effects_estimates=EffectsEstimates(
            reverb_tail_s=Estimate(value=1.2, confidence=0.4, method="decay", notes="rough"),
            sidechain_ducking=SidechainEstimate(detected=True, depth_db=3.0, confidence=0.55, method="envelope"),
            saturation_above_hz=Estimate(value=None, confidence=0.2, method="harmonics"),
        ),
    )


def test_empty_report_has_no_facts_only_missing():
    c = compose(AnalysisReport.empty())
    assert [s.key for s in c.sections] == SECTION_ORDER
    for s in c.sections:
        assert s.facts == [], s.key
        assert s.missing, s.key
    assert "analyze" in c.requires and "stems" in c.requires
    assert c.section("context").missing[0].text.startswith("Identify the track")


def test_full_report_speaks_only_from_fields():
    c = compose(full_report())
    vitals = c.section("vitals")
    assert any("88 BPM" in f.text for f in vitals.facts)
    assert any("F minor" in f.text for f in vitals.facts)
    assert any("swung" in f.text and "58 percent" in f.text for f in vitals.facts)
    drums = c.section("drums")
    assert any("sampled break" in f.text for f in drums.facts)
    pattern = next(f for f in drums.facts if f.source.startswith("drums.patterns"))
    assert "Kick on the one and the and of three" in pattern.text
    assert "Snare on the two and the four" in pattern.text
    assert "Hats on 8ths" in pattern.text
    assert any("drop out at bar 16" in f.text for f in drums.facts)
    sample = c.section("sample")
    assert any("4 chops, played in the order 1-2-1-3" in f.text for f in sample.facts)
    assert any("pitched up 1 semitone" in f.text for f in sample.facts)
    arrangement = c.section("arrangement")
    assert any("Bass enters at bar 9" in f.text for f in arrangement.facts)
    mix = c.section("mix")
    assert any("-12.5 LUFS" in f.text for f in mix.facts)
    assert any("sidechain" in f.text.lower() for f in mix.facts)
    assert any("rough" in f.text for f in mix.facts if "reverb" in f.text)
    recipe = c.section("recipe")
    assert recipe.facts[0].text.startswith("Find a 2-bar loop around 88 in F minor")
    assert any("Chop it in 4 and play them 1-2-1-3" in f.text for f in recipe.facts)
    assert any("Duck the sample 3.0 dB on the kick" in f.text for f in recipe.facts)
    for s in c.sections:
        for f in s.facts:
            assert f.text.strip() and f.source


def test_hedges_follow_bands():
    r = full_report(tempo_conf=0.7, key_conf=0.5)
    c = compose(r)
    vitals = c.section("vitals")
    tempo_fact = next(f for f in vitals.facts if f.source == "tempo.bpm")
    assert tempo_fact.hedge == "likely" and tempo_fact.text.startswith("Likely")
    key_fact = next(f for f in vitals.facts if f.source == "key")
    assert key_fact.hedge == "roughly" and key_fact.text.startswith("Roughly")
    assert "Ab major as the other reading" in key_fact.text
    r.tempo.confidence = 0.3
    c = compose(r)
    tempo_fact = next(f for f in c.section("vitals").facts if f.source == "tempo.bpm")
    assert tempo_fact.text.startswith("I can't tell")
    assert "44 or 176" in tempo_fact.text  # alternates surface when confidence is low


def test_null_chords_yield_not_measured_never_a_progression():
    r = full_report()
    r.chords = None
    c = compose(r)
    harmony = c.section("harmony")
    assert harmony.facts == []
    assert harmony.missing[0].job == "analyze:chords"


def test_context_requires_identification_and_citations():
    r = full_report()
    c = compose(r, title="Song", artist="Artist", web_context={"findings": [
        {"text": "Produced by X.", "kind": "producer", "citation": {"url": "https://example.org/a", "title": "A"}},
        {"text": "Uncited claim.", "kind": "sample"},
    ]})
    ctx = c.section("context")
    assert len(ctx.facts) == 1 and ctx.facts[0].citation["url"] == "https://example.org/a"
    c2 = compose(r, title="Song", artist="Artist", web_context={"findings": []})
    assert c2.section("context").facts == [] and c2.section("context").missing


def test_user_edits_win_in_the_breakdown():
    r = full_report()
    r.user_edits = UserEdits(tempo_bpm=176.0)
    c = compose(r)
    assert any("176 BPM" in f.text for f in c.section("vitals").facts)


def test_stem_reports_feed_bass_and_harmony():
    r = full_report()
    bass = AnalysisReport.empty()
    bass.loudness = Loudness(integrated_lufs=-18.0, true_peak_dbtp=-3.0, loudness_range_lu=2.0, method="bs1770")
    bass.chords = Chords(segments=[ChordSegment(start_s=0, end_s=10, label="F:min", confidence=0.7)], method="tpl")
    other = AnalysisReport.empty()
    other.chords = Chords(segments=[ChordSegment(start_s=0, end_s=5, label="F:min", confidence=0.7),
                                    ChordSegment(start_s=5, end_s=10, label="G#:maj", confidence=0.7)], method="tpl")
    other.key = Key(tonic="F", mode="minor", confidence=0.8, method="ks")
    r.chords = other.chords
    c = compose(r, stem_reports={"bass": bass, "other": other, "drums": AnalysisReport.empty(),
                                 "vocals": AnalysisReport.empty()})
    assert any("There's a bass part" in f.text for f in c.section("bass").facts)
    assert any("F:min – G#:maj" in f.text for f in c.section("harmony").facts)
    assert any("share a key" in f.text for f in c.section("harmony").facts)
    assert "stems" not in c.requires


def test_requires_lists_missing_jobs():
    r = full_report()
    assert requires_for(r, None) == ["stems"]
    assert requires_for(AnalysisReport.empty(), None) == ["analyze", "stems"]
    assert requires_for(r, {"drums": AnalysisReport.empty()}) == ["stems"]


def test_compare_deltas_from_my_point_of_view():
    a = full_report(bpm=88.0)
    b = full_report(bpm=92.0)
    b.spectral = Spectral(centroid_hz_mean=2200.0, stereo_width=0.5, low_high_ratio_db=5.0, method="stft")
    b.groove = Groove(swing_pct=52.0, timing_deviation_ms=TimingDeviation(mean=1.0, std=3.0), feel="straight",
                      method="grid", confidence=0.8)
    b.drums.patterns[0].hat = [DrumHit(step=s, velocity=0.6, frequency=1.0) for s in range(0, 16, 4)]
    c = compare(a, b)
    texts = [d.text for d in c.deltas]
    assert any("88 BPM" in t and "92 BPM" in t for t in texts)
    assert any("3.0 dB heavier in the low end" in t for t in texts)
    assert any("swings 58 against the reference's 52" in t for t in texts)
    assert any("hats are 2.0x as dense" in t for t in texts)
    assert any("Both are in F minor" in t for t in texts)
    assert "stems" in c.missing
    for d in c.deltas:
        assert d.source and d.section


def test_compare_key_relations():
    a, b = full_report(), full_report()
    b.key = Key(tonic="G#", mode="major", confidence=0.9, method="ks")
    assert any("relative keys" in d.text for d in compare(a, b).deltas)
    b.key = Key(tonic="F", mode="major", confidence=0.9, method="ks")
    assert any("same root, different mode" in d.text for d in compare(a, b).deltas)
    b.key = Key(tonic="G", mode="minor", confidence=0.9, method="ks")
    assert any("2 semitones apart" in d.text for d in compare(a, b).deltas)


def test_words():
    assert key_display("F", "minor") == "F minor"
    assert key_display("A#", "major") == "Bb major"
    assert key_display("A#", "minor") == "Bb minor"
    assert key_display("C#", "minor") == "C# minor"
    assert key_display("C#", "major") == "Db major"
    assert key_display("D#", "minor") == "Eb minor"
    assert key_token("F", "minor") == "Fm" and key_token("A#", "major") == "Bb" and key_token("D#", "minor") == "Ebm"
    assert step_name(0) == "the one" and step_name(2) == "the and of one"
    assert step_name(10) == "the and of three" and step_name(11) == "the a of three" and step_name(13) == "the e of four"
    assert steps_phrase([0, 7, 10]) == "the one, the a of two and the and of three"
    assert with_hedge("likely", "It sits at 90 BPM.") == "Likely it sits at 90 BPM."
    assert with_hedge("", "It sits at 90 BPM.") == "It sits at 90 BPM."
    assert with_hedge("I can't tell", "It sits at 90 BPM.").startswith("I can't tell for sure")
