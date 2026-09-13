"""Structure: beat-synchronous recurrence, loop period, section boundaries and labels.

Method
------
1. Features per beat of ``effective(ctx.report).beats`` (hop 512): 20 MFCCs averaged over
   the beat's frames, and 12 ``chroma_cqt`` bins averaged with frame-RMS weights (the
   per-frame-normalized chroma of quiet frames is noise; a beat's harmony is what sounds
   in it). Each dimension is centered and scaled by its standard deviation over the file,
   floored at ``MFCC_STD_FLOOR`` / ``CHROMA_STD_FLOOR`` so humanization noise in otherwise
   uniform material is not inflated into structure. Regularized cosine self-similarity
   ``S`` over beats: ``(x.y + r) / (|x||y| + r)`` with ``r = COSINE_REG * n_dims``, so two
   beats whose deviations from the file mean are all below the floors read as identical.
2. Recurrence: ``S`` is path-enhanced along diagonals (mean over +-``PATH_WIDTH`` beats),
   so an entry is high only when short *sequences* match, not single chords. ``S_pe`` is
   what the repetition statistics (loop period, section affinity) read; the boundary
   novelty reads the raw ``S`` (see 4).
3. Loop period: repeat histogram ``h[l]`` = the fraction of beats whose neighbour ``l``
   beats later is *the same material* (``S_pe >= REPEAT_SIM``), normalized by the number
   of beats, not pairs, so long lags do not win by default. Counting repeats rather than
   averaging similarity is the point: a sustained chord or a four-on-the-floor kick makes
   every short lag *correlated* (a high mean) without anything repeating, and that used to
   put the loop period at half a bar. The strongest peak at lags >= one bar sets the
   reference; the shortest peak reaching ``PERIOD_STRONG_FRAC`` of it is the fundamental.
   A period is only reported when it occurs ``MIN_LOOP_REPEATS`` times in the file.
   ``loop_period_bars`` = lag / beats-per-bar, rounded.
4. Boundaries: novelty on the loop-aligned diagonal of the cross blocks,
   ``nov[c] = 1 - mean_k S[c - L + k, c + k]``, which compares the ``L`` beats before ``c``
   with the ``L`` beats after at the same loop phase (``L`` = loop period). Inside a
   section the two blocks are the same loop and the novelty is ~0; at a section change it
   is high. This is a boxcar of length ``L`` over the lag-``L`` diagonal, so it already
   averages a sequence: it is computed on the raw ``S``, because path-enhancing first
   widens the dip at a boundary beyond the width of the window that is matched to it and
   biases the peak *early* whenever the cross-section similarity is not flat (it is not:
   two loops usually share a chord or two at some loop positions).
   The window needs ``MIN_WINDOW_REPEATS`` loops in the file to show a boundary as a local
   peak, so it uses the shortest strong period that fits that often; when no period does,
   the four-bar (then two-bar) checkerboard contrast is used instead, which needs no period.
   Peaks (prominence >= ``NOV_REL_PROM`` of the maximum and >= ``NOV_ABS``, at least half a
   loop apart) are snapped to a downbeat within ``SNAP_MAX_BARS`` of the peak: a section
   change lands on a bar line, and the peak is accurate to about a beat, so a small snap is
   a refinement. A downbeat further away than that is not a refinement but a relocation --
   it means the measured bar phase or metrical level disagrees with the material -- so the
   peak stands where the evidence put it. Boundaries closer than a loop (at least two bars)
   to either end of the file are dropped (a fade or a silent tail is not a section).
5. Labels: sections are compared by the mean of ``S_pe`` along their aligned diagonal
   (best of +-1 beat), lined up from each section's first downbeat rather than its start
   time, so the section that carries the file's silent lead-in or pickup is still compared
   bar for bar with the sections that repeat it. Spectral clustering on that affinity with
   ``k`` chosen by silhouette over 2..min(6, n_sections - 1); labels "A", "B", ... in order
   of first appearance.
   Two sections are the same label when their aligned similarity exceeds 0.5. Adjacent
   sections are merged only when that similarity reaches ``REPEAT_SIM``, i.e. when they
   measure as the same material; sharing a cluster is not enough, because ``k`` is chosen
   for the whole file and lumping two neighbours together would otherwise delete a real
   boundary the novelty found.
6. ``energy``: section RMS normalized to the loudest section.

Without at least two bars of beats the whole file is one section (``start_bar`` 0,
``bars`` 1, ``notes`` explains) and no loop period is reported.

Confidence
----------
Per section: ``0.5 * boundary_strength + 0.5 * clip(silhouette, 0, 1)`` where
``boundary_strength`` is the mean normalized novelty prominence of the section's start
and end boundaries (the file edges count 1). A single whole-file section uses
``1 - max(novelty)`` in place of the silhouette. Halved when the novelty could not be
loop-aligned (it then compares fixed four- or two-bar blocks).
``loop_period_confidence`` = prominence of the chosen repeat-histogram peak /
``PERIOD_PROM_FULL`` (0.4, i.e. a period at which 40 % of the file is an exact repeat is
fully confident), clipped to [0, 1]; halved when the lag is not within a quarter bar of a
whole number of bars.
"""

