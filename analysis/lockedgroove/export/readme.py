"""README.txt: the part of the export only this product can write.

Every DAW can give a producer a folder of stems. None of them can say *what
the stems are*: which record each lane came from, which bars of it, which
separator made it, what was done to it to make it fit. That is the thing a
normal DAW throws away at import and the thing a producer opening this folder
in six months actually needs.

The per-region lineage lines are derived in the browser by
``web/lib/session/lineage.ts`` (``describeLineage``) and carried in the job's
params, because that file is the one place in the product that knows how to
say what a region is, and a second implementation in Python would be a second
truth. This module writes the document around them, and falls back to the
structured lineage fields when a line is absent so a readme is never blank.

Plain ASCII text with a hard wrap, deliberately: it opens in every editor, on
every platform, in a DAW's file browser preview, and it survives being pasted
into a note six months from now.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any, Optional

from .bundle import MANIFEST_NAME, TEMPO_MIDI_NAME, TEMPO_TEXT_NAME, ExportPlan, human_bytes
from .song import Lineage, Region, Song, Track
from .tempo_map import TempoEvent

WIDTH = 76
RULE = "-" * WIDTH


def _heading(title: str) -> list[str]:
    return ["", RULE, title.upper(), RULE, ""]


def fmt_time(seconds: Optional[float]) -> str:
    """``3:12.470``. The same clock the session's own readouts use."""
    if seconds is None or not math.isfinite(seconds):
        return "--"
    sign = "-" if seconds < 0 else ""
    total = abs(seconds)
    minutes = int(total // 60)
    return f"{sign}{minutes}:{total - minutes * 60:06.3f}"


def fmt_db(gain: float) -> str:
    """Linear gain as the number on the fader. Silence reads as -inf, not -60."""
    if gain <= 0:
        return "-inf dB"
    db = 20.0 * math.log10(gain)
    return f"{db:+.1f} dB"


def fmt_dbfs(peak: Optional[float]) -> str:
    if peak is None or peak == -math.inf:
        return "silent"
    return f"{peak:+.1f} dBFS"


def _lineage_fallback(lineage: Optional[Lineage]) -> str:
    """What a region is, from the structured fields, when the derived line is missing."""
    if lineage is None:
        return "no lineage recorded"
    parts = [p for p in (lineage.file_name, lineage.stem) if p]
    if lineage.separation_model:
        parts.append(f"separated: {lineage.separation_model}")
    if lineage.take_start_s is not None and lineage.take_end_s is not None:
        parts.append(f"{fmt_time(lineage.take_start_s)}-{fmt_time(lineage.take_end_s)}")
    return " / ".join(parts) if parts else "no lineage recorded"


def region_line(song: Song, region: Region) -> str:
    """One region: where it sits in the song, then what it is."""
    start_bar = song.bar_at(region.start_s)
    end_bar = song.bar_at(region.end_s)
    where = (f"bar {start_bar:.2f} -> {end_bar:.2f}" if start_bar is not None and end_bar is not None
             else f"{fmt_time(region.start_s)} -> {fmt_time(region.end_s)}")
    what = region.lineage_line or _lineage_fallback(region.lineage)
    return f"{where}  |  {what}"


def _source_notes(track: Track, song: Song) -> list[str]:
    """Per-lane facts about the record behind it that the one-line lineage compresses."""
    lineage = track.lineage
    if lineage is None:
        return []
    notes: list[str] = []
    if lineage.source_bpm:
        line = f"record tempo {lineage.source_bpm:.1f} BPM"
        rates = {round(r.rate, 4) for r in track.regions}
        if rates and rates != {1.0}:
            shown = ", ".join(f"x{r:.3f}" for r in sorted(rates))
            cents = ", ".join(f"{round(1200 * math.log2(r)):+d}" for r in sorted(rates) if r > 0)
            line += (f"; resampled {shown} to sit at {song.bpm:.1f} BPM"
                     if song.bpm else f"; resampled {shown}")
            line += f" (pitch moves with it, {cents} cents)"
        notes.append(line)
    if lineage.stretch and lineage.stretch != 1.0:
        notes.append(f"time-stretched to {lineage.stretch:.3f} by a render, pitch held")
    if lineage.cents:
        notes.append(f"pitched {lineage.cents:+.0f} cents by a render, time held")
    if lineage.separation_model:
        label = lineage.separation_model_label or "the separator that made this stem"
        notes.append(f"separated with {lineage.separation_model} ({label})")
    if lineage.reason:
        confidence = f", confidence {lineage.confidence:.2f}" if lineage.confidence is not None else ""
        notes.append(f"chosen because: {lineage.reason}{confidence}")
    if lineage.downbeat_s:
        notes.append(f"the record's downbeat is at {fmt_time(lineage.downbeat_s)}; its bars are counted from there")
    return notes


def render_readme(song: Song, plan: ExportPlan, *, generated_at: str, fmt: str, bit_depth: int,
                  sample_rate: int, channels: int, length_samples: int, zip_bytes: Optional[int] = None,
                  tempo_events: Sequence[TempoEvent] = (), include_muted: bool = False) -> str:
    """The document. Deterministic: the same song produces the same text."""
    tracks_by_id = {t.id: t for t in song.tracks}
    lines: list[str] = [
        f"CRATEBOX AI  -  {song.name}",
        f"Exported {generated_at}",
        "",
        f"{len(plan.stems)} stem{'s' if len(plan.stems) != 1 else ''} of one arrangement, each one rendered across",
        "the whole song and silent where its lane is not sounding.",
    ]

    lines += _heading("how to import it")
    step = 1
    if song.bpm:
        lines.append(f"{step}. Set the project tempo to {song.bpm:g} BPM, {song.beats_per_bar}/4 -- or import")
        lines.append(f"   {TEMPO_MIDI_NAME} and let your DAW take the tempo from it.")
        step += 1
    else:
        lines.append(f"{step}. This session has no measured tempo, so there is no bar grid in this")
        lines.append("   export and none was invented. The stems still line up exactly.")
        step += 1
    lines += [
        f"{step}. Drag every file in stems/ onto a track of its own.",
        f"{step + 1}. Put all of them at bar 1 / 00:00:00.000, with no snapping and no nudging.",
        f"   Every stem is exactly {length_samples} samples long at {sample_rate} Hz, so dropping",
        "   them all at zero reconstructs the session exactly.",
        f"{step + 2}. Leave the faders at unity. Lane and region gain are already in the audio;",
        "   what each lane was set to is listed below so you can undo it exactly.",
    ]

    lines += _heading("the session")
    tempo = f"{song.bpm:g} BPM, {song.beats_per_bar}/4" if song.bpm else "not measured (no bar grid in this export)"
    lines.append(f"  Tempo         {tempo}")
    if song.key:
        origin = f" (measured on {song.key.from_file_name})" if song.key.from_file_name else ""
        lines.append(f"  Key           {song.key.tonic} {song.key.mode}{origin}")
        lines.append("                Each lane's own record and key are under THE STEMS below.")
    else:
        lines.append("  Key           not measured on any lane")
    lines.append(f"  Length        {fmt_time(song.length_s)}  ({length_samples} samples at {sample_rate} Hz)")
    lines.append(f"  Stem format   {fmt.upper()}, {bit_depth}-bit, {sample_rate} Hz, "
                 f"{'stereo' if channels == 2 else f'{channels} ch'}")
    lines.append(f"  Master level  {fmt_db(song.master_gain)} -- NOT baked into the stems. It is a")
    lines.append("                monitoring level, not a mix decision, so the stems are")
    lines.append("                exactly the lanes and your master fader is yours.")
    if zip_bytes is not None:
        lines.append(f"  This zip      {human_bytes(zip_bytes)}")

    lines += _heading("what is baked in and what is not")
    lines += [
        "  Baked in:     lane gain, region gain, each region's resample rate, and the",
        "                2 ms fade the session itself puts on either end of every",
        "                region (without it a region cut mid-waveform clicks; leaving",
        "                it out would make this export cleaner than what you heard,",
        "                and therefore not what you heard).",
        "  Not baked in: the master level, and nothing else. There is no limiter, no",
        "                normalisation and no EQ anywhere in this render -- stems have",
        "                to sum linearly or they are not stems.",
    ]
    if song.solo_mode:
        soloed = ", ".join(t.name for t in song.tracks if t.soloed and not t.muted)
        lines.append(f"  Solo:         the session was in solo mode ({soloed}); only what you could")
        lines.append("                hear is here.")
    if plan.held_back:
        lines.append("")
        lines.append("  Not exported, because you could not hear them in the session:")
        for held in plan.held_back:
            extra = f"  [{held.provenance}]" if held.provenance else ""
            lines.append(f"    {held.position:02d}  {held.name}  ({held.reason}){extra}")
        lines.append("    Nothing about them is lost: unmute them and export again, or ask for")
        lines.append("    the export with muted lanes included.")
    elif include_muted:
        lines.append("  Muted lanes:  included at their own fader, because this export asked for them.")

    lines += _heading("the files")
    lines.append(f"  {'README.txt':<34}this file")
    lines.append(f"  {MANIFEST_NAME:<34}the same information as JSON, for tools")
    if plan.has_tempo_map:
        lines.append(f"  {TEMPO_MIDI_NAME:<34}the grid, as a MIDI tempo track (no notes)")
        lines.append(f"  {TEMPO_TEXT_NAME:<34}the grid, as text")
    for stem in plan.stems:
        lines.append(f"  {stem.zip_path:<34}{stem.name}")
    for midi in plan.midi:
        label = f"{midi.kind} MIDI" + (f" from {midi.lane}" if midi.lane else "")
        lines.append(f"  {midi.zip_path:<34}{label}")

    lines += _heading("the stems, and where each one came from")
    for stem in plan.stems:
        track = tracks_by_id.get(stem.track_id)
        lines.append(f"{stem.position:02d}  {stem.name}")
        lines.append(f"    file        {stem.zip_path}")
        gain_note = "unity" if abs(stem.gain - 1.0) < 1e-6 else f"{fmt_db(stem.gain)} (baked in)"
        lines.append(f"    lane gain   {gain_note}")
        lines.append(f"    peak        {fmt_dbfs(stem.peak_dbfs)}"
                     + ("   *** CLIPPED: lower this lane and export again ***" if stem.clipped else ""))
        if stem.provenance:
            lines.append(f"    record      {stem.provenance}")
        if track is not None:
            for note in _source_notes(track, song):
                lines.append(f"    {'':<11} {note}")
            lines.append(f"    regions     {len(track.regions)}")
            for region in track.regions:
                lines.append(f"      {region_line(song, region)}")
        lines.append("")

    if plan.midi:
        lines += _heading("the midi")
        lines.append("  Every MIDI the session references: pad takes, chopped patterns and")
        lines.append("  re-voiced parts, at the timing they were played or measured at.")
        for midi in plan.midi:
            lane = f" (lane {midi.lane})" if midi.lane else ""
            lines.append(f"  {midi.zip_path}{lane}: {midi.kind}")

    if plan.notes:
        lines += _heading("notes on this render")
        for note in plan.notes:
            lines.append(f"  - {note}")

    lines += _heading("provenance")
    lines += [
        "  Every second of audio in this folder came out of a file you uploaded.",
        "  Nothing here was generated from a description; the lineage above is the",
        "  receipt. Keep this file with the stems -- it is the only thing that can",
        "  tell you, six months from now, which record bar 33 of the drums is.",
        "",
    ]
    if tempo_events:
        first = tempo_events[0]
        lines.append(f"  Grid: {first.bpm:g} BPM, {first.beats_per_bar}/4, bar 1 at 0.000 s.")
        if len(tempo_events) > 1:
            lines.append(f"  {len(tempo_events)} tempo events; see {TEMPO_TEXT_NAME}.")
    return "\n".join(lines).rstrip() + "\n"


def manifest_payload(song: Song, plan: ExportPlan, *, generated_at: str, fmt: str, bit_depth: int,
                     sample_rate: int, channels: int, length_samples: int,
                     tempo_events: Sequence[TempoEvent] = ()) -> dict[str, Any]:
    """``song.json``: the readme's content as data, for anything that wants to read it."""
    return {
        "version": 1,
        "product": "Cratebox AI",
        "generated_at": generated_at,
        "song": {
            "name": song.name,
            "bpm": song.bpm,
            "beats_per_bar": song.beats_per_bar,
            "key": None if song.key is None else {
                "tonic": song.key.tonic, "mode": song.key.mode,
                "from_file_id": song.key.from_file_id, "from_file_name": song.key.from_file_name,
            },
            "length_s": round(song.length_s, 6),
            "length_samples": length_samples,
            "master_gain": song.master_gain,
            "master_gain_baked": False,
        },
        "audio": {"format": fmt, "bit_depth": bit_depth, "sample_rate": sample_rate, "channels": channels,
                  "declick_ms": 2.0, "limiter": False, "normalised": False},
        "stems": [
            {
                "position": s.position, "track_id": s.track_id, "name": s.name, "file": s.zip_path,
                "gain": s.gain, "gain_baked": True, "muted": s.muted, "soloed": s.soloed,
                "peak_dbfs": None if s.peak_dbfs in (None, -math.inf) else round(s.peak_dbfs, 2),
                "clipped": s.clipped, "provenance": s.provenance,
                "source_file_ids": s.source_file_ids, "regions": s.regions,
            }
            for s in plan.stems
        ],
        "not_exported": [
            {"position": h.position, "name": h.name, "reason": h.reason, "provenance": h.provenance}
            for h in plan.held_back
        ],
        "midi": [
            {"file": m.zip_path, "kind": m.kind, "midi_id": m.midi_id, "source_file_id": m.source_file_id,
             "lane": m.lane}
            for m in plan.midi
        ],
        "tempo_map": {
            "midi": TEMPO_MIDI_NAME if plan.has_tempo_map else None,
            "text": TEMPO_TEXT_NAME if plan.has_tempo_map else None,
            "events": [{"time_s": e.time_s, "bpm": e.bpm, "beats_per_bar": e.beats_per_bar} for e in tempo_events],
        },
        "notes": list(plan.notes),
    }


__all__ = ["RULE", "WIDTH", "fmt_db", "fmt_dbfs", "fmt_time", "manifest_payload", "region_line", "render_readme"]
