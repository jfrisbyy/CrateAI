import numpy as np

from lockedgroove.analysis import chords as chords_mod
from lockedgroove.analysis import effects, instrumentation
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, Beats, Section, Structure, Tempo
from lockedgroove.testing.synth import (
    Pattern,
    add_reverb,
    chord,
    chord_progression,
    click,
    drum_loop,
    mix,
    sidechain,
    silence,
    sine,
    triad,
)

SR = 22050


def _grid_report(bpm, bars, offset=0.0):
    beat = 60.0 / bpm
    times = [offset + i * beat for i in range(bars * 4 + 1)]
    return AnalysisReport(
        tempo=Tempo(bpm=bpm, confidence=0.9, method="t", alternates_bpm=[bpm / 2, bpm * 2]),
        beats=Beats(times_s=times, confidence=0.9, method="b", downbeats_s=times[::4], downbeat_phase=0,
                    downbeat_confidence=0.9, downbeat_method="d"),
    )


def test_four_chord_progression_recovered():
    bpm = 90.0
    progression = [triad("F", "minor"), triad("G#", "major"), triad("A#", "major"), triad("C", "minor")]
    y = chord_progression(progression, 4, bpm, SR, repeats=2)
    report = _grid_report(bpm, 8)
    ctx = Context(report=report, sr=SR)
    out = chords_mod.run(y, SR, ctx)
    labels = [s.label for s in out.segments]
    assert labels == ["F:min", "G#:maj", "A#:maj", "C:min"] * 2, labels
    beat = 60.0 / bpm
    for i, seg in enumerate(out.segments):
        assert abs(seg.start_s - i * 4 * beat) < beat * 0.6
        assert seg.confidence > 0.5
    assert "mix" in out.method


def test_chords_prefer_other_stem_and_mark_silence_as_N():
    bpm = 100.0
    y_other = chord_progression([triad("D", "major"), triad("G", "major")], 4, bpm, SR, repeats=1)
    y = mix(y_other, drum_loop(bpm, 2, Pattern.four_on_floor(), SR)[: len(y_other)])
    report = _grid_report(bpm, 2)
    ctx = Context(report=report, sr=SR, stems={"other": y_other, "drums": y - y_other})
    out = chords_mod.run(y, SR, ctx)
    assert [s.label for s in out.segments] == ["D:maj", "G:maj"]
    assert "other stem" in out.method
    quiet = chords_mod.run(silence(4.0, SR), SR, Context(report=_grid_report(bpm, 2), sr=SR))
    assert all(s.label == "N" for s in quiet.segments)


def test_instrumentation_bass_enters_at_bar_nine():
    bpm = 120.0
    bars = 16
    bar_s = 4 * 60 / bpm
    drums = drum_loop(bpm, bars, Pattern.four_on_floor(), SR)[: int(bars * bar_s * SR)]
    bass = silence(bars * bar_s, SR)
    bass_part = chord_progression([[41], [43]], 4, bpm, SR, repeats=4)  # F1, G1
    start = int(8 * bar_s * SR)
    bass[start:start + len(bass_part)] = bass_part[: len(bass) - start]
    other = chord_progression([triad("F", "minor")], 4, bpm, SR, repeats=bars)[: len(bass)]
    report = _grid_report(bpm, bars)
    report.structure = Structure(sections=[
        Section(start_s=0, end_s=8 * bar_s, start_bar=0, bars=8, label="A", energy=0.4, confidence=0.7),
        Section(start_s=8 * bar_s, end_s=16 * bar_s, start_bar=8, bars=8, label="B", energy=0.7, confidence=0.7),
    ], method="s")
    ctx = Context(report=report, sr=SR, stems={"drums": drums, "bass": bass, "other": other})
    y = mix(drums, bass, other)
    out = instrumentation.run(y, SR, ctx)
    assert out is not None
    assert out.per_section[0].present == ["drums", "other"]
    assert out.per_section[1].present == ["bass", "drums", "other"]
    entries = [(e.instrument, e.bar) for s in out.per_section for e in s.entries]
    assert ("bass", 8) in entries  # 0-based bar 8 is "bar 9" to a producer
    assert out.confidence > 0.3
    assert instrumentation.run(y, SR, Context(report=report, sr=SR)) is None


def test_reverb_tail_estimate_from_sparse_transients():
    y = silence(9.5, SR)
    for t in (0.5, 3.5, 6.5):
        c = click(SR, ms=8)
        i = int(t * SR)
        y[i:i + len(c)] += c
    wet = add_reverb(y, SR, rt60_s=1.5, wet=0.6)
    est = effects.reverb_tail(wet, SR, onsets_s=[0.5, 3.5, 6.5])
    assert est.value is not None and abs(est.value - 1.5) < 0.4, est
    assert est.confidence <= 0.6
    dry = effects.reverb_tail(y, SR, onsets_s=[0.5, 3.5, 6.5])
    assert dry.value is None or dry.value < 0.3


def test_sidechain_detected_with_depth_and_absent_without():
    bpm = 120.0
    beat = 60 / bpm
    kicks = [i * beat for i in range(16)]
    pad = chord([53, 57, 60], 8.0, SR, amplitude=0.5)
    ducked = sidechain(pad, kicks, SR, depth_db=6.0, release_s=0.2)
    est = effects.sidechain(ducked, SR, kicks, "test")
    assert est.detected and est.depth_db is not None and 3.0 <= est.depth_db <= 9.0
    assert est.confidence <= 0.6
    flat = effects.sidechain(pad, SR, kicks, "test")
    assert not flat.detected


def test_effects_run_on_mix_and_saturation_rough():
    bpm = 100.0
    y = drum_loop(bpm, 4, Pattern.boom_bap(), SR)
    report = _grid_report(bpm, 4)
    out = effects.run(y, SR, Context(report=report, sr=SR))
    assert out.sidechain_ducking.confidence <= 0.6 and out.reverb_tail_s.confidence <= 0.6
    clean = sine(200.0, 2.0, SR, amplitude=0.5)
    assert effects.saturation_above(clean, SR).value is None
    hot = np.tanh(sine(200.0, 2.0, SR, amplitude=0.9) * 6).astype(np.float32)
    sat = effects.saturation_above(hot, SR)
    assert sat.value is not None and sat.confidence <= 0.6