from __future__ import annotations

import warnings

import numpy as np

from ..report import Section, Structure, effective
from . import grid
from .key import chroma_cqt

HOP_LENGTH = 512
N_MFCC = 20
MFCC_STD_FLOOR = 2.0
CHROMA_STD_FLOOR = 0.05
COSINE_REG = 0.1
PATH_WIDTH = 2
REPEAT_SIM = 0.8
"""Path-enhanced similarity at which two beats are the same material rather than merely
alike, and the bar two adjacent sections have to clear to be merged into one.

Calibrated on the synthetic set: a beat and its counterpart one loop later reads 0.95-1.0
programmed and 0.85+ humanized, material from another section reads 0.2-0.86. Deliberately
set at the *low* end of that gap: the set's repeats are exact (identical renders) and score
best at 0.85-0.9, but a repeat on a record is a repeat with a vocal, a fill and a room over
it, and a threshold that demands near-identity would find no loop there at all."""
PERIOD_MIN_PROM = 0.15
PERIOD_STRONG_FRAC = 0.6
PERIOD_PROM_FULL = 0.4
MIN_LOOP_REPEATS = 2
"""A period has to happen twice before it is a period."""
MIN_WINDOW_REPEATS = 4
"""...and four times before the novelty can use it as a comparison window: with fewer,
the window is a sizeable fraction of the form and a boundary stops being a local peak."""
SNAP_MAX_BARS = 0.25
NOV_REL_PROM = 0.4
NOV_ABS = 0.3
SIL_MIN = 0.05
SAME_LABEL_SIM = 0.5
MAX_CLUSTERS = 6
METHOD = ("beat-sync mfcc+chroma; path-enhanced recurrence; repeat-histogram loop period; "
          "loop-aligned novelty snapped to downbeats; spectral clustering of sections (k by silhouette)")


def _standardize(F: np.ndarray, std_floor: float) -> np.ndarray:
    F = np.nan_to_num(F)
    return (F - F.mean(axis=1, keepdims=True)) / np.maximum(F.std(axis=1, keepdims=True), std_floor)


