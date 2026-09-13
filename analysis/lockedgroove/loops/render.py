"""Loop renderer: zero-crossing snap, tail crossfade, WAV export.

BUILD_PACKET section 7; OPEN_QUESTIONS D.19-20. ``web/lib/audio/renderLoop.ts``
is a sample-exact port of ``render_loop`` for the client-side preview; the
shared vector ``tests/fixtures/loop_render_vector.json`` (built by
``scripts/gen_loop_vector.py`` from this file) is asserted by both. Keep the
two in step: every rule below is spelled out so the port can mirror it.

Rules shared with the TypeScript port
-------------------------------------
* Seconds -> samples: ``floor(x * sr + 0.5)`` (round half up; never banker's).
* Zero-crossing decision on the **mono sum** of the channels (summed in
  channel order, float64) so every channel moves together. Index ``j`` is a
  zero crossing when ``m[j-1]`` and ``m[j]`` have opposite signs or either is
  zero; the file boundaries ``0`` and ``n`` always count. The search runs
  ``d = 0, 1, ..., max_samples`` and at each distance tries ``j - d`` before
  ``j + d`` (ties resolve earlier). ``max_samples = floor(max_ms * sr / 1000)``
  so the snap can never exceed ``max_ms``. No crossing -> the edge stays.
* Crossfade length ``cf = floor(crossfade_ms * sr / 1000 + 0.5)``, capped at
  half the loop length.
* Equal-power curve over ``n`` samples (``equal_power_curve``)::

      theta_k    = (pi / 2) * k / (n - 1)      k = 0 .. n-1, n >= 2
      fade_in_k  = sin(theta_k)                (n == 1: theta = pi / 4)
      fade_out_k = cos(theta_k)
      fade_in^2 + fade_out^2 == 1

  so sample 0 of the crossfade is entirely the outgoing material and sample
  ``n - 1`` entirely the incoming one.
* ``mode = "tail"`` when ``end + cf <= n``: the audio *after* ``end`` wraps
  into the head, ``out[k] = y[start + k] * fade_in_k + y[end + k] * fade_out_k``
  for ``k < cf``. The wrap ``out[L-1] -> out[0]`` is then ``y[end-1] -> y[end]``,
  the recording's own continuity.
* ``mode = "self"`` otherwise (the loop ends at the end of the file): the
  crossfade moves to the loop's tail and blends in the audio that *precedes*
  ``start`` (``n_pre = min(cf, start)`` samples),
  ``out[L - n_pre + k] = y[end - n_pre + k] * fade_out_k + y[start - n_pre + k] * fade_in_k``,
  so the wrap is ``y[start-1] -> y[start]``. Mixing the loop's own tail into
  its head instead would leave a jump at the wrap (``y[end-1] -> y[end-cf]``);
  see docs/HANDOFF_loops.md. With no audio before ``start`` either (the loop
  is the whole file) the cut is raw and ``crossfade_samples`` is 0.
* Output length is exactly ``end - start`` samples after snapping, same
  channel count as the input; mono ``(n,)`` input comes back as ``(1, n)``.
* Arithmetic: products and sums in float64, stored as float32 (JS stores into
  a ``Float32Array``), same operation order.
"""

from __future__ import annotations

import math
import os
from typing import Any, Union

import numpy as np

DEFAULT_CROSSFADE_MS = 12.0
"""OPEN_QUESTIONS D.20: 12 ms equal-power crossfade."""
ZERO_CROSSING_MAX_MS = 2.0
"""OPEN_QUESTIONS D.20: snap within ±2 ms, never further."""
SUPPORTED_BIT_DEPTHS = {16: "PCM_16", 24: "PCM_24"}
"""OPEN_QUESTIONS D.19: 24-bit default, 16-bit allowed."""

PathLike = Union[str, "os.PathLike[str]"]


def round_half_up(x: float) -> int:
    """``floor(x + 0.5)``: the one rounding rule used for seconds -> samples."""
    return int(math.floor(x + 0.5))


def as_channels(y: np.ndarray) -> np.ndarray:
    """``(channels, n)`` float32 view of ``(n,)``, ``(channels, n)`` or ``(n, channels)`` input."""
    arr = np.asarray(y, dtype=np.float32)
    if arr.ndim == 1:
        return arr[None, :]
    if arr.ndim == 2:
        if arr.shape[1] > 0 and arr.shape[0] > arr.shape[1]:
            arr = arr.T
        return arr
    raise ValueError(f"unsupported audio shape {arr.shape}")


def mono_sum(y: np.ndarray) -> np.ndarray:
    """Float64 sum of the channels, added in channel order (same as the port)."""
    y2 = as_channels(y)
    m = np.zeros(y2.shape[1], dtype=np.float64)
    for c in range(y2.shape[0]):
        m += y2[c].astype(np.float64)
    return m


def _is_zero_crossing(m: np.ndarray, j: int) -> bool:
    n = m.shape[0]
    if j <= 0 or j >= n:
        return True
    a = float(m[j - 1])
    b = float(m[j])
    return (a <= 0.0 and b >= 0.0) or (a >= 0.0 and b <= 0.0)


