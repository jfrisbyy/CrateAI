"""Loops: finder (ranked candidates), renderer (snap + crossfade + WAV), export naming.

BUILD_PACKET section 7. ``find_loops`` reads the effective report; ``render_loop``
is ported sample-exact to ``web/lib/audio/renderLoop.ts`` for the client preview.
"""

from .finder import (
    DEFAULT_BARS,
    DOWNBEAT_CONFIDENCE_THRESHOLD,
    WEIGHTS,
    LoopCandidate,
    beats_per_bar,
    find_loops,
)
from .naming import bpm_token, key_token, loop_filename, sanitize_base
from .render import (
    DEFAULT_CROSSFADE_MS,
    SUPPORTED_BIT_DEPTHS,
    ZERO_CROSSING_MAX_MS,
    equal_power_curve,
    export_wav,
    render_loop,
    snap_to_zero_crossing,
)

__all__ = [
    "DEFAULT_BARS", "DEFAULT_CROSSFADE_MS", "DOWNBEAT_CONFIDENCE_THRESHOLD", "SUPPORTED_BIT_DEPTHS",
    "WEIGHTS", "ZERO_CROSSING_MAX_MS", "LoopCandidate", "beats_per_bar", "bpm_token",
    "equal_power_curve", "export_wav", "find_loops", "key_token", "loop_filename", "render_loop",
    "sanitize_base", "snap_to_zero_crossing",
]