def beat_features(y: np.ndarray, sr: int, beats: np.ndarray) -> np.ndarray:
    """(32, n_beats) standardized MFCC+chroma, RMS-weighted mean over each beat."""
    import librosa

    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP_LENGTH, n_mfcc=N_MFCC)
    chroma = chroma_cqt(y, sr, HOP_LENGTH)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP_LENGTH)[0]
    n_frames = min(mfcc.shape[1], chroma.shape[1], rms.size)
    mfcc, chroma, rms = mfcc[:, :n_frames], chroma[:, :n_frames], rms[:n_frames]
    frames = librosa.time_to_frames(beats, sr=sr, hop_length=HOP_LENGTH)
    frames = np.clip(frames, 0, max(0, n_frames - 1))
    edges = np.concatenate([frames, [n_frames]])
    m_cols, c_cols = [], []
    for a, b in zip(edges[:-1], edges[1:]):
        b = max(b, a + 1)
        w = rms[a:b].astype(np.float64)
        w = w / w.sum() if w.sum() > 0 else np.full(b - a, 1.0 / (b - a))
        m_cols.append(mfcc[:, a:b].mean(axis=1))  # plain mean: quiet frames are constant and dilute frame-position effects
        c_cols.append(chroma[:, a:b] @ w)  # RMS-weighted: per-frame-normalized chroma of quiet frames is noise
    M = _standardize(np.array(m_cols).T, MFCC_STD_FLOOR)
    C = _standardize(np.array(c_cols).T, CHROMA_STD_FLOOR)
    return np.vstack([M, C])


def similarity_matrix(X: np.ndarray) -> np.ndarray:
    """Regularized cosine similarity: ``(x.y + reg) / (|x||y| + reg)`` with ``reg`` = COSINE_REG * n_dims,
    so beats with no deviation from the file mean are identical (1), not undefined."""
    reg = COSINE_REG * X.shape[0]
    norms = np.linalg.norm(X, axis=0)
    return (X.T @ X + reg) / (np.outer(norms, norms) + reg)


def path_enhance(S: np.ndarray, width: int = PATH_WIDTH) -> np.ndarray:
    n = S.shape[0]
    out = np.zeros_like(S)
    cnt = np.zeros_like(S)
    for d in range(-width, width + 1):
        src = slice(max(0, d), n + min(0, d))
        dst = slice(max(0, -d), n + min(0, -d))
        out[dst, dst] += S[src, src]
        cnt[dst, dst] += 1
    return out / np.maximum(cnt, 1)


def repeat_histogram(S: np.ndarray, min_lag: int, threshold: float = REPEAT_SIM) -> np.ndarray:
    """``h[l]`` = fraction of the file's beats whose counterpart ``l`` beats later is the
    same material (``S[i, i + l] >= threshold``).

    Counting repeats, not averaging similarity. The mean of a lag diagonal rewards
    material that is merely *correlated* at that lag -- a sustained chord, a kick on every
    beat -- as strongly as material that actually repeats, and short lags win that contest
    on almost any produced track. A loop is a repeat, so count repeats. Dividing by the
    number of beats rather than the number of pairs keeps long lags, which have fewer
    pairs to offer, from winning by default.
    """
    n = S.shape[0]
    h = np.zeros(n)
    for lag in range(1, max(1, n - min_lag + 1)):
        h[lag] = float((np.diagonal(S, offset=lag) >= threshold).sum()) / n
    return h


def loop_period(h: np.ndarray, beats_per_bar: int, max_lag: int | None = None) -> tuple[int | None, float]:
    """(lag in beats, prominence) of the fundamental repetition period, or (None, 0).

    The shortest peak that reaches ``PERIOD_STRONG_FRAC`` of the strongest one: a loop of
    ``T`` bars also repeats at 2T, 3T, ..., so the strongest peak alone would report a
    multiple. ``max_lag`` bounds the answer to periods the file is long enough to support.
    """
    import scipy.signal

    if h.size <= beats_per_bar or h.max() <= 0:
        return None, 0.0
    peaks, props = scipy.signal.find_peaks(np.pad(h, 1), prominence=0.0)
    peaks = peaks - 1
    proms = props["prominences"]
    keep = peaks >= beats_per_bar
    if max_lag is not None:
        keep &= peaks <= max_lag
    peaks, proms = peaks[keep], proms[keep]
    if peaks.size == 0:
        return None, 0.0
    heights = h[peaks]
    strong = heights >= PERIOD_STRONG_FRAC * heights.max()
    i = int(np.argmin(np.where(strong, peaks, np.inf)))
    return int(peaks[i]), float(proms[i])


