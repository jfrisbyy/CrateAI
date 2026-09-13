"""Export filenames.

A producer unzipping this into a DAW should know what they have before
opening anything, so every name carries the same four facts in the same
order, the way the loop renderer's exports already do (OPEN_QUESTIONS D.18):

    {position}_{lane}_{bpm}bpm_{key}.{ext}      01_Drums_92bpm_Fm.flac

* **Position first**, zero-padded, so an alphabetical listing — which is what
  every file browser and every DAW import dialog gives you — is the lane
  order the producer stacked them in.
* **The lane's name**, sanitized, because "Drums" is what they called it.
* **Tempo and key**, because these files will end up in a folder with other
  samples six months from now and a stem with no tempo in its name is a stem
  nobody uses again. Tokens the session has not measured are omitted rather
  than invented (principle 2).

``bpm_token`` and ``key_token`` come from ``lockedgroove.loops.naming`` so the
spelling of a key is the same here as on every other export in the product.
"""

from __future__ import annotations

import re
from typing import Optional

from ..loops.naming import bpm_token, key_token

MAX_TOKEN_LENGTH = 60
_ALLOWED = re.compile(r"[^A-Za-z0-9._#-]")

EXTENSIONS = {"flac": "flac", "wav": "wav"}


def safe_token(name: str, fallback: str = "track") -> str:
    """Filename-safe token: spaces become dashes, only ``[A-Za-z0-9._#-]`` survives.

    Path separators become dashes rather than being stripped with everything
    before them, so a lane called "Horns / Trumpet" keeps both words; leading
    dots and dashes are trimmed, so nothing that arrives looking like a path
    can leave looking like one.
    """
    s = re.sub(r"[\\/]+", "-", str(name or "")).strip()
    s = re.sub(r"\s+", "-", s)
    s = _ALLOWED.sub("", s)
    s = re.sub(r"-{2,}", "-", s).strip("-._")
    if len(s) > MAX_TOKEN_LENGTH:
        s = s[:MAX_TOKEN_LENGTH].rstrip("-._")
    return s or fallback


def grid_tokens(bpm: Optional[float], tonic: Optional[str], mode: Optional[str]) -> list[str]:
    """``["92bpm", "Fm"]``, dropping whichever of the two the session has not measured."""
    tokens: list[str] = []
    if bpm is not None and bpm > 0:
        try:
            tokens.append(bpm_token(bpm))
        except ValueError:
            pass
    if tonic and mode:
        try:
            tokens.append(key_token(tonic, mode))
        except ValueError:
            pass
    return tokens


def stem_filename(position: int, track_name: str, bpm: Optional[float], tonic: Optional[str],
                  mode: Optional[str], fmt: str = "flac") -> str:
    """``01_Drums_92bpm_Fm.flac``."""
    ext = EXTENSIONS.get(str(fmt).lower(), "flac")
    parts = [f"{max(1, int(position)):02d}", safe_token(track_name, "track"), *grid_tokens(bpm, tonic, mode)]
    return "_".join(parts) + "." + ext


def midi_filename(position: int, label: str, kind: str) -> str:
    """``01_Drums_pads.mid``; the lane it belongs to first, then what the MIDI is."""
    parts = [f"{max(1, int(position)):02d}", safe_token(label, "midi"), safe_token(kind, "midi")]
    return "_".join(parts) + ".mid"


def folder_name(song_name: str, bpm: Optional[float], tonic: Optional[str], mode: Optional[str]) -> str:
    """``Midnight-Flip_92bpm_Fm``: the one folder everything unzips into."""
    parts = [safe_token(song_name, "song"), *grid_tokens(bpm, tonic, mode)]
    return "_".join(parts)


def zip_filename(song_name: str, bpm: Optional[float], tonic: Optional[str], mode: Optional[str]) -> str:
    return folder_name(song_name, bpm, tonic, mode) + "_stems.zip"


def unique_names(names: list[str]) -> list[str]:
    """``name.ext`` -> ``name-2.ext``, ``name-3.ext`` ... so two lanes can share a name."""
    taken: set[str] = set()
    out: list[str] = []
    for name in names:
        candidate = name
        n = 1
        while candidate in taken:
            n += 1
            dot = name.rfind(".")
            candidate = f"{name[:dot]}-{n}{name[dot:]}" if dot > 0 else f"{name}-{n}"
        taken.add(candidate)
        out.append(candidate)
    return out


__all__ = ["EXTENSIONS", "MAX_TOKEN_LENGTH", "folder_name", "grid_tokens", "midi_filename", "safe_token",
           "stem_filename", "unique_names", "zip_filename"]
