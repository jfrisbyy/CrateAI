"""Loop finder: ranked, explainable loop candidates from the effective beat grid.

BUILD_PACKET section 7. ``find_loops(y, sr, report)`` turns the *effective*
AnalysisReport (``effective(report)``: user edits win over predictions) into
loop candidates ``[anchor_i, anchor_(i+n))`` for ``n`` in ``bars`` and scores
each one in ``[0, 1]``:

    score = 0.30 * seam + 0.22 * phrase + 0.15 * stability + 0.15 * novelty
          + 0.10 * onset_lock + 0.08 * recurrence

Why ``phrase`` and ``recurrence`` exist
---------------------------------------
The original four terms all measure *how little goes wrong inside the span*,
and a short span has less inside it. Measured on the sample-pair record (40 s,
16 bars, the pipeline's own beat grid), the mean of each term by bar count was::

    bars=1  seam 0.599  stability 0.950  novelty 1.000  ->  score 0.827
    bars=2  seam 0.564  stability 0.949  novelty 0.972  ->  score 0.806
    bars=4  seam 0.531  stability 0.948  novelty 0.904  ->  score 0.776
    bars=8  seam 0.615  stability 0.947  novelty 0.741  ->  score 0.768

``novelty`` is a pure length penalty -- a longer span crosses more section
boundaries -- and ``seam`` decays with length because two 100 ms windows 2 s
apart are more alike than two 16 s apart. ``stability`` is flat. Nothing scored
*being a musically useful length*, so one-bar candidates swept the top by
construction and the four bars a producer actually flipped ranked 50th of 52.
A producer looking for something to rap over is nearly never looking for one bar.

The fix is not a bonus for length -- a two-bar break is sometimes exactly right
-- but two terms that say what makes a span a loop instead of a fragment, both
built from measurements the pipeline already makes.

``seam``
    How the loop point sounds, averaged over the two ways it is played:
    *raw* (tail -> head: mel-spectrogram cosine similarity between the last
    100 ms and the first 100 ms of the loop, plus RMS continuity across those
    windows) and *rendered* (what the tail crossfade in ``render.py`` actually
    plays: the 100 ms after ``end`` flowing into the head, same two measures;
    at end of file the renderer blends the 100 ms before ``start`` into the
    tail instead, so that pair is compared; with neither, rendered = raw).
    The cosine is taken on log-mel (dB) with the track's per-bin mean removed,
    so the shared spectral floor does not inflate every pair to ~0.95, and is
    mapped from [-1, 1] to [0, 1]. RMS continuity is ``min / max`` of the two
    window RMS values (equal levels 1.0, a 6 dB step 0.5).
    ``seam = 0.5 * seam_mel + 0.5 * seam_rms``; ``components`` also carries
    ``seam_raw`` and ``seam_wrap`` separately so the UI can say which playback
    mode the loop point favours.
``stability``
    ``1 - var / mean^2`` of the per-beat RMS inside the loop (beats from the
    effective grid), clipped to [0, 1].
``novelty``
    ``1 / (1 + sum of confidences of structure boundaries strictly inside the
    loop)``; 1.0 when ``report.structure`` is null. A boundary counts as
    interior only when it lies more than half a beat from either edge.
``onset_lock``
    1.0 when an onset lies within ±20 ms of the start, decaying linearly to 0
    at ±80 ms. Onsets come from ``report.onsets``; when that section is null
    they are detected locally (librosa, backtracked).
``phrase``
    Is this a musically useful length, and does it sit where a phrase sits?
    ``0.6 * phrase_length + 0.4 * phrase_alignment``.

    ``phrase_length`` is ``BAR_PRIOR[bars]`` -- four bars is the default unit
    of a sampled loop in this music, two bars is the break, eight bars is a
    long phrase you chop down, one bar is a one-shot -- multiplied by how well
    that length agrees with the loop period ``structure`` measured for *this*
    record (``PERIOD_AGREEMENT``, faded in by ``loop_period_confidence``, so a
    record that makes no claim leaves the prior alone; principle 2). The
    record can pull the prior down where its own structure contradicts it and
    can never invent a preference the measurement does not support.

    ``phrase_alignment`` asks whether the candidate starts on a phrase line:
    the offset of its start anchor from a phrase origin, modulo its own
    length, scaled so a whole-phrase start is 1.0 and a start half a phrase
    late is 0.0. Phrase origins are the first anchor plus every measured
    section start, and the best origin wins -- a record with a two-bar intro
    still has its phrases found. This is the term that separates "bars 5-8"
    from "the window that happens to start in the middle of bar 6".
``recurrence``
    Does this content actually come back in the record? The number of *other*
    candidates of the same length whose fingerprint matches this one (cosine
    >= ``REPEAT_SIMILARITY``), saturating at ``RECURRENCE_FULL``. Counted on
    the deduped set before the repeat collapse, so it measures the record
    rather than which candidates happened to survive -- which is also what
    keeps it, and therefore the score, blind to stems. The main loop
    of a record recurs; the intro, the bridge and the outro do not. Nothing
    here favours length: a one-bar cell recurs as readily as a four-bar
    phrase, which is exactly why it is a separate term from ``phrase``.

Anchors are the effective downbeats when
``beats.downbeat_confidence >= DOWNBEAT_CONFIDENCE_THRESHOLD`` (OPEN_QUESTIONS
C.16). Otherwise every beat is tried as a start and a bar is the meter's
beats-per-bar beats long. One bar's worth of anchors is extrapolated past the
last measured one when it still lands inside the file, so the final bar(s) of
a track can be a loop; those candidates carry ``extrapolated_end: true``.

When the file has stems, each surviving candidate also gets a per-stem energy
profile and the claims a producer actually digs for -- vocal-free, drums-free,
drums-only, fullness -- under ``components["sample_ready"]`` (see
``sample_ready.py``). The six scored terms above are **not** touched by it:
a loop's score means the same thing with or without stems. The only thing the
stem profile moves is the order the candidates come back in, through
``ranking_factor``, which is 1.0 for everything except a span with a single
lone part in it (a bass note on its own); a drums-only break is a find, not a
lone part, and keeps 1.0. Without stems the factor is 1.0 everywhere and the
result is identical to what it has always been.

Personalization is deliberately *not* here. ``find_loops`` returns the measured
ranking and nothing else, so the accuracy harness always scores what ships by
default; a producer's own corrections are applied on top of this result by
``lockedgroove.learn.loop_prefs`` inside the job (principle 7).

Deduping: candidates with the same bar count whose starts are within 30 ms of
each other collapse onto the higher score; contiguous repeats of the same
content (mel fingerprint similarity >= ``REPEAT_SIMILARITY``) collapse onto
the earliest one, which reports the count in ``components["repeats"]``. With
stems, a repeat only folds onto its head when the same stems are playing in
both: the intro and the identical bars with the singer over them are two
different loops to anyone flipping them.

Every weight and threshold is a module constant: tune only against the
accuracy harness (principle 9).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..pipeline import ANALYSIS_SR, resample, to_mono
from ..report import AnalysisReport, effective
from .sample_ready import SampleReady, StemSource, sample_ready, stem_energies
from .sample_ready import reasons as stem_reasons

# --- constants (BUILD_PACKET section 7; tune only against the harness) -------------------------

DOWNBEAT_CONFIDENCE_THRESHOLD = 0.5
"""Use downbeats as loop anchors at or above this confidence, else beats (OPEN_QUESTIONS C.16)."""

WEIGHT_SEAM = 0.30
WEIGHT_PHRASE = 0.22
WEIGHT_STABILITY = 0.15
WEIGHT_NOVELTY = 0.15
WEIGHT_ONSET_LOCK = 0.10
WEIGHT_RECURRENCE = 0.08
WEIGHTS: dict[str, float] = {
    "seam": WEIGHT_SEAM,
    "phrase": WEIGHT_PHRASE,
    "stability": WEIGHT_STABILITY,
    "novelty": WEIGHT_NOVELTY,
    "onset_lock": WEIGHT_ONSET_LOCK,
    "recurrence": WEIGHT_RECURRENCE,
}
"""The scored terms and their weights; they sum to 1 so ``score`` stays in [0, 1].