def sequence_novelty(S: np.ndarray, L: int) -> np.ndarray:
    """Loop-aligned novelty: ``1 - mean_k S[c - L + k, c + k]``, the ``L`` beats before ``c``
    against the ``L`` beats after at the same loop phase.

    Equivalently a boxcar of length ``L`` over the lag-``L`` diagonal, matched to the ``L``
    beats of that diagonal which straddle a boundary. Pass the *raw* similarity matrix: the
    boxcar is the sequence average, and diagonal-smoothing the matrix first widens the dip
    past the width of the window, which moves the peak off the boundary.
    """
    n = S.shape[0]
    nov = np.zeros(n)
    if L < 1 or n < 2 * L:
        return nov
    k = np.arange(L)
    for c in range(L, n - L + 1):
        nov[c] = max(0.0, 1.0 - float(S[c - L + k, c + k].mean()))
    return nov


def checkerboard_novelty(S: np.ndarray, L: int) -> np.ndarray:
    """Foote's contrast novelty: within-block similarity minus cross-block similarity around each beat.

    Independent of the loop period, so a section change that shows as a change of
    material (harmony set, instrumentation, energy) is found even when nothing repeats.
    Values are clipped at 0 and scaled so a full contrast (blocks that share nothing)
    reads 1.
    """
    n = S.shape[0]
    nov = np.zeros(n)
    if L < 1 or n < 2 * L:
        return nov
    for c in range(L, n - L + 1):
        a = S[c - L:c, c - L:c]
        b = S[c:c + L, c:c + L]
        x = S[c - L:c, c:c + L]
        within = 0.5 * (a.mean() + b.mean())
        nov[c] = max(0.0, float(within - x.mean()))
    return nov


CB_FULL = 0.35  # contrast that counts as a complete change of material


def combined_novelty(S: np.ndarray, seq_L: int | None, bpb: int) -> np.ndarray:
    """Loop-aligned sequence novelty when a usable period is known (repetition evidence);
    otherwise the four-bar checkerboard contrast, which needs no period. Both live on a
    [0, 1] scale and both take the raw similarity matrix (see ``sequence_novelty``)."""
    n = S.shape[0]
    if seq_L is not None and n >= 2 * seq_L:
        return sequence_novelty(S, seq_L)
    L = 4 * bpb
    if n >= 2 * L:
        cb = checkerboard_novelty(S, L)
        if cb.max() > 0:
            return np.clip(cb / CB_FULL, 0.0, 1.0)
    L = 2 * bpb
    if n >= 2 * L:
        cb = checkerboard_novelty(S, L)
        if cb.max() > 0:
            return np.clip(cb / CB_FULL, 0.0, 1.0)
    return np.zeros(n)


def pick_boundaries(nov: np.ndarray, min_distance: int) -> tuple[np.ndarray, np.ndarray]:
    """Peak beat indices and their prominence relative to the strongest peak."""
    import scipy.signal

    if nov.size == 0 or nov.max() <= 0:
        return np.zeros(0, dtype=int), np.zeros(0)
    peaks, props = scipy.signal.find_peaks(nov, prominence=NOV_ABS, distance=max(1, min_distance))
    if peaks.size == 0:
        return np.zeros(0, dtype=int), np.zeros(0)
    proms = props["prominences"]
    rel = proms / proms.max()
    keep = (rel >= NOV_REL_PROM) & (nov[peaks] >= NOV_ABS)
    return peaks[keep].astype(int), rel[keep]


