"""Exporting a song: stems, a tempo map, a readme, and the MIDI behind them.

A producer can get a zip of chops and MIDI out of a single file today. They
cannot get a *song* out, and everything they arrange on the timeline is
trapped in the app. This package is the way out: it turns an arrangement into
the one thing every DAW reads — per-lane stems at one length, a grid, and a
document saying what the stems are.

Pure and layered, so all of it is asserted in pytest without storage, a
database, a GPU or a browser:

* ``song``      the arrangement as it arrives, validated into dataclasses
* ``render``    one lane across the whole song, sample-aligned
* ``tempo_map`` the grid as a MIDI tempo track and as text
* ``naming``    what the files are called
* ``readme``    what the producer reads, and ``song.json`` beside it
* ``bundle``    the zip's layout, its size cap, and writing it

``lockedgroove.jobs.export`` is the only part that touches storage.
"""

from .bundle import EXPORT_CAP_BYTES, ExportPlan, ExportTooLargeError, estimate_bytes
from .render import render_track, song_samples
from .song import ExportError, Song, exported_tracks
from .tempo_map import TempoEvent, tempo_map_midi, tempo_map_text

__all__ = ["EXPORT_CAP_BYTES", "ExportError", "ExportPlan", "ExportTooLargeError", "Song", "TempoEvent",
           "estimate_bytes", "exported_tracks", "render_track", "song_samples", "tempo_map_midi",
           "tempo_map_text"]
