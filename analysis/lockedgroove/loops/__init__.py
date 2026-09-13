"""Loops: finder (ranked candidates), renderer (snap + crossfade + WAV), export naming.

BUILD_PACKET section 7. ``find_loops`` reads the effective report; ``render_loop``
is ported sample-exact to ``web/lib/audio/renderLoop.ts`` for the client preview.
``sample_ready`` (the submodule) scores a span by what is and is not playing in
it, per stem, so "show me the vocal-free 4 bar loops in this record" is a query,
not an afternoon; its per-span entry point is
``lockedgroove.loops.sample_ready.sample_ready``, deliberately not re-exported
here so that the name keeps pointing at the module.
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
from .sample_ready import (
    CLAIM_NAMES,
    FLAG_CLAIM_NAMES,
    Claim,
    SampleReady,
    StemEnergies,
    StemSource,
    StemSpan,
    claim_of,
    filter_loops,
    holds,
    sort_loops,
    span_profile,
    stem_energies,
)

__all__ = [
    "CLAIM_NAMES", "DEFAULT_BARS", "DEFAULT_CROSSFADE_MS", "DOWNBEAT_CONFIDENCE_THRESHOLD",
    "FLAG_CLAIM_NAMES",
    "SUPPORTED_BIT_DEPTHS", "WEIGHTS", "ZERO_CROSSING_MAX_MS", "Claim", "LoopCandidate",
    "SampleReady", "StemEnergies", "StemSource", "StemSpan", "beats_per_bar", "bpm_token",
    "claim_of", "equal_power_curve", "export_wav", "filter_loops", "find_loops", "holds",
    "key_token", "loop_filename", "render_loop", "sanitize_base",
    "snap_to_zero_crossing", "sort_loops", "span_profile", "stem_energies",
]