def snap_boundaries(peaks: np.ndarray, strengths: np.ndarray, downbeat_idx: np.ndarray,
                    n_beats: int, edge: int, snap_tol: int) -> dict[int, float]:
    """Novelty peaks -> {boundary beat index: strength}, snapped to a nearby downbeat.

    A section change lands on a bar line and the peak is accurate to about a beat, so a
    peak within ``snap_tol`` beats of a downbeat is moved onto it. A downbeat further away
    is not a refinement of the measurement, it is a different answer -- the peak is
    equidistant between two bar lines, or the grid is at the wrong metrical level or phase
    -- and moving the boundary there invents up to half a bar of error, so the peak stands.
    Boundaries within ``edge`` beats of either end of the file are dropped: a fade or a
    silent tail is not a section.
    """
    out: dict[int, float] = {}
    for p, r in zip(np.asarray(peaks, dtype=int), np.asarray(strengths, dtype=float)):
        b = int(p)
        if downbeat_idx.size:
            nearest = int(downbeat_idx[np.argmin(np.abs(downbeat_idx - b))])
            if abs(nearest - b) <= snap_tol:
                b = nearest
        if b < edge or b > n_beats - edge:
            continue
        out[b] = max(out.get(b, 0.0), float(r))
    return out


def merge_same_material(bound_idx: list[int], A: np.ndarray, threshold: float = REPEAT_SIM) -> list[int]:
    """Drop boundaries whose two sides measure as the same material.

    The test is the two sections' own aligned similarity against ``threshold`` (the same
    bar the loop period uses for "this is a repeat"), not whether they landed in the same
    cluster: ``k`` is chosen for the whole file, so two distinct sections sharing a cluster
    is a statement about the file's variety, not evidence that the novelty was wrong.
    """
    return [b for k, b in enumerate(bound_idx) if A[k, k + 1] < threshold]


def section_anchors(bounds: list[int], downbeat_idx: np.ndarray) -> list[int]:
    """Where each section's content starts if bar lines are trusted: its first downbeat, or
    its own start when it holds none.

    Only the first section normally differs, and only when the file opens with silence or a
    pickup -- which is exactly the section every other section is compared against.
    """
    out = []
    db = np.asarray(downbeat_idx, dtype=int)
    for start, end in zip(bounds[:-1], bounds[1:]):
        inside = db[(db >= start) & (db < end)]
        out.append(int(inside[0]) if inside.size else int(start))
    return out


