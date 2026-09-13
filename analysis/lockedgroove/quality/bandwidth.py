"""True bandwidth of a file: the highest frequency still carrying real energy.

A 320 kbps encode stops around 20 kHz, a 128 kbps one around 16, an old rip
off a cassette or a 64 kbps stream far lower. Nothing downstream can put back
what the file never had, so the library measures this once, on the native
signal, and the product says it out loud: *this flip is limited by the record,
not by us.* The uploads in the first real sessions measured 12.0 to 15.7 kHz.

How it is measured:

1. Average power spectrum over the loud frames only (silence and fade-outs have
   no top end and would drag the edge down). Per-bin high percentile across
   frames, so one bright cymbal crash is enough to prove the band is there.
2. Smooth over ~100 Hz and express in dB relative to the in-band peak.
3. The edge is the highest frequency still above ``FLOOR_DB``.
4. Look for a cliff at that edge - a drop of ``CLIFF_DROP_DB`` or more inside a
   span narrower than ``CLIFF_SPAN`` of the edge frequency. A cliff is an
   encoder lowpass and is reported with high confidence; a gentle taper is a
   natural rolloff and is reported with less.

Confidence is honest about what the measurement cannot see: when the content
runs all the way to Nyquist the file's own sample rate is the limit, not the
material, and that is said in the note.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .metrics import to_mono

FLOOR_DB = -60.0          # "real energy" relative to the in-band peak
CLIFF_DROP_DB = 25.0      # a drop this steep is an encoder lowpass, not a rolloff
CLIFF_SPAN = 0.08         # ...measured across this fraction of the edge frequency
SMOOTH_HZ = 100.0
FRAME_FLOOR_DB = 40.0     # frames quieter than this below the loudest are ignored
NYQUIST_MARGIN = 0.97     # an edge above this fraction of Nyquist is rate-limited
PERCENTILE = 90.0
MIN_SAMPLES = 2048
MAX_FRAMES = 512        # evenly spaced across the file; a whole record's STFT is not needed

METHOD = ("highest frequency above -60 dB of the in-band peak, from the 90th-percentile spectrum of the "
          "loud frames; a >=25 dB drop inside 8% of that frequency is reported as an encoder lowpass")


@dataclass(frozen=True)
class Bandwidth:
    """``hz`` is the edge; ``lowpassed`` says whether it looks like an encoder cut."""

    hz: Optional[float]
    confidence: float
    method: str
    notes: str
    lowpassed: bool = False
    nyquist_limited: bool = False

    def to_json(self) -> dict:
        return {"value": None if self.hz is None else round(self.hz, 1),
                "confidence": round(self.confidence, 3), "method": self.method, "notes": self.notes}


def _loud_frame_spectrum(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    mono = to_mono(y)
    if mono.size < MIN_SAMPLES or sr <= 0:
        return np.zeros(0), np.zeros(0)
    n_fft = 4096 if mono.size >= 4096 else 2048
    hop = n_fft // 2
    win = np.hanning(n_fft)
    starts = np.arange(0, mono.size - n_fft + 1, hop)
    if starts.size == 0:
        return np.zeros(0), np.zeros(0)
    if starts.size > MAX_FRAMES:
        starts = starts[np.linspace(0, starts.size - 1, MAX_FRAMES).round().astype(int)]
    frames = mono[starts[:, None] + np.arange(n_fft)[None, :]] * win[None, :]
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    energy = power.sum(axis=1)
    if energy.max() <= 0.0:
        return np.zeros(0), np.zeros(0)
    keep = energy > energy.max() * 10 ** (-FRAME_FLOOR_DB / 10.0)
    return np.fft.rfftfreq(n_fft, 1.0 / sr), np.percentile(power[keep], PERCENTILE, axis=0)


def _smooth(freqs: np.ndarray, power: np.ndarray) -> np.ndarray:
    if freqs.size < 2:
        return power
    bin_hz = float(freqs[1] - freqs[0])
    width = max(1, int(round(SMOOTH_HZ / bin_hz)))
    if width <= 1:
        return power
    kernel = np.ones(width) / width
    return np.convolve(power, kernel, mode="same")


def measure_bandwidth(y: np.ndarray, sr: int, *, rate_is_native: bool = True) -> Bandwidth:
    """Measure the true bandwidth of ``y``. Pass ``rate_is_native=False`` for a resampled signal."""
    freqs, power = _loud_frame_spectrum(y, sr)
    if freqs.size == 0 or power.max() <= 0.0:
        return Bandwidth(hz=None, confidence=0.0, method=METHOD,
                         notes="no measurable signal (silence or too short)")
    nyquist = sr / 2.0
    smooth = _smooth(freqs, power)
    in_band = freqs <= nyquist * 0.95
    peak = float(smooth[in_band].max()) if np.any(in_band) else float(smooth.max())
    if peak <= 0.0:
        return Bandwidth(hz=None, confidence=0.0, method=METHOD, notes="no measurable signal")
    level_db = 10.0 * np.log10(np.maximum(smooth, peak * 1e-14) / peak)

    above = np.flatnonzero(level_db >= FLOOR_DB)
    if above.size == 0:
        return Bandwidth(hz=None, confidence=0.0, method=METHOD, notes="no band clears the measurement floor")
    edge_i = int(above[-1])
    edge = float(freqs[edge_i])

    span_hi = edge * (1.0 + CLIFF_SPAN)
    tail = (freqs > edge) & (freqs <= span_hi)
    drop = float(level_db[edge_i] - np.median(level_db[tail])) if np.any(tail) else 0.0
    lowpassed = drop >= CLIFF_DROP_DB

    if edge >= nyquist * NYQUIST_MARGIN:
        note = (f"content runs to the file's own ceiling ({nyquist / 1000:.1f} kHz); "
                "the sample rate is the limit, not the record")
        if not rate_is_native:
            note = (f"measured on a {sr / 1000:.1f} kHz working copy, so nothing above "
                    f"{nyquist / 1000:.1f} kHz can be seen; re-measure on the upload")
        return Bandwidth(hz=nyquist, confidence=0.5 if rate_is_native else 0.2, method=METHOD,
                         notes=note, lowpassed=False, nyquist_limited=True)

    if not rate_is_native:
        return Bandwidth(hz=edge, confidence=0.3, method=METHOD, lowpassed=lowpassed,
                         notes=(f"measured on a {sr / 1000:.1f} kHz working copy rather than the upload; "
                                "treat as a lower bound"))
    if lowpassed:
        return Bandwidth(hz=edge, confidence=0.9, method=METHOD, lowpassed=True,
                         notes=(f"sharp cut at {edge / 1000:.1f} kHz ({drop:.0f} dB inside "
                                f"{CLIFF_SPAN * 100:.0f}%), the signature of a lossy encode"))
    return Bandwidth(hz=edge, confidence=0.6, method=METHOD, lowpassed=False,
                     notes=f"energy tapers off above {edge / 1000:.1f} kHz with no encoder cut")


__all__ = ["Bandwidth", "CLIFF_DROP_DB", "FLOOR_DB", "METHOD", "measure_bandwidth"]
