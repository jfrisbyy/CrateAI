"""loudness.py: BS.1770-4 integrated LUFS, 4x-oversampled true peak, EBU Tech 3342 loudness range."""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.analysis import loudness as loudness_stage
from lockedgroove.pipeline import ANALYSIS_SR, Context, resample, to_mono
from lockedgroove.report import AnalysisReport, Loudness
from lockedgroove.testing import synth

SR = 44100


def _ctx(native: np.ndarray, sr: int = SR) -> Context:
    return Context(report=AnalysisReport.empty(), sr=ANALYSIS_SR, native=(native, sr))


def _analysis(native: np.ndarray, sr: int = SR) -> np.ndarray:
    return resample(to_mono(native), sr, ANALYSIS_SR)


def test_minus_20_dbfs_stereo_sine():
    s = synth.sine(1000.0, 5.0, SR, amplitude=10 ** (-20 / 20))
    native = np.stack([s, s])
    res = loudness_stage.run(_analysis(native), ANALYSIS_SR, _ctx(native))
    assert isinstance(res, Loudness)
    assert abs(res.integrated_lufs - (-20.0)) <= 1.0
    assert abs(res.true_peak_dbtp - (-20.0)) <= 0.3
    assert res.loudness_range_lu == pytest.approx(0.0, abs=0.5)
    assert res.method


def test_minus_20_dbfs_mono_sine_follows_the_single_channel_convention():
    # BS.1770: a 0 dBFS sine on one channel reads -3.01 LKFS, so a mono -20 dBFS sine is -23 LUFS.
    s = synth.sine(1000.0, 5.0, SR, amplitude=10 ** (-20 / 20))
    res = loudness_stage.run(_analysis(s), ANALYSIS_SR, _ctx(s))
    assert abs(res.integrated_lufs - (-23.0)) <= 1.0


def test_true_peak_sees_intersample_peaks():
    # a tone near Nyquist/4 sampled off-peak has a true peak above its sample peak
    t = np.arange(int(SR * 1.0)) / SR
    x = (0.5 * np.sin(2 * np.pi * 11025.0 * t + 0.4)).astype(np.float32)
    res = loudness_stage.run(_analysis(x), ANALYSIS_SR, _ctx(x))
    assert res.true_peak_dbtp >= 20 * np.log10(np.max(np.abs(x))) - 0.05
    assert abs(res.true_peak_dbtp - (-6.02)) <= 0.3


def test_loudness_range_two_levels():
    lo = synth.sine(1000.0, 10.0, SR, amplitude=10 ** (-30 / 20))
    hi = synth.sine(1000.0, 10.0, SR, amplitude=10 ** (-10 / 20))
    x = np.concatenate([lo, hi])
    res = loudness_stage.run(_analysis(x), ANALYSIS_SR, _ctx(x))
    assert abs(res.loudness_range_lu - 20.0) <= 2.0


def test_silence_and_short_audio_do_not_raise():
    for native in (np.zeros(SR * 3, dtype=np.float32), np.zeros((2, 1000), dtype=np.float32), np.zeros(0, dtype=np.float32),
                   synth.sine(440.0, 0.1, SR)):
        res = loudness_stage.run(_analysis(native) if native.size else native, ANALYSIS_SR, _ctx(native))
        assert isinstance(res, Loudness)
        assert np.isfinite(res.integrated_lufs) and np.isfinite(res.true_peak_dbtp) and np.isfinite(res.loudness_range_lu)
        assert res.loudness_range_lu >= 0.0
    silent = loudness_stage.run(np.zeros(ANALYSIS_SR * 3, dtype=np.float32), ANALYSIS_SR, _ctx(np.zeros(SR * 3, dtype=np.float32)))
    assert silent.integrated_lufs == loudness_stage.LUFS_FLOOR
    assert silent.true_peak_dbtp == loudness_stage.TRUE_PEAK_FLOOR


def test_falls_back_to_analysis_signal_without_native():
    s = synth.sine(1000.0, 5.0, ANALYSIS_SR, amplitude=10 ** (-20 / 20))
    res = loudness_stage.run(s, ANALYSIS_SR, Context(report=AnalysisReport.empty(), sr=ANALYSIS_SR))
    assert abs(res.integrated_lufs - (-23.0)) <= 1.0
