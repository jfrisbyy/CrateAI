"""The zip: what goes in it, what it is allowed to weigh, and how it is written.

The layout, and the reason for each part of it::

    Midnight-Flip_92bpm_Fm/          one folder, so unzipping into a DAW's
      README.txt                     project directory does not scatter files
      song.json
      tempo_map.mid
      tempo_map.txt
      stems/
        01_Drums_92bpm_Fm.flac
        02_Bass_92bpm_Fm.flac
      midi/
        01_Drums_pads.mid

**Size.** A ten-lane four-minute song at 24-bit stereo is 635 MB of PCM. That
is real, and it is why the format matters (see ``FORMATS`` below) and why the
cap is checked *before* anything is rendered, from arithmetic the caller can
be told: lanes x seconds x sample rate x channels x bytes per sample, times
the format's expected ratio. A job that would be too big fails in a second
with the number in the message instead of after ten minutes of work.

**Compression.** Audio goes in stored (level 0). FLAC is already compressed
and 24-bit PCM barely deflates, so deflating it costs seconds of CPU per lane
to save nothing; the text, JSON and MIDI entries deflate normally. This is the
same trade the kit bundle makes for its WAVs.

**Memory.** Entries are added from files on disk, one at a time, so the zip is
never held in memory. The renderer works one lane at a time for the same
reason: ten lanes of four-minute float32 stereo would be 847 MB resident.
"""

from __future__ import annotations

import json
import os
import zipfile
from dataclasses import dataclass, field
from typing import Any, Optional

from .song import ExportError

EXPORT_CAP_BYTES = 1024 * 1024 * 1024
"""1 GiB of finished zip. Ten lanes of a four-minute song as 24-bit FLAC is
about 350 MB, so the named hard case fits with room; the same song as 24-bit
WAV is about 635 MB and also fits. Twenty-four lanes of fifteen minutes as WAV
does not, and is refused up front with the arithmetic."""

FORMATS: dict[str, dict[str, Any]] = {
    # ratio: bytes on disk per byte of PCM, used for the pre-render estimate.
    # 0.62 is a deliberately pessimistic FLAC ratio for dense music; quiet or
    # sparse lanes come out far smaller, and under-promising is the safe way
    # round for a cap.
    "flac": {"subtype": {16: "PCM_16", 24: "PCM_24"}, "ratio": 0.62, "content_type": "audio/flac"},
    "wav": {"subtype": {16: "PCM_16", 24: "PCM_24"}, "ratio": 1.0, "content_type": "audio/wav"},
}
DEFAULT_FORMAT = "flac"
BIT_DEPTHS = (16, 24)
DEFAULT_BIT_DEPTH = 24
SAMPLE_RATES = (44100, 48000)
DEFAULT_SAMPLE_RATE = 44100

STEMS_DIR = "stems"
MIDI_DIR = "midi"
README_NAME = "README.txt"
MANIFEST_NAME = "song.json"
TEMPO_MIDI_NAME = "tempo_map.mid"
TEMPO_TEXT_NAME = "tempo_map.txt"


class ExportTooLargeError(ExportError):
    """The export would exceed ``EXPORT_CAP_BYTES``; the message carries the arithmetic."""


def bytes_per_sample(bit_depth: int) -> int:
    return 2 if int(bit_depth) == 16 else 3


def pcm_bytes(tracks: int, length_s: float, sample_rate: int, channels: int, bit_depth: int) -> int:
    """The uncompressed size of the stems, which is the number everything else scales from."""
    return int(max(0, tracks) * max(0.0, length_s) * sample_rate * channels * bytes_per_sample(bit_depth))


def estimate_bytes(tracks: int, length_s: float, sample_rate: int, channels: int, bit_depth: int,
                   fmt: str = DEFAULT_FORMAT) -> int:
    ratio = FORMATS.get(str(fmt).lower(), FORMATS[DEFAULT_FORMAT])["ratio"]
    return int(pcm_bytes(tracks, length_s, sample_rate, channels, bit_depth) * ratio)


def human_bytes(n: float) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.2f} GB"
    if n >= 1024 ** 2:
        return f"{n / 1024 ** 2:.0f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{int(n)} B"


