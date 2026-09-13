"""The song, as it reaches compute.

The arrangement lives in the browser (``web/lib/session/arrangement.ts``) and
is not persisted yet, so the export job carries it in ``jobs.params.song``.
This module is the other end of that wire: it validates the shape, refuses
what cannot be rendered, and hands the renderer plain dataclasses.

Every field is snake_case here; ``web/lib/export/request.ts`` does the one
mapping from the session's camelCase types, so nothing downstream has to know
two spellings. The numbers mean exactly what they mean in the session:

* ``start_s`` / ``duration_s`` are session seconds, and bar 1 is second zero.
* ``offset_s`` is seconds into the *source*, from the file's zero (the
  downbeat is in the lineage, not here).
* ``rate`` is resampling at playback: 0.964 eats the record 3.6% faster and
  moves the pitch with it, the way a sampler does.
* ``gain`` is linear, never dB, on both the lane and the region.

Nothing here touches audio or storage, so the whole of it is asserted in
pytest against hand-built dicts.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Optional

MAX_TRACKS = 24
"""More lanes than this and the zip is not a song, it is a library."""
MAX_REGIONS = 4000
"""A four-minute song chopped to sixteenths on ten lanes is about 2500."""
MAX_LENGTH_S = 900.0
"""Fifteen minutes. Past this the render is a batch job, not a request."""
MAX_NAME_LEN = 120
MAX_LINE_LEN = 400
"""Lineage lines are derived in the browser; they land in the producer's own
readme, but they are still caller input, so they are bounded and stripped."""

MIN_REGION_S = 0.02
"""Mirrors ``MIN_REGION_S`` in arrangement.ts: shorter is a click, not a sound."""


class ExportError(ValueError):
    """The song cannot be exported as asked; ``str(exc)`` reaches ``jobs.error``."""


def _num(raw: Mapping[str, Any], key: str, *, default: Optional[float] = None,
         minimum: Optional[float] = None, maximum: Optional[float] = None, what: str = "") -> float:
    value = raw.get(key, default)
    if value is None:
        if default is None:
            raise ExportError(f"{what or key} is required")
        value = default
    try:
        out = float(value)
    except (TypeError, ValueError):
        raise ExportError(f"{what or key} must be a number, got {value!r}") from None
    if not math.isfinite(out):
        raise ExportError(f"{what or key} must be finite, got {value!r}")
    if minimum is not None and out < minimum:
        raise ExportError(f"{what or key} must be at least {minimum}, got {out}")
    if maximum is not None and out > maximum:
        raise ExportError(f"{what or key} must be at most {maximum}, got {out}")
    return out


def _text(value: Any, *, limit: int = MAX_NAME_LEN) -> Optional[str]:
    """Caller text, made safe to write into a readme: no control characters, bounded."""
    if value is None:
        return None
    s = str(value)
    # A control character becomes a space rather than vanishing: a name with a
    # newline in it is still two words, and the readme is a text file.
    s = "".join(ch if ch >= " " and ch != "\x7f" else " " for ch in s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s or None


@dataclass(frozen=True)
class Lineage:
    """What a region is: which record, which separation, which span, what transform.

    The mirror of ``RegionLineage`` in ``web/lib/session/lineage.ts``. Nothing
    here is measured by compute; it is carried so the readme can say it.
    """

    file_id: Optional[str] = None
    file_name: Optional[str] = None
    parent_file_id: Optional[str] = None
    kind: Optional[str] = None
    stem: Optional[str] = None
    separation_model: Optional[str] = None
    separation_model_label: Optional[str] = None
    take_start_s: Optional[float] = None
    take_end_s: Optional[float] = None
    downbeat_s: float = 0.0
    source_duration_s: Optional[float] = None
    source_bpm: Optional[float] = None
    source_beats_per_bar: int = 4
    cents: float = 0.0
    stretch: float = 1.0
    candidate_id: Optional[str] = None
    reason: Optional[str] = None
    confidence: Optional[float] = None

    @classmethod
    def parse(cls, raw: Any) -> Optional["Lineage"]:
        if not isinstance(raw, Mapping):
            return None

        def opt_float(key: str) -> Optional[float]:
            v = raw.get(key)
            if v is None:
                return None
            try:
                f = float(v)
            except (TypeError, ValueError):
                return None
            return f if math.isfinite(f) else None

        beats = opt_float("source_beats_per_bar")
        return cls(
            file_id=_text(raw.get("file_id"), limit=64),
            file_name=_text(raw.get("file_name")),
            parent_file_id=_text(raw.get("parent_file_id"), limit=64),
            kind=_text(raw.get("kind"), limit=32),
            stem=_text(raw.get("stem"), limit=32),
            separation_model=_text(raw.get("separation_model"), limit=64),
            separation_model_label=_text(raw.get("separation_model_label")),
            take_start_s=opt_float("take_start_s"),
            take_end_s=opt_float("take_end_s"),
            downbeat_s=opt_float("downbeat_s") or 0.0,
            source_duration_s=opt_float("source_duration_s"),
            source_bpm=opt_float("source_bpm"),
            source_beats_per_bar=int(beats) if beats and beats > 0 else 4,
            cents=opt_float("cents") or 0.0,
            stretch=opt_float("stretch") or 1.0,
            candidate_id=_text(raw.get("candidate_id"), limit=64),
            reason=_text(raw.get("reason"), limit=MAX_LINE_LEN),
            confidence=opt_float("confidence"),
        )


@dataclass(frozen=True)
class SourceBars:
    """The record's own bars a region covers; derived in the browser by ``sourceBars``."""

    from_bar: int
    to_bar: int
    bars: float

    @classmethod
    def parse(cls, raw: Any) -> Optional["SourceBars"]:
        if not isinstance(raw, Mapping):
            return None
        try:
            return cls(int(raw["from_bar"]), int(raw["to_bar"]), round(float(raw["bars"]), 2))
        except (KeyError, TypeError, ValueError):
            return None

    def label(self) -> str:
        return f"bar {self.from_bar}" if self.from_bar == self.to_bar else f"bars {self.from_bar}-{self.to_bar}"