``seam``, ``stability`` and ``novelty`` all fall with length (see the module
docstring), so their share dropped from 0.90 to 0.60 and the 0.30 freed went to
the two terms that measure length *musically*. ``seam`` keeps the largest single
weight because it is the only term that measures what the loop point sounds
like; ``stability`` lost the most because it measured almost nothing (0.947 to
0.950 across every bar count on the pair record) while still being a proxy for
"nothing happens in here", which is precisely what penalizes a phrase with a
fill in it. ``onset_lock`` is unchanged: it is the only term that never had a
length bias, because it looks at the start alone.
"""

BAR_PRIOR: dict[int, float] = {1: 0.25, 2: 0.70, 4: 1.00, 8: 0.85}
"""How much of a loop each bar count is, before the record gets a say.

Four bars is the default unit of a sampled loop in this music; two bars is the
break; eight bars is a long phrase, usually chopped down; one bar is a one-shot,
not something to rap over. The shape is a peak at four, not a ramp -- a bonus
for length would put every eight-bar candidate on top, and a two-bar break is
sometimes exactly right. ``BAR_PRIOR_DEFAULT`` covers anything else (3, 16, a
meter-driven oddity): neither preferred nor rejected.

This is the one term a producer's own corrections move (``learn.loop_prefs``).
"""
BAR_PRIOR_DEFAULT = 0.45

PERIOD_AGREEMENT: dict[float, float] = {1.0: 1.00, 0.5: 0.90, 2.0: 0.80, 0.25: 0.45, 4.0: 0.45}
"""``bars / loop_period_bars`` -> how well the length agrees with the record.

A candidate the length of the measured loop period *is* the record's repeating
unit (1.00). Half of it is one of the two phrases in that unit, which is the
most common flip there is (0.90) -- an ABAB record measures a period of 8 bars
and a producer takes 4. Twice it is two statements (0.80). A quarter or four
times is a fragment or a stack of phrases (0.45). Anything else -- a 4-bar
candidate on a record that repeats every 3 -- gets ``PERIOD_AGREEMENT_OTHER``.
The whole table is faded in by ``structure.loop_period_confidence``, so a record
that measured no period changes nothing.
"""
PERIOD_AGREEMENT_OTHER = 0.35

PHRASE_LENGTH_SHARE = 0.6
"""How much of ``phrase`` is the length and how much is where the span starts.

