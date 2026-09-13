"""Neural re-voice: audio-to-audio timbre transfer. Deferred with a written reason.

Evaluation plan (Phase 7): DDSP-family models (monophonic, controllable via
f0 and loudness) and RAVE-family models (broader timbre, less controllable).
Ships behind the same interface as the symbolic path, labeled experimental,
only if it clearly beats the symbolic path on monophonic sources. The source
is always the user's audio; this path never generates a part from nothing.
"""

from __future__ import annotations

from typing import Any

AVAILABLE = False
REASON = ("neural re-voice is not shipped: the DDSP and RAVE candidates are evaluated in Phase 7 and "
          "recorded in docs/PROPOSALS.md; use path='symbolic' (returns editable MIDI)")


def is_available() -> bool:
    return AVAILABLE


def revoice_neural(y, sr: int, instrument: str, **params: Any):
    raise NotImplementedError(REASON)


__all__ = ["AVAILABLE", "REASON", "is_available", "revoice_neural"]
