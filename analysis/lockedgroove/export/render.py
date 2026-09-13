"""Rendering one lane of the arrangement across the whole song.

The promise the zip makes is narrow and worth stating exactly:

> Drop every file in ``stems/`` at zero in any DAW and you get back what the
> producer heard in the session, sample for sample.

Three rules keep it true, and each one mirrors something the browser engine
already does rather than inventing a second interpretation of the song:

**Sample alignment.** A region's window is
``[round_half_up(start_s * sr), round_half_up(end_s * sr))`` — the *end* is
rounded, not the length — so two regions split at the same instant abut with
no gap and no overlap, and every lane is written at exactly the same total
length. ``round_half_up`` is the loop renderer's rule, imported rather than
re-derived, so the whole product rounds seconds to samples one way.

**Resampling, not stretching.** ``rate`` on a region is
``AudioBufferSourceNode.playbackRate``: the pitch moves with the tempo, the
way a sampler or a turntable does. The render does the same thing, with a
real resampler instead of the browser's interpolator, so the export is at
worst cleaner than the audition and never a different musical decision. Time
-stretching with pitch held is a separate transform that a render applied
upstream and that the lineage reports (``stretch``, ``cents``).

**The same 2 ms declick.** ``webAudio.ts`` ramps each scheduled piece in and
out over ``DECLICK_S`` because a region cut mid-waveform clicks. The export
applies the identical linear ramp, so what lands in the DAW is what played —
including the small dip either side of a split. Leaving it out would produce
a file that is *cleaner* than the session and therefore not the session.

Nothing here touches storage or the database: arrays in, arrays out.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Optional

import numpy as np

from ..loops.render import round_half_up
from .song import Region, Song, Track

DECLICK_S = 0.002
"""Mirrors ``DECLICK_S`` in ``web/lib/session/webAudio.ts``."""

CHANNELS = 2
"""Stems are stereo. A mono source is doubled, so a DAW never has to guess."""


def as_stereo(y: np.ndarray) -> np.ndarray:
    """``(2, n)`` float32 from ``(n,)``, ``(1, n)``, ``(n, 2)`` or ``(2, n)``."""
    arr = np.asarray(y, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[None, :]
    elif arr.ndim == 2:
        if arr.shape[0] > arr.shape[1]:
            arr = arr.T
    else:
        raise ValueError(f"unsupported audio shape {arr.shape}")
    if arr.shape[0] == 0:
        return np.zeros((CHANNELS, 0), dtype=np.float32)
    if arr.shape[0] == 1:
        return np.repeat(arr, CHANNELS, axis=0)
    return np.ascontiguousarray(arr[:CHANNELS], dtype=np.float32)


def region_window(region: Region, sr: int) -> tuple[int, int]:
    """``(start_sample, length_samples)`` of a region on the session timeline."""
    start = max(0, round_half_up(region.start_s * sr))
    end = max(start, round_half_up(region.end_s * sr))
    return start, end - start


def song_samples(song: Song, sr: int) -> int:
    """How long every stem is. One number for the whole export, so the files align."""
    return max(0, round_half_up(song.length_s * sr))


def resample_to(y: np.ndarray, n_out: int) -> np.ndarray:
    """Resample ``(channels, n)`` to exactly ``n_out`` samples, pitch moving with tempo.

    ``librosa.resample`` (band-limited) when it is importable, linear
    interpolation otherwise, so the renderer still works in a checkout without
    the DSP stack. The result is trimmed or zero-padded to ``n_out`` because a
    resampler's output length is a rounding of the ratio and the export cannot
    afford a lane that is one sample longer than its neighbours.
    """
    y = np.asarray(y, dtype=np.float32)
    n_in = y.shape[-1]
    if n_out <= 0:
        return np.zeros((y.shape[0], 0), dtype=np.float32)
    if n_in == n_out:
        return y
    if n_in == 0:
        return np.zeros((y.shape[0], n_out), dtype=np.float32)

    out: Optional[np.ndarray] = None
    if n_in > 1:
        try:
            import librosa

            out = np.asarray(
                librosa.resample(y, orig_sr=float(n_in), target_sr=float(n_out), res_type="soxr_hq"),
                dtype=np.float32,
            )
        except Exception:  # no librosa, or a ratio it refuses: fall back rather than fail the export
            out = None
    if out is None:
        # Linear interpolation over the same span the band-limited path covers.
        src = np.linspace(0.0, n_in - 1.0, n_out, dtype=np.float64)
        left = np.floor(src).astype(np.int64)
        right = np.minimum(left + 1, n_in - 1)
        frac = (src - left).astype(np.float32)
        out = (y[:, left] * (1.0 - frac) + y[:, right] * frac).astype(np.float32)

    if out.ndim == 1:
        out = out[None, :]
    if out.shape[-1] > n_out:
        return np.ascontiguousarray(out[:, :n_out])
    if out.shape[-1] < n_out:
        pad = np.zeros((out.shape[0], n_out - out.shape[-1]), dtype=np.float32)
        return np.concatenate([out, pad], axis=-1)
    return out


def declick(y: np.ndarray, sr: int, declick_s: float = DECLICK_S) -> np.ndarray:
    """The engine's ramp: linear 0 -> 1 in, 1 -> 0 out, each capped at half the piece."""
    n = y.shape[-1]
    if n == 0 or declick_s <= 0:
        return y
    fade = min(round_half_up(declick_s * sr), n // 2)
    if fade <= 0:
        return y
    ramp = np.linspace(0.0, 1.0, fade + 1, dtype=np.float32)[1:]
    y[:, :fade] *= ramp
    y[:, n - fade:] *= ramp[::-1]
    return y


def render_region(source: np.ndarray, sr: int, region: Region, *, gain: float = 1.0,
                  declick_s: float = DECLICK_S) -> np.ndarray:
    """The samples a region contributes, ``(2, length_samples)``.

    ``source`` is the whole record at ``sr``. A region that asks for audio past
    the end of the record gets silence there rather than an error: trimming to
    a tail that a re-analysis shortened is a producer's problem to see, not a
    reason to refuse the whole song.
    """
    y = as_stereo(source)
    _, n_out = region_window(region, sr)
    if n_out <= 0:
        return np.zeros((CHANNELS, 0), dtype=np.float32)

    src_from = max(0, round_half_up(region.offset_s * sr))
    n_src = max(1, round_half_up(region.offset_s * sr + n_out * region.rate) - src_from)
    taken = y[:, src_from:src_from + n_src]
    if taken.shape[-1] < n_src:
        pad = np.zeros((CHANNELS, n_src - taken.shape[-1]), dtype=np.float32)
        taken = np.concatenate([taken, pad], axis=-1)

    # Both branches produce a fresh array; the declick below writes in place.
    out = np.array(taken, dtype=np.float32, copy=True) if n_src == n_out else resample_to(taken, n_out)
    if gain != 1.0:
        out *= np.float32(gain)
    return declick(out, sr, declick_s)


def render_track(track: Track, sources: Mapping[str, np.ndarray], sr: int, total_samples: int, *,
                 track_gain: float = 1.0, declick_s: float = DECLICK_S) -> np.ndarray:
    """One lane across the whole song: ``(2, total_samples)``, silence where it is not sounding.

    Overlapping regions on one lane sum, which is what the scheduler does with
    them (it keys pieces by region, so two takes on one lane both sound) and
    what a producer layering two takes means.
    """
    out = np.zeros((CHANNELS, max(0, total_samples)), dtype=np.float32)
    if total_samples <= 0:
        return out
    for region in track.regions:
        source = sources.get(region.file_id)
        if source is None:
            raise KeyError(f"no audio loaded for file {region.file_id} (region {region.id})")
        start, length = region_window(region, sr)
        if length <= 0 or start >= total_samples:
            continue
        piece = render_region(source, sr, region, gain=region.gain, declick_s=declick_s)
        count = min(piece.shape[-1], total_samples - start)
        if count > 0:
            out[:, start:start + count] += piece[:, :count]
    if track_gain != 1.0:
        out *= np.float32(track_gain)
    return out


def peak_dbfs(y: np.ndarray) -> float:
    """True peak of the rendered lane, in dBFS. ``-inf`` for digital silence."""
    if y.size == 0:
        return -math.inf
    peak = float(np.max(np.abs(y)))
    return 20.0 * math.log10(peak) if peak > 0 else -math.inf


__all__ = ["CHANNELS", "DECLICK_S", "as_stereo", "declick", "peak_dbfs", "region_window", "render_region",
           "render_track", "resample_to", "song_samples"]