@dataclass(frozen=True)
class Region:
    """One piece of one record on one lane."""

    id: str
    file_id: str
    start_s: float
    duration_s: float
    offset_s: float
    gain: float = 1.0
    rate: float = 1.0
    lineage: Optional[Lineage] = None
    lineage_line: Optional[str] = None
    source_bars: Optional[SourceBars] = None

    @property
    def end_s(self) -> float:
        return self.start_s + self.duration_s

    @property
    def source_seconds(self) -> float:
        """Seconds of the record this region eats. A resample eats faster than the timeline."""
        return self.duration_s * self.rate

    @classmethod
    def parse(cls, raw: Any, *, where: str) -> "Region":
        if not isinstance(raw, Mapping):
            raise ExportError(f"{where} must be an object")
        file_id = _text(raw.get("file_id"), limit=64)
        if not file_id:
            raise ExportError(f"{where}.file_id is required")
        duration_s = _num(raw, "duration_s", minimum=0.0, maximum=MAX_LENGTH_S, what=f"{where}.duration_s")
        if duration_s < MIN_REGION_S:
            raise ExportError(f"{where}.duration_s is {duration_s:.4f}s, shorter than the {MIN_REGION_S}s minimum")
        return cls(
            id=_text(raw.get("id"), limit=64) or file_id,
            file_id=file_id,
            start_s=_num(raw, "start_s", default=0.0, minimum=0.0, maximum=MAX_LENGTH_S, what=f"{where}.start_s"),
            duration_s=duration_s,
            offset_s=_num(raw, "offset_s", default=0.0, minimum=0.0, what=f"{where}.offset_s"),
            gain=_num(raw, "gain", default=1.0, minimum=0.0, maximum=8.0, what=f"{where}.gain"),
            rate=_num(raw, "rate", default=1.0, minimum=0.05, maximum=8.0, what=f"{where}.rate"),
            lineage=Lineage.parse(raw.get("lineage")),
            lineage_line=_text(raw.get("lineage_line"), limit=MAX_LINE_LEN),
            source_bars=SourceBars.parse(raw.get("source_bars")),
        )


@dataclass(frozen=True)
class Track:
    """One lane of the song, with the regions on it in start order."""

    id: str
    name: str
    position: int
    gain: float = 1.0
    muted: bool = False
    soloed: bool = False
    provenance: Optional[str] = None
    regions: tuple[Region, ...] = field(default_factory=tuple)

    @property
    def end_s(self) -> float:
        return max((r.end_s for r in self.regions), default=0.0)

    @property
    def file_ids(self) -> list[str]:
        seen: dict[str, None] = {}
        for r in self.regions:
            seen.setdefault(r.file_id, None)
        return list(seen)

    @property
    def lineage(self) -> Optional[Lineage]:
        """The lane's own claim: the first region that has one. Regions say the bars."""
        for r in self.regions:
            if r.lineage is not None:
                return r.lineage
        return None

    @classmethod
    def parse(cls, raw: Any, *, index: int) -> "Track":
        where = f"song.tracks[{index}]"
        if not isinstance(raw, Mapping):
            raise ExportError(f"{where} must be an object")
        raw_regions = raw.get("regions")
        if not isinstance(raw_regions, Sequence) or isinstance(raw_regions, (str, bytes)):
            raise ExportError(f"{where}.regions must be a list")
        regions = tuple(
            sorted(
                (Region.parse(r, where=f"{where}.regions[{i}]") for i, r in enumerate(raw_regions)),
                key=lambda r: (r.start_s, r.id),
            )
        )
        track_id = _text(raw.get("id"), limit=64)
        if not track_id:
            raise ExportError(f"{where}.id is required")
        position_raw = raw.get("position", index)
        try:
            position = int(position_raw)
        except (TypeError, ValueError):
            position = index
        return cls(
            id=track_id,
            name=_text(raw.get("name")) or f"Track {index + 1}",
            position=position,
            gain=_num(raw, "gain", default=1.0, minimum=0.0, maximum=4.0, what=f"{where}.gain"),
            muted=bool(raw.get("muted", False)),
            soloed=bool(raw.get("soloed", False)),
            provenance=_text(raw.get("provenance"), limit=MAX_LINE_LEN),
            regions=regions,
        )