The length is the bigger half because it is the claim that fixes the bug; the
alignment is the discriminator *within* a length, and it depends on a bar grid
that can be a bar out of phase on a real record, so it does not get a veto.
"""

RECURRENCE_FULL = 2
"""Content that comes back this many times elsewhere is fully "a loop the record plays"."""

DEFAULT_BARS: tuple[int, ...] = (1, 2, 4, 8)
SEAM_WINDOW_S = 0.100
"""Length of the tail and head windows compared for the seam score."""
ONSET_LOCK_FULL_MS = 20.0
"""An onset this close to the start scores onset_lock = 1."""
ONSET_LOCK_ZERO_MS = 80.0
"""onset_lock decays linearly to 0 at this distance."""
DEDUPE_START_MS = 30.0
"""Same bar count and starts within this many ms -> near-identical, keep the higher score."""
REPEAT_SIMILARITY = 0.90
"""Fingerprint cosine at or above this marks a contiguous candidate as a repeat."""
FINGERPRINT_BINS_PER_BAR = 16
"""Time resolution of the repeat fingerprint (a 16th-note grid per bar)."""
NOVELTY_BOUNDARY_TOLERANCE_BEATS = 0.5
"""A structure boundary within this many beats of a loop edge is that edge, not an interior one."""
CONTIGUOUS_TOLERANCE_BEATS = 0.5
"""A candidate starting within this many beats of another's end is contiguous with it."""
MIN_LOOP_S = 0.25
"""Shorter candidates cannot host two seam windows; they are skipped."""
SILENCE_RMS = 1e-3
"""Candidates whose RMS is below this (-60 dBFS) are silence, not loops."""

FEATURE_SR = ANALYSIS_SR
MEL_N_FFT = 1024
MEL_HOP = 256
MEL_N_MELS = 64
MEL_TOP_DB = 80.0


# --- public result type --------------------------------------------------------------------------


@dataclass
class LoopCandidate:
    """One ranked loop. ``components`` explains the score for the UI and the chat."""

    start_s: float
    end_s: float
    bars: int
    score: float
    components: dict[str, Any] = field(default_factory=dict)
    origin: str = "finder"
    name: str | None = None

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    def to_row(self) -> dict[str, Any]:
        """The ``loops`` table columns the finder fills (docs/BUILD_PACKET.md section 3).

        ``user_id``, ``file_id``, ``render_file_id`` and the timestamps are the
        job runner's to add.
        """
        return {
            "start_s": float(self.start_s),
            "end_s": float(self.end_s),
            "bars": int(self.bars),
            "score": float(self.score),
            "origin": self.origin,
            "components": self.components,
            "name": self.name,
        }


# --- helpers -------------------------------------------------------------------------------------