def assert_under_cap(estimated: int, *, cap: int = EXPORT_CAP_BYTES, detail: str = "") -> None:
    if estimated > cap:
        raise ExportTooLargeError(
            f"this export would be about {human_bytes(estimated)}; the cap is {human_bytes(cap)}."
            + (f" {detail}" if detail else "")
        )


def cap_advice(fmt: str, bit_depth: int) -> str:
    """What a producer can actually do about a refusal, in the order that helps most."""
    options = []
    if str(fmt).lower() != "flac":
        options.append("export as FLAC (about 40% smaller, and lossless)")
    if int(bit_depth) > 16:
        options.append("drop to 16-bit")
    options.append("mute the lanes you do not need yet, or export a shorter section")
    return "Try: " + "; ".join(options) + "."


# ---------------------------------------------------------------------------
# the plan: every entry in the zip, decided before a sample is rendered
# ---------------------------------------------------------------------------


@dataclass
class StemEntry:
    """One lane's file, and what the readme and manifest say about it."""

    position: int
    track_id: str
    name: str
    filename: str
    gain: float
    muted: bool
    soloed: bool
    provenance: Optional[str] = None
    peak_dbfs: Optional[float] = None
    clipped: bool = False
    regions: list[dict[str, Any]] = field(default_factory=list)
    source_file_ids: list[str] = field(default_factory=list)

    @property
    def zip_path(self) -> str:
        return f"{STEMS_DIR}/{self.filename}"


@dataclass
class HeldBackEntry:
    """A lane that is in the song but not in the zip, and why. Nothing goes missing quietly."""

    position: int
    name: str
    reason: str
    provenance: Optional[str] = None


@dataclass
class MidiEntry:
    midi_id: str
    kind: str
    filename: str
    storage_path: str
    source_file_id: Optional[str] = None
    lane: Optional[str] = None

    @property
    def zip_path(self) -> str:
        return f"{MIDI_DIR}/{self.filename}"


@dataclass
class ExportPlan:
    """Everything the zip will contain. Built before rendering, so the cap can refuse early."""

    folder: str
    zip_name: str
    stems: list[StemEntry]
    held_back: list[HeldBackEntry] = field(default_factory=list)
    midi: list[MidiEntry] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    has_tempo_map: bool = False


def write_zip(path: str, folder: str, entries: list[tuple[str, str]], texts: list[tuple[str, str]],
              *, cap: int = EXPORT_CAP_BYTES) -> int:
    """Write the zip at ``path``; ``entries`` are ``(zip_path, local_path)``, ``texts`` ``(zip_path, body)``.

    Audio is stored, text deflated, everything nested under ``folder``. The cap
    is re-checked against the real bytes as they go in, because the pre-render
    estimate is arithmetic and this is the truth.
    """
    total = 0
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zf:
        for zip_path, local in entries:
            size = os.path.getsize(local)
            total += size
            assert_under_cap(total, cap=cap, detail="It was refused while being written.")
            compress = zipfile.ZIP_STORED if _is_audio(zip_path) else zipfile.ZIP_DEFLATED
            zf.write(local, f"{folder}/{zip_path}", compress_type=compress)
        for zip_path, body in texts:
            data = body.encode("utf-8")
            total += len(data)
            assert_under_cap(total, cap=cap, detail="It was refused while being written.")
            zf.writestr(f"{folder}/{zip_path}", data, compress_type=zipfile.ZIP_DEFLATED)
    return os.path.getsize(path)


def _is_audio(zip_path: str) -> bool:
    return os.path.splitext(zip_path)[1].lower() in (".flac", ".wav", ".aif", ".aiff")


def manifest_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=False, ensure_ascii=False) + "\n"


__all__ = ["BIT_DEPTHS", "DEFAULT_BIT_DEPTH", "DEFAULT_FORMAT", "DEFAULT_SAMPLE_RATE", "EXPORT_CAP_BYTES",
           "ExportPlan", "ExportTooLargeError", "FORMATS", "HeldBackEntry", "MANIFEST_NAME", "MIDI_DIR",
           "MidiEntry", "README_NAME", "SAMPLE_RATES", "STEMS_DIR", "StemEntry", "TEMPO_MIDI_NAME",
           "TEMPO_TEXT_NAME", "assert_under_cap", "bytes_per_sample", "cap_advice", "estimate_bytes",
           "human_bytes", "manifest_json", "pcm_bytes", "write_zip"]