def aligned_similarity(S: np.ndarray, bounds: list[int], shift: int = 1,
                       anchors: list[int] | None = None) -> np.ndarray:
    """Section-by-section similarity: the mean of ``S`` along the diagonal that lines the two
    sections up, best of +-``shift`` beats.

    Sections are lined up from ``anchors`` when given -- their first downbeat, which is their
    own start except where a section does not begin on a bar line. A first section that
    carries a silent lead-in or a pickup is compared bar for bar with the sections that
    repeat it instead of a pickup's worth out of phase, which reads as different material.
    Taking the best of both alignments instead would inflate the similarity of sections that
    are merely alike, and that number decides whether a boundary survives.
    """
    n_s = len(bounds) - 1
    starts = list(anchors) if anchors is not None else list(bounds[:-1])
    A = np.eye(n_s)
    for i in range(n_s):
        for j in range(i + 1, n_s):
            a0, a1 = starts[i], bounds[i + 1]
            b0, b1 = starts[j], bounds[j + 1]
            L = min(a1 - a0, b1 - b0)
            best = 0.0
            for sh in range(-shift, shift + 1):
                ia = np.arange(a0, a0 + L)
                ib = np.arange(b0 + sh, b0 + sh + L)
                m = (ib >= 0) & (ib < S.shape[0])
                if m.sum() < max(1, L // 2):
                    continue
                best = max(best, float(S[ia[m], ib[m]].mean()))
            A[i, j] = A[j, i] = max(best, 0.0)
    return A


def cluster_sections(A: np.ndarray) -> tuple[list[int], float]:
    """Cluster ids per section (in order of first appearance) and the silhouette of the chosen k."""
    n = A.shape[0]
    if n == 1:
        return [0], 1.0
    if n == 2:
        same = A[0, 1] > SAME_LABEL_SIM
        return ([0, 0] if same else [0, 1]), float(min(1.0, abs(A[0, 1] - SAME_LABEL_SIM) * 2))
    from sklearn.cluster import SpectralClustering
    from sklearn.metrics import silhouette_score

    D = np.clip(1.0 - A, 0.0, None)
    np.fill_diagonal(D, 0.0)
    best_labels, best_sil = None, -1.0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for k in range(2, min(MAX_CLUSTERS, n - 1) + 1):
            try:
                labels = SpectralClustering(n_clusters=k, affinity="precomputed", random_state=0).fit_predict(A + 1e-6)
            except Exception:
                continue
            if len(set(labels.tolist())) < 2:
                continue
            sil = float(silhouette_score(D, labels, metric="precomputed"))
            if sil > best_sil:
                best_labels, best_sil = labels, sil
    if best_labels is None or best_sil < SIL_MIN:
        return [0] * n, 0.0
    order: dict[int, int] = {}
    return [order.setdefault(int(lab), len(order)) for lab in best_labels], best_sil


def _label(i: int) -> str:
    return chr(ord("A") + i) if i < 26 else f"S{i}"


def _section_rms(y: np.ndarray, sr: int, start_s: float, end_s: float) -> float:
    a, b = int(start_s * sr), int(end_s * sr)
    seg = y[max(0, a):max(a + 1, b)]
    return float(np.sqrt(np.mean(seg.astype(np.float64) ** 2))) if seg.size else 0.0


def _whole_file(duration_s: float, bars: int, confidence: float, notes: str, loop_bars: int | None = None,
                loop_conf: float = 0.0, energy: float = 1.0) -> Structure:
    section = Section(start_s=0.0, end_s=float(duration_s), start_bar=0, bars=max(1, int(bars)), label="A",
                      energy=energy, confidence=float(np.clip(confidence, 0.0, 1.0)))
    return Structure(sections=[section], loop_period_bars=loop_bars, loop_period_confidence=float(np.clip(loop_conf, 0.0, 1.0)),
                     method=METHOD, notes=notes)


def run(y: np.ndarray, sr: int, ctx) -> Structure:
    """Structure section. Section confidence: novelty prominence of its boundaries and the silhouette of the
    labeling; loop_period_confidence: prominence of the repeat-histogram peak (see the module docstring)."""
    y = np.asarray(y, dtype=np.float32)
    duration = float(ctx.report.file.duration_s) if ctx.report.file.duration_s else float(len(y) / sr) if sr else 0.0
    duration = max(duration, float(len(y) / sr) if sr else 0.0)
    report = effective(ctx.report)
    meter = report.beats.meter if report.beats is not None else str(ctx.options.get("meter") or "4/4")
    bpb = grid.beats_per_bar(meter)
    beats = np.asarray(report.beats.times_s, dtype=float) if report.beats is not None else np.zeros(0)
    downbeats = np.asarray(report.beats.downbeats_s, dtype=float) if report.beats is not None else np.zeros(0)
    n = beats.size
    if n < 2 * bpb or y.size < 2048 or not np.any(y):
        return _whole_file(duration, 1, 0.0, "no beat grid (fewer than two bars of beats or silent audio); whole file is one section")
    bar_starts = grid.bar_grid(beats, downbeats, meter, duration)
    n_bars = int(bar_starts.size)
    try:
        X = beat_features(y, sr, beats)
        S = similarity_matrix(X)
        Spe = path_enhance(S)
    except Exception as exc:
        return _whole_file(duration, n_bars, 0.0, f"features failed: {type(exc).__name__}")

    # loop period: the shortest period the file actually repeats at
    h = repeat_histogram(Spe, bpb)
    lag, prom = loop_period(h, bpb, max_lag=n // MIN_LOOP_REPEATS)
    reliable = lag is not None and prom >= PERIOD_MIN_PROM
    loop_bars: int | None = None
    loop_conf = 0.0
    if reliable:
        loop_bars = max(1, int(round(lag / bpb)))
        loop_conf = min(1.0, prom / PERIOD_PROM_FULL)
        if abs(lag / bpb - round(lag / bpb)) > 0.25:
            loop_conf *= 0.5

    # boundaries: novelty on the loop-aligned diagonal, or contrast novelty without a period
    win_lag, win_prom = loop_period(h, bpb, max_lag=n // MIN_WINDOW_REPEATS)
    aligned = win_lag is not None and win_prom >= PERIOD_MIN_PROM
    L = max(bpb, int(win_lag) if aligned else 2 * bpb)
    nov = combined_novelty(S, int(win_lag) if aligned else None, bpb)
    peaks, rel_prom = pick_boundaries(nov, max(bpb, min(L // 2, 2 * bpb)))
    downbeat_idx = np.array(sorted({int(np.argmin(np.abs(beats - d))) for d in downbeats}), dtype=int) if downbeats.size else np.arange(0, n, bpb)
    boundaries = snap_boundaries(peaks, rel_prom, downbeat_idx, n, edge=max(L, 2 * bpb),
                                 snap_tol=max(1, int(round(SNAP_MAX_BARS * bpb))))
    bound_idx = sorted(boundaries)
    bounds = [0] + bound_idx + [n]

    # labels; a boundary between two stretches of the same material is not a section change
    A = aligned_similarity(Spe, bounds, anchors=section_anchors(bounds, downbeat_idx))
    cluster_ids, sil = cluster_sections(A)
    merged = merge_same_material(bound_idx, A)
    if len(merged) != len(bound_idx):
        bound_idx = merged
        bounds = [0] + bound_idx + [n]
        A = aligned_similarity(Spe, bounds, anchors=section_anchors(bounds, downbeat_idx))
        cluster_ids, sil = cluster_sections(A)

    # sections
    starts_s = [0.0] + [round(float(beats[i]), 4) for i in bound_idx]
    ends_s = starts_s[1:] + [float(duration)]  # the last section ends exactly at the file end
    start_bars = [0] + [grid.bar_index(s, bar_starts) for s in starts_s[1:]]
    # keep bar indices strictly increasing (two boundaries can share a bar only through tolerance rounding)
    for i in range(1, len(start_bars)):
        start_bars[i] = max(start_bars[i], start_bars[i - 1] + 1)
    energies = [_section_rms(y, sr, a, b) for a, b in zip(starts_s, ends_s)]
    e_max = max(energies) if energies and max(energies) > 0 else 1.0
    strengths = [1.0] + [boundaries[i] for i in bound_idx] + [1.0]
    sections = []
    for i, (s0, s1) in enumerate(zip(starts_s, ends_s)):
        bars = (start_bars[i + 1] - start_bars[i]) if i + 1 < len(start_bars) else max(1, n_bars - start_bars[i])
        if len(starts_s) == 1:
            conf = 0.5 + 0.5 * (1.0 - float(nov.max()) if nov.size else 1.0)
        else:
            conf = 0.5 * 0.5 * (strengths[i] + strengths[i + 1]) + 0.5 * float(np.clip(sil, 0.0, 1.0))
        if not aligned:
            conf *= 0.5
        sections.append(Section(start_s=float(s0), end_s=float(s1), start_bar=int(start_bars[i]), bars=max(1, int(bars)),
                                label=_label(cluster_ids[i]), energy=round(float(energies[i] / e_max), 4),
                                confidence=round(float(np.clip(conf, 0.0, 1.0)), 4)))
    if aligned:
        notes = None
    elif reliable:
        notes = (f"the {loop_bars}-bar loop repeats fewer than {MIN_WINDOW_REPEATS} times, too few to align the "
                 "novelty; boundaries from contrast novelty only")
    else:
        notes = "no reliable loop period; boundaries from contrast novelty only"
    return Structure(sections=sections, loop_period_bars=loop_bars, loop_period_confidence=round(float(np.clip(loop_conf, 0.0, 1.0)), 4),
                     method=METHOD, notes=notes)


__all__ = ["METHOD", "aligned_similarity", "beat_features", "checkerboard_novelty", "cluster_sections",
           "combined_novelty", "loop_period", "merge_same_material", "path_enhance", "pick_boundaries",
           "repeat_histogram", "run", "section_anchors", "sequence_novelty", "similarity_matrix",
           "snap_boundaries"]
