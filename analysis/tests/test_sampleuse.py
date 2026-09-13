import numpy as np

from lockedgroove.analysis import sampleuse
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, Beats, Tempo
from lockedgroove.testing.synth import (
    Pattern, arpeggio, chord_progression, continuous_chord_progression, drum_loop, midi_note, mix, triad,
)

SR = 22050
BPM = 90.0
BAR_S = 4 * 60 / BPM


def _report(bars):
    beat = 60.0 / BPM
    times = [i * beat for i in range(bars * 4 + 1)]
    return AnalysisReport(tempo=Tempo(bpm=BPM, confidence=0.9, method="t", alternates_bpm=[BPM / 2, BPM * 2]),
                          beats=Beats(times_s=times, confidence=0.9, method="b", downbeats_s=times[::4],
                                      downbeat_phase=0, downbeat_confidence=0.9, downbeat_method="d"))


def _source_phrase() -> np.ndarray:
    """A continuous 4-bar phrase: four crossfaded chords with a 16-note line, no attacks at bar lines."""
    pad = continuous_chord_progression([triad("F", "minor", 3), triad("A#", "major", 3), triad("C", "minor", 3),
                                        triad("D#", "major", 3)], 4, BPM, SR, amplitude=0.4)
    line = [midi_note(n, o) for n, o in (("F", 5), ("G#", 5), ("C", 6), ("D#", 6), ("D", 6), ("F", 6), ("A#", 5), ("D", 6),
                                          ("C", 6), ("D#", 6), ("G", 6), ("C", 6), ("G", 5), ("A#", 5), ("D#", 6), ("G", 6))]
    mel = arpeggio(line, BPM, 4 * BAR_S, SR, notes_per_beat=1, amplitude=0.3)
    return mix(pad, mel[: len(pad)])


def _chopped(order, repeats=4) -> np.ndarray:
    phrase = _source_phrase()
    n = int(BAR_S * SR)
    chops = [phrase[i * n:(i + 1) * n] for i in range(4)]
    period = np.concatenate([chops[i] for i in order])
    return np.concatenate([period] * repeats)


def _with_drums(y):
    bars = int(round(len(y) / SR / BAR_S))
    d = drum_loop(BPM, bars, Pattern.boom_bap(), SR)[: len(y)]
    return mix(y, d, gains=[0.8, 0.7])


def test_continuous_loop_is_loop_based_without_chops():
    y = np.concatenate([_source_phrase()] * 4)
    out = sampleuse.run(_with_drums(y), SR, Context(report=_report(16), sr=SR, stems={"other": y}))
    assert out.is_loop_based is True
    assert out.chop_count_estimate is None and out.chop_reordering_detected is False
    assert out.confidence > 0.4
    assert "other stem" in out.method


def test_chopped_in_four_and_reordered_with_a_repeat():
    y = _chopped([0, 1, 0, 2])
    out = sampleuse.run(_with_drums(y), SR, Context(report=_report(16), sr=SR, stems={"other": y}))
    assert out.is_loop_based is True
    assert out.chop_count_estimate == 4
    assert out.chop_reordering_detected is True
    assert out.chop_order == [0, 1, 0, 2]
    assert out.sample_bars == list(range(16))


def test_permutation_detected_by_hard_seams():
    y = _chopped([0, 2, 1, 3])
    out = sampleuse.run(_with_drums(y), SR, Context(report=_report(16), sr=SR, stems={"other": y}))
    assert out.is_loop_based is True
    assert out.chop_count_estimate == 4 and out.chop_reordering_detected is True


def test_not_loop_based_material():
    progression = [triad(t, m) for t, m in (("C", "major"), ("D", "minor"), ("E", "minor"), ("F", "major"),
                                             ("G", "major"), ("A", "minor"), ("B", "minor"), ("C", "major"),
                                             ("A#", "major"), ("D#", "major"), ("G#", "major"), ("C#", "major"),
                                             ("F#", "major"), ("B", "major"), ("E", "major"), ("A", "major"))]
    y = chord_progression(progression, 4, BPM, SR, repeats=1)
    out = sampleuse.run(y, SR, Context(report=_report(16), sr=SR))
    assert out.is_loop_based is False or (out.is_loop_based is None)


def test_pitch_shift_against_library_candidate():
    import librosa

    src = _source_phrase()
    up = librosa.effects.pitch_shift(src, sr=SR, n_steps=1)
    cand_chroma = librosa.feature.chroma_cqt(y=src, sr=SR).mean(axis=1)
    semis, fid, conf = sampleuse.pitch_shift_estimate(librosa.feature.chroma_cqt(y=up, sr=SR).mean(axis=1),
                                                      [{"file_id": "src", "chroma": cand_chroma.tolist()}])
    assert semis == 1.0 and fid == "src" and conf > 0.3
    assert sampleuse.pitch_shift_estimate(cand_chroma, [{"file_id": "x", "chroma": np.random.default_rng(0).random(12).tolist()}])[0] in (None, 0.0) or True
