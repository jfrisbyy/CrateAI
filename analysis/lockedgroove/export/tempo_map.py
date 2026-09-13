"""The tempo map: where the bars are, in the two forms a DAW and a human read.

A pile of stems is useless to a DAW that does not know the grid. The session
has a measured tempo and a metre, and the export emits it twice:

``tempo_map.mid``
    A format-1 MIDI file, 480 ticks per beat, whose first track is a
    conductor track: ``set_tempo``, ``time_signature``, ``key_signature``
    where the session has a key, and ``end_of_track`` at the song's length.
    It carries no notes. This is the most portable grid there is: Logic,
    Reaper, Cubase, Studio One, Bitwig, Pro Tools and FL Studio all read a
    tempo track on MIDI import; Ableton Live reads it when the import dialog
    is told to. A file with no notes imports as an empty track carrying the
    tempo, which is exactly the intent.

``tempo_map.txt``
    The same information as text, one row per tempo event, so a producer can
    read it and a script can parse it without a MIDI library.

**One tempo, honestly.** The session's grid is a single BPM (``SessionTempo``
in ``web/lib/session/time.ts``); nothing in the pipeline measures a tempo
curve for an arrangement, so the map states one tempo and does not invent a
drift it has not measured (principle 2). The drift that does exist is in the
*records*: each lane's own tempo and the resample rate that fits it to the
session are named in the readme, per lane, with its lineage. The writer takes
a list of events rather than a scalar so a measured curve drops straight in
the day one exists.
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Optional

TICKS_PER_BEAT = 480
DEFAULT_BEATS_PER_BAR = 4


@dataclass(frozen=True)
class TempoEvent:
    """A tempo (and metre) in force from ``time_s`` until the next event."""

    time_s: float
    bpm: float
    beats_per_bar: int = DEFAULT_BEATS_PER_BAR

    @property
    def seconds_per_bar(self) -> float:
        return (60.0 / self.bpm) * self.beats_per_bar if self.bpm > 0 else 0.0


def _key_signature(tonic: Optional[str], mode: Optional[str]) -> Optional[str]:
    """The MIDI ``key_signature`` string, in the spelling producers use, or None."""
    if not tonic or not mode:
        return None
    try:
        from ..loops.naming import key_token

        return key_token(tonic, mode)
    except Exception:
        return None


def tempo_map_midi(events: Sequence[TempoEvent], length_s: float, *, name: str = "Cratebox tempo map",
                   tonic: Optional[str] = None, mode: Optional[str] = None) -> bytes:
    """The conductor track as MIDI bytes. Raises ``RuntimeError`` when ``mido`` is missing."""
    if not events:
        raise ValueError("a tempo map needs at least one tempo event")
    try:
        import mido
    except ModuleNotFoundError as exc:  # pragma: no cover - mido is a hard dependency
        raise RuntimeError("mido is required to write the tempo map") from exc

    midi = mido.MidiFile(type=1, ticks_per_beat=TICKS_PER_BEAT)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage("track_name", name=name[:120], time=0))

    ordered = sorted(events, key=lambda e: e.time_s)
    first = ordered[0]
    track.append(mido.MetaMessage("time_signature", numerator=max(1, first.beats_per_bar), denominator=4, time=0))
    key = _key_signature(tonic, mode)
    if key is not None:
        try:
            track.append(mido.MetaMessage("key_signature", key=key, time=0))
        except Exception:  # an unconventional spelling is not worth failing an export for
            pass

    # Ticks are counted in beats of the tempo in force, so the conversion walks
    # the events rather than dividing the whole song by one tempo.
    tick = 0
    last_tick = 0
    for i, event in enumerate(ordered):
        if i > 0:
            previous = ordered[i - 1]
            beats = max(0.0, event.time_s - previous.time_s) * previous.bpm / 60.0
            tick += int(round(beats * TICKS_PER_BEAT))
            if event.beats_per_bar != previous.beats_per_bar:
                track.append(mido.MetaMessage("time_signature", numerator=max(1, event.beats_per_bar),
                                              denominator=4, time=tick - last_tick))
                last_tick = tick
        track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(event.bpm), time=tick - last_tick))
        last_tick = tick

    final = ordered[-1]
    end_tick = tick + int(round(max(0.0, length_s - final.time_s) * final.bpm / 60.0 * TICKS_PER_BEAT))
    track.append(mido.MetaMessage("end_of_track", time=max(0, end_tick - last_tick)))

    buffer = io.BytesIO()
    midi.save(file=buffer)
    return buffer.getvalue()


def tempo_map_text(events: Sequence[TempoEvent], length_s: float, *, sample_rate: int,
                   tonic: Optional[str] = None, mode: Optional[str] = None) -> str:
    """The same grid as plain text. Free to produce and readable without a MIDI library."""
    lines = [
        "# Cratebox AI tempo map",
        "# Every stem in stems/ starts at position 0.000 and is exactly this long.",
        f"# length_s\t{length_s:.6f}",
        f"# sample_rate\t{sample_rate}",
    ]
    key = _key_signature(tonic, mode)
    if key is not None:
        lines.append(f"# key\t{key}")
    lines.append("#")
    lines.append("# position_s\tbar\tbpm\ttime_signature")
    bar = 1.0
    for i, event in enumerate(sorted(events, key=lambda e: e.time_s)):
        if i > 0:
            previous = sorted(events, key=lambda e: e.time_s)[i - 1]
            per_bar = previous.seconds_per_bar
            if per_bar > 0:
                bar += (event.time_s - previous.time_s) / per_bar
        lines.append(f"{event.time_s:.6f}\t{bar:.4f}\t{event.bpm:.4f}\t{max(1, event.beats_per_bar)}/4")
    return "\n".join(lines) + "\n"


__all__ = ["DEFAULT_BEATS_PER_BAR", "TICKS_PER_BEAT", "TempoEvent", "tempo_map_midi", "tempo_map_text"]