def beats_per_bar(meter: str) -> int:
    """Beats per bar for a meter string; same rule as ``lockedgroove.report`` (6/8 -> 2)."""
    try:
        num, den = meter.split("/")
        num_i, den_i = int(num), int(den)
    except (ValueError, AttributeError):
        return 4
    if den_i == 8 and num_i % 3 == 0:
        return max(1, num_i // 3)
    return max(1, num_i)


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na < 1e-12 and nb < 1e-12:
        return 1.0
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    return float(np.clip(np.dot(a, b) / (na * nb), -1.0, 1.0))


@dataclass
class _Features:
    """Everything the scorer needs, computed once per track at ``FEATURE_SR``."""

    sr: int
    mono: np.ndarray
    mel: np.ndarray
    """(n_mels, frames) log-mel dB with the per-bin track mean removed."""
    hop: int
    cumsq: np.ndarray
    """Cumulative sum of squares of ``mono`` (length n + 1) for O(1) RMS."""
    onsets_s: np.ndarray

    @property
    def n_frames(self) -> int:
        return int(self.mel.shape[1])

    def frame_range(self, t0: float, t1: float) -> tuple[int, int]:
        """Frames whose centre ``i * hop / sr`` lies in ``[t0, t1)``; never empty."""
        i0 = int(math.ceil(t0 * self.sr / self.hop - 1e-9))
        i1 = int(math.ceil(t1 * self.sr / self.hop - 1e-9))
        i0 = min(max(i0, 0), self.n_frames)
        i1 = min(max(i1, 0), self.n_frames)
        if i1 <= i0:
            i0 = min(i0, self.n_frames - 1)
            i1 = i0 + 1
        return i0, i1

    def mel_mean(self, t0: float, t1: float) -> np.ndarray:
        i0, i1 = self.frame_range(t0, t1)
        return self.mel[:, i0:i1].mean(axis=1)

    def rms(self, t0: float, t1: float) -> float:
        i0 = min(max(int(round(t0 * self.sr)), 0), len(self.mono))
        i1 = min(max(int(round(t1 * self.sr)), 0), len(self.mono))
        if i1 <= i0:
            return 0.0
        return math.sqrt(max(0.0, (self.cumsq[i1] - self.cumsq[i0]) / (i1 - i0)))

    def fingerprint(self, t0: float, t1: float, bars: int) -> np.ndarray:
        """Mean-removed log-mel on a ``FINGERPRINT_BINS_PER_BAR``-per-bar grid, flattened."""
        i0, i1 = self.frame_range(t0, t1)
        nb = max(1, FINGERPRINT_BINS_PER_BAR * bars)
        edges = np.linspace(i0, i1, nb + 1)
        out = np.empty((self.mel.shape[0], nb), dtype=np.float64)
        for k in range(nb):
            a = int(edges[k])
            b = max(a + 1, int(edges[k + 1]))
            out[:, k] = self.mel[:, a:min(b, self.n_frames)].mean(axis=1)
        flat = out.ravel()
        return flat - flat.mean()


def _compute_features(mono_native: np.ndarray, sr: int, onsets_s: Sequence[float] | None) -> _Features:
    import librosa

    mono = mono_native if sr == FEATURE_SR else resample(mono_native, sr, FEATURE_SR)
    mono = np.asarray(mono, dtype=np.float32)
    if not np.isfinite(mono).all():
        mono = np.nan_to_num(mono)
    S = librosa.feature.melspectrogram(y=mono, sr=FEATURE_SR, n_fft=MEL_N_FFT, hop_length=MEL_HOP,
                                       n_mels=MEL_N_MELS, power=2.0)
    ref = float(S.max()) if S.size else 1.0
    db = librosa.power_to_db(S, ref=ref if ref > 0 else 1.0, top_db=MEL_TOP_DB)
    mel = (db - db.mean(axis=1, keepdims=True)).astype(np.float64)
    cumsq = np.concatenate([[0.0], np.cumsum(mono.astype(np.float64) ** 2)])
    if onsets_s is None:
        if mono.size >= MEL_N_FFT and float(np.max(np.abs(mono))) > 0:
            det = librosa.onset.onset_detect(y=mono, sr=FEATURE_SR, units="time", backtrack=True)
            onsets = np.asarray(det, dtype=np.float64)
        else:
            onsets = np.zeros(0, dtype=np.float64)
    else:
        onsets = np.asarray(sorted(float(t) for t in onsets_s), dtype=np.float64)
    return _Features(sr=FEATURE_SR, mono=mono, mel=mel, hop=MEL_HOP, cumsq=cumsq, onsets_s=onsets)


@dataclass
class _Grid:
    anchors: list[float]
    n_measured: int
    """``anchors[:n_measured]`` are measured; the rest are extrapolated past the last one."""
    step: int
    """Anchors per bar: 1 for downbeats, beats-per-bar for beats."""
    name: str
    """``"downbeats"`` or ``"beats"``."""
    bpb: int
    beat_period_s: float
    beats: np.ndarray


def _median_period(times: Sequence[float]) -> float | None:
    if len(times) < 2:
        return None
    d = np.diff(np.asarray(times, dtype=np.float64))
    d = d[d > 0]
    return float(np.median(d)) if d.size else None


def _extend(anchors: list[float], period: float | None, max_extra: int, duration_s: float) -> list[float]:
    out = list(anchors)
    if period is None or period <= 0 or not out:
        return out
    for _ in range(max_extra):
        nxt = out[-1] + period
        if nxt > duration_s + 1e-3:
            break
        out.append(min(nxt, duration_s))
    return out


def _build_grid(rep: AnalysisReport, duration_s: float) -> _Grid | None:
    beats = rep.beats
    if beats is None or not beats.times_s:
        return None
    times = sorted(float(t) for t in beats.times_s if 0.0 <= float(t) <= duration_s + 1e-3)
    if not times:
        return None
    bpb = beats_per_bar(beats.meter)
    beat_period = _median_period(times)
    if beat_period is None and rep.tempo is not None and rep.tempo.bpm > 0:
        beat_period = 60.0 / rep.tempo.bpm
    if beat_period is None:
        beat_period = 0.5
    downbeats = sorted(float(t) for t in beats.downbeats_s if 0.0 <= float(t) <= duration_s + 1e-3)
    if beats.downbeat_confidence >= DOWNBEAT_CONFIDENCE_THRESHOLD and downbeats:
        period = _median_period(downbeats) or beat_period * bpb
        anchors = _extend(downbeats, period, 1, duration_s)
        return _Grid(anchors=anchors, n_measured=len(downbeats), step=1, name="downbeats", bpb=bpb,
                     beat_period_s=beat_period, beats=np.asarray(times))
    anchors = _extend(times, beat_period, bpb, duration_s)
    return _Grid(anchors=anchors, n_measured=len(times), step=bpb, name="beats", bpb=bpb,
                 beat_period_s=beat_period, beats=np.asarray(times))


@dataclass
class _Cand:
    start_s: float
    end_s: float
    bars: int
    bar_index: int | None
    extrapolated_end: bool
    anchor_index: int = 0
    """Index of the start anchor in ``_Grid.anchors`` (a downbeat, or a beat in beats mode)."""
    score: float = 0.0
    base_score: float = 0.0
    """The four length-blind terms only; what dedupe orders by, before phrase and recurrence."""
    metrics: dict[str, Any] = field(default_factory=dict)
    repeats: int = 0
    recurs: int = 0
    """Other candidates of the same length carrying the same content (non-contiguous included)."""
    fp: np.ndarray | None = None
    ready: SampleReady | None = None

    @property
    def rank_score(self) -> float:
        """Score for ordering. Identical to ``score`` unless stems moved it."""
        return self.score if self.ready is None else self.score * self.ready.ranking_factor

    @property
    def shape_key(self) -> tuple | None:
        """Which stems are playing, for the repeat check. ``None`` without stems."""
        if self.ready is None:
            return None
        return tuple((name, span.presence) for name, span in sorted(self.ready.profile.items()))


def _enumerate(grid: _Grid, bar_list: Sequence[int], duration_s: float) -> list[_Cand]:
    out: list[_Cand] = []
    n = len(grid.anchors)
    for i in range(n):
        for bars in bar_list:
            j = i + bars * grid.step
            if j >= n:
                continue
            s, e = grid.anchors[i], grid.anchors[j]
            if e - s < MIN_LOOP_S or e > duration_s + 1e-6:
                continue
            out.append(_Cand(start_s=s, end_s=min(e, duration_s), bars=bars,
                             bar_index=i if grid.name == "downbeats" else None,
                             extrapolated_end=j >= grid.n_measured, anchor_index=i))
    return out


def _structure_boundaries(rep: AnalysisReport) -> list[tuple[float, float]] | None:
    """(time, confidence) of every section start after the first; None when structure is null."""
    if rep.structure is None:
        return None
    secs = sorted(rep.structure.sections, key=lambda s: s.start_s)
    return [(float(s.start_s), float(s.confidence)) for s in secs[1:]]


def _window_pair(feat: _Features, out_t0: float, out_t1: float, in_t0: float, in_t1: float) -> tuple[float, float]:
    """(mel similarity in [0, 1], RMS continuity in [0, 1]) of outgoing -> incoming windows."""
    mel_sim = 0.5 * (_cosine(feat.mel_mean(out_t0, out_t1), feat.mel_mean(in_t0, in_t1)) + 1.0)
    r_out = feat.rms(out_t0, out_t1)
    r_in = feat.rms(in_t0, in_t1)
    hi = max(r_out, r_in)
    rms_cont = 0.0 if hi < SILENCE_RMS else min(r_out, r_in) / hi
    return mel_sim, rms_cont


def _score_seam(feat: _Features, s: float, e: float, duration_s: float) -> dict[str, float]:
    w = SEAM_WINDOW_S
    raw_mel, raw_rms = _window_pair(feat, e - w, e, s, s + w)          # tail -> head (raw playback)
    if e + w <= duration_s + 1e-9:
        wrap_mel, wrap_rms = _window_pair(feat, e, e + w, s, s + w)    # post-end -> head (tail crossfade)
    elif s - w >= 0.0:
        wrap_mel, wrap_rms = _window_pair(feat, e - w, e, s - w, s)    # tail -> pre-start (self crossfade)
    else:
        wrap_mel, wrap_rms = raw_mel, raw_rms
    seam_mel = 0.5 * (raw_mel + wrap_mel)
    seam_rms = 0.5 * (raw_rms + wrap_rms)
    return {
        "seam": 0.5 * seam_mel + 0.5 * seam_rms,
        "seam_mel": seam_mel,
        "seam_rms": seam_rms,
        "seam_raw": 0.5 * raw_mel + 0.5 * raw_rms,
        "seam_wrap": 0.5 * wrap_mel + 0.5 * wrap_rms,
    }


def _score_stability(feat: _Features, grid: _Grid, s: float, e: float, bars: int) -> tuple[float, float]:
    inner = grid.beats[(grid.beats > s + 1e-6) & (grid.beats < e - 1e-6)]
    edges = [s, *inner.tolist(), e]
    if len(edges) < 3:
        n_seg = max(2, bars * grid.bpb)
        edges = np.linspace(s, e, n_seg + 1).tolist()
    vals = np.asarray([feat.rms(a, b) for a, b in zip(edges[:-1], edges[1:], strict=True) if b - a >= 0.01])
    if vals.size == 0:
        return 0.0, 0.0
    mean = float(vals.mean())
    if mean < SILENCE_RMS:
        return 0.0, 0.0
    cv2 = float(vals.var()) / (mean * mean)
    return float(np.clip(1.0 - cv2, 0.0, 1.0)), mean


def _score_novelty(boundaries: list[tuple[float, float]] | None, beat_period: float,
                   s: float, e: float) -> tuple[float, int]:
    if boundaries is None:
        return 1.0, 0
    tol = NOVELTY_BOUNDARY_TOLERANCE_BEATS * beat_period
    inside = [c for t, c in boundaries if s + tol < t < e - tol]
    return 1.0 / (1.0 + float(sum(inside))), len(inside)


def _score_onset_lock(onsets: np.ndarray, s: float) -> tuple[float, float | None]:
    if onsets.size == 0:
        return 0.0, None
    k = int(np.searchsorted(onsets, s))
    cands = []
    if k < onsets.size:
        cands.append(abs(onsets[k] - s))
    if k > 0:
        cands.append(abs(onsets[k - 1] - s))
    d_ms = float(min(cands)) * 1000.0
    if d_ms <= ONSET_LOCK_FULL_MS:
        return 1.0, d_ms
    if d_ms >= ONSET_LOCK_ZERO_MS:
        return 0.0, d_ms
    return (ONSET_LOCK_ZERO_MS - d_ms) / (ONSET_LOCK_ZERO_MS - ONSET_LOCK_FULL_MS), d_ms


def _period_agreement(bars: int, loop_period: int | None, confidence: float) -> float:
    """How well ``bars`` agrees with the loop period this record was measured to have.

    1.0 when the record made no claim (no structure, no period, zero
    confidence): an unmeasured record never moves the prior (principle 2).
    """
    if not loop_period or loop_period <= 0 or confidence <= 0.0:
        return 1.0
    ratio = bars / float(loop_period)
    agree = PERIOD_AGREEMENT.get(round(ratio, 4), PERIOD_AGREEMENT_OTHER)
    return 1.0 - float(np.clip(confidence, 0.0, 1.0)) * (1.0 - agree)


def _phrase_alignment(anchor_index: int, span_anchors: int, origins: Sequence[int]) -> float:
    """1.0 when the start sits on a phrase line, 0.0 half a phrase off it.

    ``span_anchors`` is the candidate's own length in anchors, so a 4-bar
    candidate is asked about 4-bar phrases and an 8-bar one about 8-bar
    phrases. The best origin wins: a record with a two-bar intro still has its
    phrases found, through the section start that marks where they begin.
    """
    if span_anchors <= 0:
        return 1.0
    best = 0.0
    for origin in origins:
        off = (anchor_index - origin) % span_anchors
        distance = min(off, span_anchors - off) / span_anchors  # 0 .. 0.5
        best = max(best, 1.0 - 2.0 * distance)
        if best >= 1.0:
            break
    return float(np.clip(best, 0.0, 1.0))


def _score_phrase(c: _Cand, grid: _Grid, origins: Sequence[int], loop_period: int | None,
                  period_confidence: float) -> dict[str, float]:
    """Is this a musically useful length, and does it start where a phrase starts?"""
    prior = float(BAR_PRIOR.get(c.bars, BAR_PRIOR_DEFAULT))
    agreement = _period_agreement(c.bars, loop_period, period_confidence)
    length = float(np.clip(prior * agreement, 0.0, 1.0))
    alignment = _phrase_alignment(c.anchor_index, c.bars * grid.step, origins)
    return {
        "phrase": PHRASE_LENGTH_SHARE * length + (1.0 - PHRASE_LENGTH_SHARE) * alignment,
        "phrase_length": length,
        "phrase_alignment": alignment,
        "period_agreement": agreement,
    }


def _score_recurrence(c: _Cand) -> float:
    """Saturating count of the other places this content is heard: nowhere else -> 0.0."""
    if RECURRENCE_FULL <= 0:
        return 0.0
    return float(min(1.0, c.recurs / float(RECURRENCE_FULL)))


def _score(c: _Cand, feat: _Features, grid: _Grid, boundaries: list[tuple[float, float]] | None,
           duration_s: float) -> bool:
    """Fill the four length-blind terms and ``c.base_score``; False when the candidate is silence.

    ``phrase`` and ``recurrence`` cannot be scored yet: recurrence is only
    known once the whole surviving set exists, and the total score has to
    include it. :func:`_finalize_score` closes both after the collapse pass.
    """
    s, e = c.start_s, c.end_s
    if feat.rms(s, e) < SILENCE_RMS:
        return False
    seams = _score_seam(feat, s, e, duration_s)
    seam = seams["seam"]
    stability, _ = _score_stability(feat, grid, s, e, c.bars)
    novelty, n_inside = _score_novelty(boundaries, grid.beat_period_s, s, e)
    onset_lock, onset_d = _score_onset_lock(feat.onsets_s, s)
    c.base_score = (WEIGHT_SEAM * seam + WEIGHT_STABILITY * stability + WEIGHT_NOVELTY * novelty
                    + WEIGHT_ONSET_LOCK * onset_lock)
    c.score = c.base_score
    c.metrics = {
        **seams,
        "stability": stability, "novelty": novelty, "interior_boundaries": n_inside,
        "onset_lock": onset_lock, "onset_distance_ms": onset_d,
    }
    return True


def _finalize_score(c: _Cand, grid: _Grid, origins: Sequence[int], loop_period: int | None,
                    period_confidence: float) -> None:
    """Add ``phrase`` and ``recurrence`` and make ``c.score`` the whole formula."""
    phrase = _score_phrase(c, grid, origins, loop_period, period_confidence)
    recurrence = _score_recurrence(c)
    c.metrics.update(phrase)
    c.metrics["recurrence"] = recurrence
    c.score = (c.base_score + WEIGHT_PHRASE * phrase["phrase"] + WEIGHT_RECURRENCE * recurrence)


def _phrase_origins(grid: _Grid, boundaries: list[tuple[float, float]] | None) -> list[int]:
    """Anchor indices a phrase may start on: the first anchor, plus every section start.

    A section start only counts when it lands within
    ``NOVELTY_BOUNDARY_TOLERANCE_BEATS`` of an anchor -- the same bar the
    novelty term uses for "this boundary *is* that edge". Further away it is not
    on the grid, so it cannot be a phrase line on it.
    """
    origins = [0]
    if not boundaries or not grid.anchors:
        return origins
    anchors = np.asarray(grid.anchors, dtype=np.float64)
    tol = NOVELTY_BOUNDARY_TOLERANCE_BEATS * grid.beat_period_s
    for t, _confidence in boundaries:
        j = int(np.argmin(np.abs(anchors - t)))
        if abs(float(anchors[j]) - t) <= tol and j not in origins:
            origins.append(j)
    return origins


def _mark_recurrence(cands: list[_Cand], feat: _Features) -> None:
    """Count, per candidate, the other candidates of the same length with the same content.

    Runs on the deduped set *before* the repeat collapse, so the answer is "how
    many times are these bars heard in this record" and not "how many candidates
    happened to survive". That also keeps it stem-blind: the collapse is the one
    pass stems change, so a loop's score means the same thing with stems or
    without (the contract the module docstring makes). One normalized matrix
    product per bar count; the fingerprints are the ones the collapse needs next.
    """
    by_bars: dict[int, list[_Cand]] = {}
    for c in cands:
        by_bars.setdefault(c.bars, []).append(c)
    for bars, group in by_bars.items():
        if len(group) < 2:
            continue
        for c in group:
            if c.fp is None:
                c.fp = feat.fingerprint(c.start_s, c.end_s, bars)
        matrix = np.asarray([c.fp for c in group], dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms < 1e-12] = 1.0
        matrix /= norms
        sim = matrix @ matrix.T
        # the same threshold the collapse uses, with float32 slack, so a pair that folds
        # there is never missed here: ``recurs`` can only ever be >= ``repeats``
        hits = (sim >= REPEAT_SIMILARITY - 1e-5).sum(axis=1) - 1  # never count the candidate itself
        for c, n in zip(group, hits.tolist(), strict=True):
            c.recurs = int(max(0, n))


def _dedupe_near_identical(cands: list[_Cand]) -> list[_Cand]:
    tol = DEDUPE_START_MS / 1000.0
    kept: list[_Cand] = []
    for c in sorted(cands, key=lambda x: (-x.base_score, x.start_s)):
        dup = False
        for k in kept:
            if k.bars == c.bars and abs(k.start_s - c.start_s) <= tol and \
                    abs((k.end_s - k.start_s) - (c.end_s - c.start_s)) <= tol:
                dup = True
                break
        if not dup:
            kept.append(c)
    return kept


def _collapse_repeats(cands: list[_Cand], feat: _Features, beat_period: float) -> list[_Cand]:
    """Contiguous same-length candidates with the same content fold onto the earliest."""
    tol = CONTIGUOUS_TOLERANCE_BEATS * beat_period
    heads: list[_Cand] = []
    by_bars: dict[int, list[_Cand]] = {}
    for c in cands:
        by_bars.setdefault(c.bars, []).append(c)
    for bars, group in by_bars.items():
        chains: list[list[Any]] = []  # [head, chain_end_s]
        for c in sorted(group, key=lambda x: x.start_s):
            if c.fp is None:
                c.fp = feat.fingerprint(c.start_s, c.end_s, bars)
            attached = False
            for chain in chains:
                head, end_s = chain
                if head.shape_key != c.shape_key:
                    continue  # same chords, but one of them has the singer on it
                if abs(end_s - c.start_s) <= tol and _cosine(head.fp, c.fp) >= REPEAT_SIMILARITY:
                    head.repeats += 1
                    chain[1] = c.end_s
                    attached = True
                    break
            if not attached:
                chains.append([c, c.end_s])
                heads.append(c)
    return heads


def _reasons(c: _Cand, grid: _Grid, has_structure: bool, loop_period: int | None) -> list[str]:
    m = c.metrics
    out: list[str] = []
    out.append("starts on a downbeat" if grid.name == "downbeats" else "starts on a beat (downbeats uncertain)")
    if m["seam"] >= 0.8:
        out.append("tail flows into the head")
    elif m["seam"] >= 0.6:
        out.append("seam is close")
    else:
        out.append("seam changes texture")
    if m["seam_wrap"] - m["seam_raw"] >= 0.15:
        out.append("smoother with the crossfade than raw")
    if 0 < m["seam_rms"] < 0.6:
        out.append(f"level steps {abs(20 * math.log10(m['seam_rms'])):.0f} dB at the seam")
    if m["stability"] >= 0.8:
        out.append("steady energy across beats")
    elif m["stability"] < 0.5:
        out.append("energy varies inside the loop")
    if m["interior_boundaries"] > 0:
        k = m["interior_boundaries"]
        out.append(f"crosses {k} section boundar{'y' if k == 1 else 'ies'}")
    elif has_structure:
        out.append("no section change inside")
    d = m["onset_distance_ms"]
    if d is None:
        out.append("no onsets measured")
    elif d <= ONSET_LOCK_FULL_MS:
        out.append(f"onset {d:.0f} ms from the start")
    elif d < ONSET_LOCK_ZERO_MS:
        out.append(f"nearest onset {d:.0f} ms from the start")
    else:
        out.append("no onset near the start")
    if c.repeats:
        out.append(f"repeats {c.repeats}x right after")
    if c.recurs:
        out.append(f"the same {c.bars} bars come back {c.recurs}x in the record")
    elif m.get("recurrence") == 0.0:
        out.append("these bars are not heard again")
    if loop_period is not None and loop_period == c.bars:
        out.append(f"matches the measured loop period ({c.bars} bars)")
    elif loop_period and c.bars * 2 == loop_period:
        out.append(f"half the measured loop period ({loop_period} bars)")
    if m.get("phrase_alignment", 0.0) >= 0.999:
        out.append(f"lands on a {c.bars}-bar phrase line")
    elif m.get("phrase_alignment", 1.0) <= 0.25:
        out.append("starts part-way through a phrase")
    if m.get("phrase_length", 1.0) <= 0.35:
        out.append(f"{c.bars} bar{'' if c.bars == 1 else 's'} is short for a loop to play under")
    if c.extrapolated_end:
        out.append("ends at the end of the file")
    return out


def _name(c: _Cand, grid: _Grid) -> str:
    unit = "bar" if c.bars == 1 else "bars"
    if c.bar_index is not None:
        return f"{c.bars} {unit} from bar {c.bar_index + 1}"
    return f"{c.bars} {unit} at {c.start_s:.2f}s"


def _round(v: Any, nd: int = 4) -> Any:
    return None if v is None else round(float(v), nd)


# --- entry point ---------------------------------------------------------------------------------


def find_loops(y: np.ndarray, sr: int, report: AnalysisReport, bars: Sequence[int] = DEFAULT_BARS,
               top_k: int | None = 12, stems: Mapping[str, np.ndarray] | None = None,
               stem_source: StemSource | None = None) -> list[LoopCandidate]:
    """Rank loop candidates for ``y`` (mono ``(n,)`` or ``(channels, n)`` float) at ``sr``.

    ``report`` is the raw AnalysisReport; ``effective()`` is applied here so user
    edits to tempo, downbeats and meter drive the grid. Returns at most
    ``top_k`` candidates (``None`` for all), sorted by score descending, with no
    duplicates; ``[]`` when the report has no beats.

    ``stems`` (name -> audio at ``sr``, from the file's separation) adds
    ``components["sample_ready"]``: what is and is not playing in each
    candidate, per stem, with a confidence on every claim. ``stem_source``
    says where those stems came from; stems from the development stand-in
    have their claims withheld. Without ``stems`` nothing changes: the scores,
    the order and the components are exactly what they were.
    """
    rep = effective(report)
    if rep.beats is None or not rep.beats.times_s:
        return []
    if top_k is not None and top_k <= 0:
        return []
    bar_list = sorted({int(b) for b in bars if int(b) > 0})
    if not bar_list or sr <= 0:
        return []
    mono_native = to_mono(np.asarray(y, dtype=np.float32))
    if mono_native.size == 0:
        return []
    duration_s = mono_native.size / float(sr)

    grid = _build_grid(rep, duration_s)
    if grid is None:
        return []
    raw = _enumerate(grid, bar_list, duration_s)
    if not raw:
        return []

    onsets = list(rep.onsets.times_s) if rep.onsets is not None else None
    feat = _compute_features(mono_native, sr, onsets)
    boundaries = _structure_boundaries(rep)
    loop_period = rep.structure.loop_period_bars if rep.structure is not None else None
    period_confidence = float(rep.structure.loop_period_confidence) if rep.structure is not None else 0.0
    origins = _phrase_origins(grid, boundaries)

    scored = [c for c in raw if _score(c, feat, grid, boundaries, duration_s)]
    scored = _dedupe_near_identical(scored)
    _mark_recurrence(scored, feat)
    energies = stem_energies(stems, sr, mix=mono_native, source=stem_source) if stems else None
    if energies is not None:
        # before the repeat pass: a repeat with a vocal over it is a different loop
        for c in scored:
            c.ready = sample_ready(energies, c.start_s, c.end_s)
    scored = _collapse_repeats(scored, feat, grid.beat_period_s)
    for c in scored:
        _finalize_score(c, grid, origins, loop_period, period_confidence)
    scored.sort(key=lambda c: (-c.rank_score, c.start_s))
    if top_k is not None:
        scored = scored[:top_k]

    out: list[LoopCandidate] = []
    for c in scored:
        m = c.metrics
        components: dict[str, Any] = {
            "seam": _round(m["seam"]),
            "phrase": _round(m["phrase"]),
            "stability": _round(m["stability"]),
            "novelty": _round(m["novelty"]),
            "onset_lock": _round(m["onset_lock"]),
            "recurrence": _round(m["recurrence"]),
            "seam_mel": _round(m["seam_mel"]),
            "seam_rms": _round(m["seam_rms"]),
            "seam_raw": _round(m["seam_raw"]),
            "seam_wrap": _round(m["seam_wrap"]),
            "phrase_length": _round(m["phrase_length"]),
            "phrase_alignment": _round(m["phrase_alignment"]),
            "period_agreement": _round(m["period_agreement"]),
            "onset_distance_ms": _round(m["onset_distance_ms"], 1),
            "interior_boundaries": int(m["interior_boundaries"]),
            "repeats": int(c.repeats),
            "recurs_elsewhere": int(c.recurs),
            "grid": grid.name,
            "bar_index": c.bar_index,
            "extrapolated_end": bool(c.extrapolated_end),
            "matches_loop_period": bool(loop_period is not None and loop_period == c.bars),
            "loop_period_bars": loop_period,
            "weights": dict(WEIGHTS),
            "reasons": _reasons(c, grid, boundaries is not None, loop_period),
        }
        if c.ready is not None:
            components["sample_ready"] = c.ready.to_dict()
            components["reasons"] = components["reasons"] + stem_reasons(c.ready)
        out.append(LoopCandidate(start_s=float(c.start_s), end_s=float(c.end_s), bars=int(c.bars),
                                 score=round(float(c.score), 4), components=components,
                                 origin="finder", name=_name(c, grid)))
    return out


__all__ = [
    "BAR_PRIOR", "BAR_PRIOR_DEFAULT", "DEFAULT_BARS", "DOWNBEAT_CONFIDENCE_THRESHOLD",
    "LoopCandidate", "PERIOD_AGREEMENT", "PERIOD_AGREEMENT_OTHER", "PHRASE_LENGTH_SHARE",
    "RECURRENCE_FULL", "WEIGHTS", "WEIGHT_NOVELTY", "WEIGHT_ONSET_LOCK", "WEIGHT_PHRASE",
    "WEIGHT_RECURRENCE", "WEIGHT_SEAM", "WEIGHT_STABILITY", "beats_per_bar", "find_loops",
]
