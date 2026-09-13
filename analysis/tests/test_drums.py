import numpy as np

from lockedgroove.analysis import drums
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, Beats, Tempo
from lockedgroove.testing.synth import Pattern, drum_loop, hat, kick, snare

SR = 22050


def _report(bpm, bars):
    beat = 60.0 / bpm
    times = [i * beat for i in range(bars * 4 + 1)]
    return AnalysisReport(tempo=Tempo(bpm=bpm, confidence=0.9, method="t", alternates_bpm=[bpm / 2, bpm * 2]),
                          beats=Beats(times_s=times, confidence=0.9, method="b", downbeats_s=times[::4],
                                      downbeat_phase=0, downbeat_confidence=0.9, downbeat_method="d"))


def test_hit_classes_from_cues():
    for sample, cls in ((kick(SR), "kick"), (snare(SR), "snare"), (hat(SR), "hat")):
        c, low, mid, decay, spec, _high = drums._segment_features(sample, SR)
        assert drums.classify(c, low, mid) == cls, (cls, c, low, mid)
        assert abs(np.linalg.norm(spec) - 1) < 1e-5


def test_programmed_pattern_lands_on_exact_grid():
    bpm, bars = 92.0, 8
    y = drum_loop(bpm, bars, Pattern.boom_bap(), SR, jitter_ms=0.0, spectral_variation=0.0)
    out = drums.run(y, SR, Context(report=_report(bpm, bars), sr=SR, stems={"drums": y}))
    assert out.source_estimate == "programmed", out.notes
    assert out.source_confidence > 0.5
    assert len(out.patterns) == 1
    p = out.patterns[0]
    assert sorted(h.step for h in p.kick if h.frequency >= 0.5) == [0, 7, 10]
    assert sorted(h.step for h in p.snare if h.frequency >= 0.5) == [4, 11, 12]
    hat_steps = sorted(h.step for h in p.hat if h.frequency >= 0.5)
    # hats stacked on kicks (0, 10) come back through the high band; hats under snares (4, 12) are a known gap
    assert {0, 2, 6, 8, 10, 14} <= set(hat_steps) and set(hat_steps) <= set(range(0, 16, 2))
    assert p.ghost_notes == [11]
    assert 0 in p.accents and 4 in p.accents and 12 in p.accents
    assert all(abs(h.offset_ms) < 4.0 for h in p.kick + p.snare)
    assert 10 <= p.density_per_bar <= 12.5
    assert "drums stem" in out.method


def test_jittered_varied_pattern_reads_as_sampled_break():
    bpm, bars = 92.0, 8
    y = drum_loop(bpm, bars, Pattern.boom_bap(), SR, jitter_ms=8.0, spectral_variation=0.25, velocity_jitter=0.2, seed=7)
    out = drums.run(y, SR, Context(report=_report(bpm, bars), sr=SR, stems={"drums": y}))
    assert out.source_estimate == "sampled_break", out.notes
    assert out.source_confidence > 0.3
    p = out.patterns[0]
    assert {0, 10} <= {h.step for h in p.kick if h.frequency >= 0.5}


def test_open_hat_ratio_and_mix_fallback():
    bpm, bars = 100.0, 4
    pat = Pattern(kick={0: 1.0, 8: 1.0}, snare={4: 1.0, 12: 1.0}, hat={s: 0.6 for s in range(0, 14, 2)}, open_hat={15: 0.7})
    y = drum_loop(bpm, bars, pat, SR)
    out = drums.run(y, SR, Context(report=_report(bpm, bars), sr=SR))
    assert "mix" in out.method and out.notes and "separate stems" in out.notes
    p = out.patterns[0]
    assert p.hat_open_ratio is not None and 0.05 <= p.hat_open_ratio <= 0.3


def test_too_few_hits_is_unknown():
    y = drum_loop(90.0, 1, Pattern(kick={0: 1.0}), SR)
    out = drums.run(y, SR, Context(report=_report(90.0, 1), sr=SR, stems={"drums": y}))
    assert out.source_estimate == "unknown" and out.source_confidence == 0.0
