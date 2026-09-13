"""Beats and downbeats: ``librosa.beat.beat_track`` pinned to the tempo section, refined on onsets.

Method
------
1. ``librosa.beat.beat_track(onset_envelope, bpm=hint, units="time", trim=False)`` at hop
   256 (11.6 ms). The hint is ``ctx.report.tempo.bpm``; the tempo stage owns the octave
   decision (prior 95 BPM), so the tracker does not re-decide it. Without a tempo section
   ``start_bpm=95`` is used and ``notes`` says so.
2. Refinement against backtracked onsets (``onsets.detect_onsets``, hop 64):
   - the whole grid is shifted by the median beat-to-onset offset (the tracker runs
     20-40 ms late on percussive material at frame resolution; a global shift keeps the
     per-beat groove intact);
   - a beat further than ``OUTLIER_FRAC`` of the local period from the median prediction
     of its ±6 neighbours is put back on the grid (the DP grabs an off-beat kick now and
     then; a run of a few bad beats is fixed by the wide window);
   - leading and trailing beats with no onset within ``TRIM_WIN_S`` before the first or
     after the last onset are dropped (silence at the ends). ``grid.extend_beats`` gives
     consumers a full-file grid when they need one.
3. Downbeat phase: the signal is low-passed below ``LOW_CUTOFF_HZ`` (zero-phase
   Butterworth), its RMS envelope's positive increments are read at each beat, and the
   phase (0..beats_per_bar-1) whose beats carry the highest mean low-band onset energy
   wins. Meter comes from ``ctx.options["meter"]`` (default 4/4; ``grid.beats_per_bar``).

Confidence
----------
``confidence`` = fraction of predicted beats within ±30 ms of a detected onset (0 when
there are no beats or no onsets).
``downbeat_confidence`` = normalized margin between the winning phase and the runner-up:
``(best - second) / best`` over the per-phase mean low-band onset energy (0 when nothing
in the low band moves, e.g. four-on-the-floor kicks make every phase equal).
"""

from __future__ import annotations

import numpy as np

from ..report import Beats
from . import grid
from .onsets import detect_onsets

HOP_LENGTH = 256
PRIOR_BPM = 95.0
ONSET_TOL_S = 0.03
ANCHOR_WIN_S = 0.06
TRIM_WIN_S = 0.08
OUTLIER_FRAC = 0.15
OUTLIER_NEIGHBOURS = 6
LOW_CUTOFF_HZ = 150.0
LOW_FILTER_ORDER = 6
METHOD = f"librosa.beat.beat_track(bpm=tempo hint, hop={HOP_LENGTH}); onset-anchored offset, outlier regrid, edge trim"
DOWNBEAT_METHOD = f"low-band (<{LOW_CUTOFF_HZ:.0f} Hz) onset energy phase selection"


def track_beats(y: np.ndarray, sr: int, bpm: float | None) -> np.ndarray:
    """Raw beat times from librosa's dynamic-programming tracker (seconds, float64)."""
    import librosa

    y = np.asarray(y, dtype=np.float32)
    if y.size < 2048 or not np.any(y):
        return np.zeros(0)
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    if oenv.size == 0 or not np.any(oenv > 0):
        return np.zeros(0)
    kwargs = {"bpm": float(bpm)} if bpm else {"start_bpm": PRIOR_BPM}
    _, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=HOP_LENGTH, units="time", trim=False, **kwargs)
    beats = np.sort(np.asarray(beats, dtype=float))
    return beats[np.isfinite(beats)]


def _global_offset(beats: np.ndarray, onsets: np.ndarray) -> float:
    if beats.size == 0 or onsets.size == 0:
        return 0.0
    idx = np.clip(np.searchsorted(onsets, beats), 0, onsets.size - 1)
    idx_prev = np.clip(idx - 1, 0, onsets.size - 1)
    d1 = onsets[idx] - beats
    d0 = onsets[idx_prev] - beats
    d = np.where(np.abs(d1) < np.abs(d0), d1, d0)
    d = d[np.abs(d) <= ANCHOR_WIN_S]
    return float(np.median(d)) if d.size else 0.0


def _suppress_outliers(beats: np.ndarray) -> np.ndarray:
    b = beats.copy()
    n = b.size
    if n < 5:
        return b
    for _ in range(2):
        for i in range(n):
            lo, hi = max(0, i - OUTLIER_NEIGHBOURS), min(n, i + OUTLIER_NEIGHBOURS + 1)
            local = b[lo:hi]
            period = grid.beat_period_s(local)
            if period <= 0:
                continue
            preds = [b[j] - (j - i) * period for j in range(lo, hi) if j != i]
            pred = float(np.median(preds))
            if abs(b[i] - pred) > OUTLIER_FRAC * period:
                b[i] = pred
    return np.sort(b)


def _trim_edges(beats: np.ndarray, onsets: np.ndarray) -> np.ndarray:
    if beats.size == 0 or onsets.size == 0:
        return beats
    keep = (beats >= onsets[0] - TRIM_WIN_S) & (beats <= onsets[-1] + TRIM_WIN_S)
    return beats[keep]


def refine_beats(beats: np.ndarray, onsets: np.ndarray) -> np.ndarray:
    """Global onset offset, outlier regrid, edge trim (see the module docstring)."""
    if beats.size == 0:
        return beats
    beats = beats + _global_offset(beats, onsets)
    beats = _suppress_outliers(beats)
    beats = _trim_edges(beats, onsets)
    # a first beat shifted a few ms before zero is the beat at zero, not a beat to drop
    beats = beats[beats >= -ANCHOR_WIN_S]
    return np.maximum(beats, 0.0)


