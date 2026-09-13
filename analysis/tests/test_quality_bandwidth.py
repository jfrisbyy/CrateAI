"""quality/bandwidth.py: the true bandwidth of a file, and what it is allowed to claim.

The real uploads in the first sessions measured 12.0 to 15.7 kHz. Those are the
numbers this has to get right, and it has to be honest about the cases where it
cannot see: silence, and a resampled working copy whose own Nyquist is lower
than the answer.
"""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.analysis import spectral as spectral_stage
from lockedgroove.pipeline import ANALYSIS_SR, Context, resample, to_mono
from lockedgroove.quality.bandwidth import measure_bandwidth
from lockedgroove.quality.fixtures import lossy_copy, transient_bed
from lockedgroove.report import AnalysisReport
from lockedgroove.testing import synth

SR = 44100
REAL_UPLOAD_CEILINGS = (12000.0, 13500.0, 15700.0)


def _wideband(seconds: float = 3.0, sr: int = SR) -> np.ndarray:
    rng = np.random.default_rng(3)
    times = np.arange(int(seconds * sr)) / sr
    y = rng.standard_normal(times.size) * 0.3 + 0.4 * np.sin(2 * np.pi * 220 * times)
    return (y / (np.abs(y).max() * 1.1)).astype(np.float32)


@pytest.mark.parametrize("cutoff", REAL_UPLOAD_CEILINGS)
def test_finds_an_encoder_lowpass_where_the_real_uploads_were(cutoff):
    measured = measure_bandwidth(lossy_copy(_wideband(), SR, cutoff), SR)
    assert measured.hz == pytest.approx(cutoff, abs=150.0)
    assert measured.lowpassed is True
    assert measured.confidence >= 0.8
    assert "lossy" in measured.notes


def test_full_band_material_reads_as_limited_by_the_file_not_the_record():
    measured = measure_bandwidth(_wideband(), SR)
    assert measured.nyquist_limited is True
    assert measured.hz == pytest.approx(SR / 2, abs=1.0)
    assert measured.confidence <= 0.5          # we cannot see past Nyquist, and say so
    assert "sample rate is the limit" in measured.notes


def test_a_natural_rolloff_is_not_called_an_encoder_cut():
    from scipy.signal import butter, sosfiltfilt

    sos = butter(4, 9000.0 / (SR / 2), btype="lowpass", output="sos")
    gentle = sosfiltfilt(sos, _wideband()).astype(np.float32)
    measured = measure_bandwidth(gentle, SR)
    assert measured.lowpassed is False
    assert 0.4 < measured.confidence < 0.8     # measured, but hedged


def test_a_working_copy_is_not_allowed_to_claim_the_source_bandwidth():
    """Measured at the analysis rate the answer is always 11 kHz, which would be a lie."""
    import librosa

    source = lossy_copy(_wideband(), SR, 15700.0)
    working = librosa.resample(source, orig_sr=SR, target_sr=ANALYSIS_SR)
    measured = measure_bandwidth(working, ANALYSIS_SR, rate_is_native=False)
    assert measured.confidence <= 0.3
    assert "working copy" in measured.notes


def test_silence_and_scraps_withhold_the_value():
    for signal in (np.zeros(SR, dtype=np.float32), np.zeros(10, dtype=np.float32)):
        measured = measure_bandwidth(signal, SR)
        assert measured.hz is None
        assert measured.confidence == 0.0
        assert measured.method


def test_the_spectral_stage_carries_it_into_the_report():
    native = synth.to_stereo(lossy_copy(_wideband(), SR, 13500.0), width=0.3)
    ctx = Context(report=AnalysisReport.empty(), sr=ANALYSIS_SR, native=(native, SR))
    section = spectral_stage.run(resample(to_mono(native), SR, ANALYSIS_SR), ANALYSIS_SR, ctx)
    assert section.bandwidth is not None
    assert section.bandwidth.value == pytest.approx(13500.0, abs=200.0)
    assert section.bandwidth.confidence >= 0.8
    assert section.bandwidth.method


def test_without_the_native_signal_the_estimate_hedges_itself():
    y, _ = transient_bed(ANALYSIS_SR, seconds=2.0)
    section = spectral_stage.run(y, ANALYSIS_SR, Context(report=AnalysisReport.empty(), sr=ANALYSIS_SR))
    assert section.bandwidth is not None
    assert section.bandwidth.confidence <= 0.3
