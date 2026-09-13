"""Export filenames for loops: ``{base}[_{stem}]_{bpm}bpm_{key}_{bars}bar.wav``.

OPEN_QUESTIONS D.18 (naming) and C.13 (key spelling). The report keeps sharps;
the filename uses the spelling producers say: flats for the major keys where
that is conventional (Db, Eb, Ab, Bb; F# stays F#), minor keys keep sharps
except Eb minor and Bb minor. Minor gets an ``m`` suffix, major nothing.
"""

from __future__ import annotations

import os
import re

BPM_INTEGER_TOLERANCE = 0.05
"""A BPM within this of an integer prints as that integer, else with one decimal."""
MAX_BASE_LENGTH = 80
"""Longest sanitized base (or stem) token, so exported names stay portable."""

MAJOR_SPELLING = {
    "C": "C", "C#": "Db", "D": "D", "D#": "Eb", "E": "E", "F": "F",
    "F#": "F#", "G": "G", "G#": "Ab", "A": "A", "A#": "Bb", "B": "B",
}
MINOR_SPELLING = {
    "C": "C", "C#": "C#", "D": "D", "D#": "Eb", "E": "E", "F": "F",
    "F#": "F#", "G": "G", "G#": "G#", "A": "A", "A#": "Bb", "B": "B",
}
_FLAT_TO_SHARP = {"DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#", "CB": "B", "FB": "E"}

_AUDIO_EXTENSIONS = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wma"}
_ALLOWED = re.compile(r"[^A-Za-z0-9._#-]")


def _normalize_tonic(tonic: str) -> str:
    t = tonic.strip().replace("♯", "#").replace("♭", "b")
    if not t:
        raise ValueError("empty tonic")
    letter = t[0].upper()
    rest = t[1:]
    if rest.lower() == "b" and letter + "B" in _FLAT_TO_SHARP:
        return _FLAT_TO_SHARP[letter + "B"]
    if rest == "#":
        return letter + "#"
    if rest == "":
        return letter
    raise ValueError(f"unrecognized tonic {tonic!r}")


def key_token(tonic: str, mode: str) -> str:
    """``Fm``, ``Bb``, ``C#m``, ``Ebm``: conventional spelling, ``m`` for minor."""
    t = _normalize_tonic(tonic)
    mode_l = (mode or "").strip().lower()
    if mode_l in ("minor", "min", "m"):
        table, suffix = MINOR_SPELLING, "m"
    elif mode_l in ("major", "maj", ""):
        table, suffix = MAJOR_SPELLING, ""
    else:
        raise ValueError(f"unrecognized mode {mode!r}")
    if t not in table:
        raise ValueError(f"unrecognized tonic {tonic!r}")
    return table[t] + suffix


def bpm_token(bpm: float) -> str:
    """``90bpm`` when within 0.05 of an integer, else one decimal (``92.5bpm``)."""
    b = float(bpm)
    if not b > 0:
        raise ValueError("bpm must be positive")
    r = round(b)
    if abs(b - r) <= BPM_INTEGER_TOLERANCE + 1e-9:
        return f"{int(r)}bpm"
    return f"{b:.1f}bpm"


def sanitize_base(name: str, strip_audio_extension: bool = True) -> str:
    """Filename-safe token: spaces -> ``-``, keep only ``[A-Za-z0-9._#-]``, never empty."""
    s = os.path.basename(str(name or "")).strip()
    if strip_audio_extension:
        root, ext = os.path.splitext(s)
        if ext.lower() in _AUDIO_EXTENSIONS:
            s = root
    s = re.sub(r"\s+", "-", s)
    s = _ALLOWED.sub("", s)
    s = re.sub(r"-{2,}", "-", s)
    s = s.strip("-._")
    if len(s) > MAX_BASE_LENGTH:
        s = s[:MAX_BASE_LENGTH].rstrip("-._")
    return s or "loop"


def loop_filename(base_name: str, bpm: float | None, tonic: str | None, mode: str | None,
                  bars: int, stem: str | None = None, ext: str = "wav") -> str:
    """``{base}[_{stem}]_{bpm}bpm_{key}_{bars}bar.{ext}``.

    ``bpm`` or the key may be ``None`` when the report lacks them; their tokens
    are then omitted rather than inventing a value (principle 2).
    """
    parts = [sanitize_base(base_name)]
    if stem:
        parts.append(sanitize_base(stem, strip_audio_extension=False))
    if bpm is not None:
        parts.append(bpm_token(bpm))
    if tonic is not None and mode is not None:
        parts.append(key_token(tonic, mode))
    parts.append(f"{int(bars)}bar")
    ext_clean = (ext or "wav").lstrip(".").lower() or "wav"
    return "_".join(parts) + "." + ext_clean


__all__ = ["BPM_INTEGER_TOLERANCE", "MAJOR_SPELLING", "MINOR_SPELLING", "bpm_token", "key_token",
           "loop_filename", "sanitize_base"]