@dataclass(frozen=True)
class SongKey:
    tonic: str
    mode: str
    from_file_id: Optional[str] = None
    from_file_name: Optional[str] = None

    @classmethod
    def parse(cls, raw: Any) -> Optional["SongKey"]:
        if not isinstance(raw, Mapping):
            return None
        tonic = _text(raw.get("tonic"), limit=8)
        mode = _text(raw.get("mode"), limit=16)
        if not tonic or mode not in ("major", "minor"):
            return None
        return cls(tonic=tonic, mode=mode,
                   from_file_id=_text(raw.get("from_file_id"), limit=64),
                   from_file_name=_text(raw.get("from_file_name")))


@dataclass(frozen=True)
class Song:
    """The arrangement: lanes, regions, and the grid the whole session obeys."""

    name: str
    tracks: tuple[Track, ...]
    bpm: Optional[float] = None
    beats_per_bar: int = 4
    key: Optional[SongKey] = None
    master_gain: float = 1.0

    @property
    def length_s(self) -> float:
        return max((t.end_s for t in self.tracks), default=0.0)

    @property
    def solo_mode(self) -> bool:
        """Anything soloed puts the session in solo mode (``mix.ts`` ``anySoloed``)."""
        return any(t.soloed and not t.muted for t in self.tracks)

    def audible(self, track: Track) -> bool:
        """``mix.ts`` ``audible``: mute wins over solo on the same lane."""
        if track.muted:
            return False
        return track.soloed if self.solo_mode else True

    def seconds_per_bar(self) -> Optional[float]:
        if not self.bpm or self.bpm <= 0 or self.beats_per_bar <= 0:
            return None
        return (60.0 / self.bpm) * self.beats_per_bar

    def bar_at(self, seconds: float) -> Optional[float]:
        """1-based bar position of a session second; None when the session has no tempo."""
        per_bar = self.seconds_per_bar()
        if per_bar is None:
            return None
        return max(0.0, seconds) / per_bar + 1.0

    @classmethod
    def parse(cls, raw: Any) -> "Song":
        if not isinstance(raw, Mapping):
            raise ExportError("params.song must be an object")
        raw_tracks = raw.get("tracks")
        if not isinstance(raw_tracks, Sequence) or isinstance(raw_tracks, (str, bytes)) or not raw_tracks:
            raise ExportError("params.song.tracks must be a non-empty list")
        if len(raw_tracks) > MAX_TRACKS:
            raise ExportError(f"the song has {len(raw_tracks)} lanes; the export takes at most {MAX_TRACKS}")
        tracks = tuple(sorted((Track.parse(t, index=i) for i, t in enumerate(raw_tracks)),
                              key=lambda t: (t.position, t.id)))
        total_regions = sum(len(t.regions) for t in tracks)
        if total_regions == 0:
            raise ExportError("the song has no regions: there is nothing to render")
        if total_regions > MAX_REGIONS:
            raise ExportError(f"the song has {total_regions} regions; the export takes at most {MAX_REGIONS}")

        bpm_raw = raw.get("bpm")
        bpm: Optional[float] = None
        if bpm_raw is not None:
            bpm = _num(raw, "bpm", minimum=20.0, maximum=400.0, what="song.bpm")
        beats_raw = raw.get("beats_per_bar", 4)
        try:
            beats = int(beats_raw)
        except (TypeError, ValueError):
            beats = 4
        song = cls(
            name=_text(raw.get("name")) or "Untitled song",
            tracks=tracks,
            bpm=bpm,
            beats_per_bar=beats if 1 <= beats <= 16 else 4,
            key=SongKey.parse(raw.get("key")),
            master_gain=_num(raw, "master_gain", default=1.0, minimum=0.0, maximum=4.0, what="song.master_gain"),
        )
        if song.length_s > MAX_LENGTH_S:
            raise ExportError(
                f"the song is {song.length_s / 60:.1f} minutes long; the export takes at most "
                f"{MAX_LENGTH_S / 60:.0f} minutes"
            )
        return song


def exported_tracks(song: Song, include_muted: bool = False) -> tuple[list[Track], list[Track]]:
    """``(exported, held_back)``.

    A lane the producer cannot hear is a decision they already made, so by
    default it is not a stem — it is listed in the readme instead, with its
    lineage, so nothing goes missing quietly. ``include_muted`` renders it
    anyway, at its own fader, for the producer who wants the material back.
    """
    exported: list[Track] = []
    held: list[Track] = []
    for track in song.tracks:
        if song.audible(track) or include_muted:
            exported.append(track)
        else:
            held.append(track)
    return exported, held


__all__ = ["ExportError", "Lineage", "MAX_LENGTH_S", "MAX_NAME_LEN", "MAX_REGIONS", "MAX_TRACKS", "MIN_REGION_S",
           "Region", "Song", "SongKey", "SourceBars", "Track", "exported_tracks"]