def onset_agreement(beats: np.ndarray, onsets: np.ndarray, tol_s: float = ONSET_TOL_S) -> float:
    """Fraction of beats with an onset within ±tol_s."""
    if beats.size == 0 or onsets.size == 0:
        return 0.0
    idx = np.clip(np.searchsorted(onsets, beats), 0, onsets.size - 1)
    idx_prev = np.clip(idx - 1, 0, onsets.size - 1)
    d = np.minimum(np.abs(onsets[idx] - beats), np.abs(onsets[idx_prev] - beats))
    return float(np.mean(d <= tol_s))


def low_band_onset_at_beats(y: np.ndarray, sr: int, beats: np.ndarray) -> np.ndarray:
    """Positive increment of the low-passed RMS envelope, max within [-30, +60] ms of each beat."""
    import librosa
    import scipy.signal

    if beats.size == 0 or y.size < 512:
        return np.zeros(beats.size)
    nyq = 0.5 * sr
    sos = scipy.signal.butter(LOW_FILTER_ORDER, min(LOW_CUTOFF_HZ, 0.45 * nyq) / nyq, btype="low", output="sos")
    low = scipy.signal.sosfiltfilt(sos, np.asarray(y, dtype=np.float64)).astype(np.float32)
    hop = 64
    rms = librosa.feature.rms(y=low, frame_length=512, hop_length=hop)[0]
    inc = np.maximum(0.0, np.diff(rms, prepend=rms[:1]))
    frame_t = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=hop)
    out = np.zeros(beats.size)
    for i, b in enumerate(beats):
        lo = np.searchsorted(frame_t, b - 0.03)
        hi = np.searchsorted(frame_t, b + 0.06)
        if hi > lo:
            out[i] = float(inc[lo:hi].max())
    return out


def downbeat_phase(y: np.ndarray, sr: int, beats: np.ndarray, beats_per_bar: int) -> tuple[int, float]:
    """Winning phase and its normalized margin over the runner-up."""
    if beats.size < beats_per_bar or beats_per_bar < 2:
        return 0, 0.0
    energy = low_band_onset_at_beats(y, sr, beats)
    scores = np.array([energy[p::beats_per_bar].mean() if energy[p::beats_per_bar].size else 0.0 for p in range(beats_per_bar)])
    if not np.any(scores > 0):
        return 0, 0.0
    order = np.argsort(scores)[::-1]
    best, second = float(scores[order[0]]), float(scores[order[1]])
    return int(order[0]), float(np.clip((best - second) / best, 0.0, 1.0))


def run(y: np.ndarray, sr: int, ctx) -> Beats:
    """Beats section. ``confidence`` = fraction of beats within ±30 ms of an onset;
    ``downbeat_confidence`` = normalized margin between the winning phase and the runner-up."""
    meter = str(ctx.options.get("meter") or "4/4")
    bpb = grid.beats_per_bar(meter)
    tempo = ctx.report.tempo
    hint = float(tempo.bpm) if tempo is not None and tempo.bpm > 0 else None
    notes = None if hint else f"no tempo section; beat_track(start_bpm={PRIOR_BPM:g})"
    y = np.asarray(y, dtype=np.float32)
    # Phase 2: a neural tracker behind the same interface (lockedgroove.analysis.beat_tracking).
    # BeatNet also returns downbeats; when it ran, those decide the phase instead of the low band.
    from . import beat_tracking

    backend = str(ctx.options.get("beat_backend") or beat_tracking.default_backend())
    neural = None
    method = METHOD
    downbeat_method = DOWNBEAT_METHOD
    if backend == "beatnet":
        neural = beat_tracking.track_beats(y, sr, backend="beatnet", start_bpm=hint or PRIOR_BPM)
        if neural.method != "beatnet":
            notes = "; ".join(n for n in [notes, *neural.notes] if n) or None
            neural = None
    if neural is not None:
        raw = np.asarray(neural.beats_s, dtype=float)
        method = "beatnet (DBN, offline); onset-anchored refinement"
    else:
        try:
            raw = track_beats(y, sr, hint)
        except Exception as exc:
            raw = np.zeros(0)
            notes = f"beat_track failed: {type(exc).__name__}"
    onsets = detect_onsets(y, sr)
    try:
        beats = refine_beats(raw, onsets) if raw.size else raw
    except Exception:
        beats = raw
    confidence = onset_agreement(beats, onsets)
    if neural is not None and neural.downbeats_s and beats.size:
        first = neural.downbeats_s[0]
        phase = int(np.argmin(np.abs(beats - first))) % bpb
        dconf = 0.8
        downbeat_method = "beatnet downbeats"
    else:
        try:
            phase, dconf = downbeat_phase(y, sr, beats, bpb)
        except Exception:
            phase, dconf = 0, 0.0
    downbeats = beats[phase::bpb] if beats.size else np.zeros(0)
    return Beats(
        times_s=[round(float(t), 4) for t in beats],
        confidence=round(float(np.clip(confidence, 0.0, 1.0)), 4),
        method=method,
        downbeats_s=[round(float(t), 4) for t in downbeats],
        downbeat_phase=int(phase),
        downbeat_confidence=round(float(np.clip(dconf, 0.0, 1.0)), 4),
        downbeat_method=downbeat_method,
        meter=meter,
        notes=notes,
    )


__all__ = ["DOWNBEAT_METHOD", "HOP_LENGTH", "METHOD", "downbeat_phase", "onset_agreement", "refine_beats", "run", "track_beats"]