def snap_to_zero_crossing(y: np.ndarray, sr: int, sample_index: int, max_ms: float = ZERO_CROSSING_MAX_MS) -> int:
    """Nearest zero crossing of the mono sum within ``±max_ms`` of ``sample_index``.

    ``y`` may be ``(n,)`` (already a mono sum) or ``(channels, n)``. Returns the
    original index when nothing is found within range. Never moves more than
    ``max_ms``: the sample budget is ``floor(max_ms * sr / 1000)``.
    """
    m = np.asarray(y, dtype=np.float64) if np.ndim(y) == 1 else mono_sum(y)
    n = m.shape[0]
    idx = min(max(int(sample_index), 0), n)
    max_samples = int(math.floor(max_ms * sr / 1000.0))
    if max_samples < 0:
        max_samples = 0
    for d in range(max_samples + 1):
        for j in ((idx - d, idx + d) if d else (idx,)):
            if 0 <= j <= n and _is_zero_crossing(m, j):
                return j
    return idx


def equal_power_curve(n: int) -> tuple[np.ndarray, np.ndarray]:
    """``(fade_in, fade_out)`` float64 arrays of length ``n``; see the module docstring."""
    n = int(n)
    if n <= 0:
        z = np.zeros(0, dtype=np.float64)
        return z, z.copy()
    if n == 1:
        theta = np.array([math.pi / 4.0], dtype=np.float64)
    else:
        theta = np.array([(math.pi / 2.0) * k / (n - 1) for k in range(n)], dtype=np.float64)
    return np.sin(theta), np.cos(theta)


def render_loop(y: np.ndarray, sr: int, start_s: float, end_s: float,
                crossfade_ms: float = DEFAULT_CROSSFADE_MS,
                snap_zero_crossing: bool = True) -> tuple[np.ndarray, dict[str, Any]]:
    """Render ``[start_s, end_s)`` of ``y`` as a seamless loop.

    Returns ``(out, meta)``: ``out`` is ``(channels, end - start)`` float32 and
    ``meta`` carries ``start_s``, ``end_s`` (after snapping), ``start_sample``,
    ``end_sample``, ``crossfade_ms`` (requested), ``crossfade_samples``
    (effective), ``mode`` (``"tail"`` | ``"self"``), ``snapped_start_ms`` and
    ``snapped_end_ms`` (signed shift each edge moved), plus ``sample_rate``,
    ``channels`` and ``length_samples``.
    """
    if sr <= 0:
        raise ValueError("sample rate must be positive")
    if not (math.isfinite(start_s) and math.isfinite(end_s)) or end_s <= start_s:
        raise ValueError("end_s must be greater than start_s")
    y2 = as_channels(y)
    n_ch, n = y2.shape
    if n_ch == 0 or n == 0:
        raise ValueError("empty audio")
    if not math.isfinite(crossfade_ms) or crossfade_ms < 0:
        crossfade_ms = 0.0

    start0 = min(max(round_half_up(start_s * sr), 0), n)
    end0 = min(max(round_half_up(end_s * sr), 0), n)
    if end0 <= start0:
        raise ValueError("loop is empty after rounding to samples")

    start, end = start0, end0
    if snap_zero_crossing:
        m = mono_sum(y2)
        start = snap_to_zero_crossing(m, sr, start0, ZERO_CROSSING_MAX_MS)
        end = snap_to_zero_crossing(m, sr, end0, ZERO_CROSSING_MAX_MS)
        if end <= start:
            start, end = start0, end0
    length = end - start

    cf = round_half_up(crossfade_ms * sr / 1000.0)
    cf = max(0, min(cf, length // 2))

    out = np.array(y2[:, start:end], dtype=np.float32, copy=True)
    if end + cf <= n:
        mode = "tail"
        n_cf = cf
        if n_cf > 0:
            fade_in, fade_out = equal_power_curve(n_cf)
            head = y2[:, start:start + n_cf].astype(np.float64)
            tail = y2[:, end:end + n_cf].astype(np.float64)
            out[:, :n_cf] = (head * fade_in + tail * fade_out).astype(np.float32)
    else:
        mode = "self"
        n_cf = min(cf, start)
        if n_cf > 0:
            fade_in, fade_out = equal_power_curve(n_cf)
            own_tail = y2[:, end - n_cf:end].astype(np.float64)
            pre = y2[:, start - n_cf:start].astype(np.float64)
            out[:, length - n_cf:] = (own_tail * fade_out + pre * fade_in).astype(np.float32)

    meta: dict[str, Any] = {
        "start_s": start / sr,
        "end_s": end / sr,
        "start_sample": int(start),
        "end_sample": int(end),
        "crossfade_ms": float(crossfade_ms),
        "crossfade_samples": int(n_cf),
        "mode": mode,
        "snapped_start_ms": (start - start0) * 1000.0 / sr,
        "snapped_end_ms": (end - end0) * 1000.0 / sr,
        "sample_rate": int(sr),
        "channels": int(n_ch),
        "length_samples": int(length),
    }
    return out, meta


def export_wav(path: PathLike, y: np.ndarray, sr: int, bit_depth: int = 24) -> str:
    """Write ``y`` (``(channels, n)`` or ``(n,)``) as PCM WAV; 24-bit default, 16 allowed."""
    try:
        subtype = SUPPORTED_BIT_DEPTHS[int(bit_depth)]
    except (KeyError, ValueError):
        raise ValueError(f"bit_depth must be one of {sorted(SUPPORTED_BIT_DEPTHS)}") from None
    import soundfile as sf

    y2 = as_channels(y)
    data = np.clip(y2.T, -1.0, 1.0)
    sf.write(str(path), data, int(sr), subtype=subtype, format="WAV")
    return str(path)


__all__ = [
    "DEFAULT_CROSSFADE_MS", "SUPPORTED_BIT_DEPTHS", "ZERO_CROSSING_MAX_MS", "as_channels",
    "equal_power_curve", "export_wav", "mono_sum", "render_loop", "round_half_up",
    "snap_to_zero_crossing",
]
