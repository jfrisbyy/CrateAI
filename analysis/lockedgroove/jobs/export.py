"""``export``: render an arrangement to stems, a tempo map, a readme and its MIDI.

params::

    {
      "song": { ...the arrangement; see lockedgroove/export/song.py... },
      "format": "flac" | "wav",        default flac
      "bit_depth": 16 | 24,            default 24
      "sample_rate": 44100 | 48000,    default 44100
      "include_muted": bool,           default false
      "midi_ids": ["<uuid>", ...]      resolved under RLS by the web route
    }

writes: ``derived/{user_id}/bundles/{job_id}.zip`` (CONTRACTS section 2) and
``jobs.result`` with the zip's path, its size and what went into it. Nothing
else is written: an export is a derived artefact the caller downloads, not a
library entry, so it makes no ``files`` row and nothing re-analyses it.

**Ownership.** The song arrives as params, so every id in it is caller input
and is treated as such. The web route has already resolved each one under RLS
before the job row existed; this handler resolves them a second time with the
service role and refuses any row whose ``user_id`` is not the job's, and any
``storage_path`` outside that user's own prefix. The second check is the one
that matters: a ``files`` row is a pointer, and a pointer written by hand can
aim at another user's audio. The kit export got this wrong once by fetching
with the service role and trusting the path; nothing here trusts a path.

**Memory.** One lane is rendered at a time and written straight to disk; a
source is downloaded once and decoded per lane, then dropped. Ten lanes of a
four-minute song held at once would be 847 MB of float32.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from typing import Any, Optional

import numpy as np
import soundfile as sf

from ..db import Database
from ..export.bundle import (
    BIT_DEPTHS,
    DEFAULT_BIT_DEPTH,
    DEFAULT_FORMAT,
    DEFAULT_SAMPLE_RATE,
    EXPORT_CAP_BYTES,
    FORMATS,
    MANIFEST_NAME,
    README_NAME,
    SAMPLE_RATES,
    TEMPO_MIDI_NAME,
    TEMPO_TEXT_NAME,
    ExportPlan,
    HeldBackEntry,
    MidiEntry,
    StemEntry,
    assert_under_cap,
    cap_advice,
    estimate_bytes,
    human_bytes,
    manifest_json,
    write_zip,
)
from ..export.naming import folder_name, midi_filename, stem_filename, unique_names, zip_filename
from ..export.readme import manifest_payload, render_readme
from ..export.render import CHANNELS, as_stereo, peak_dbfs, render_track, song_samples
from ..export.song import ExportError, Region, Song, Track, exported_tracks
from ..export.tempo_map import TempoEvent, tempo_map_midi, tempo_map_text
from ..ingest import load_audio
from ..storage import Storage, content_type_for
from .common import JobContext, JobError, params_of
from .derived import owner_path_ok

log = logging.getLogger(__name__)

MAX_MIDI = 64
"""More MIDI files than this and something is wrong with the request, not the song."""


def _int_param(params: dict, key: str, allowed: tuple[int, ...], default: int) -> int:
    raw = params.get(key, default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise JobError(f"params.{key} must be one of {list(allowed)}, got {raw!r}") from None
    if value not in allowed:
        raise JobError(f"params.{key} must be one of {list(allowed)}, got {value}")
    return value


def _resolve_file(db: Database, file_id: str, user_id: str) -> dict:
    """A ``files`` row that really is the caller's, with a path really inside their prefix."""
    row = db.get_file(file_id)
    if row is None:
        raise JobError(f"the song references file {file_id}, which no longer exists")
    if user_id and row.get("user_id") != user_id:
        raise JobError(f"the song references file {file_id}, which does not belong to this user")
    path = row.get("storage_path") or ""
    if not owner_path_ok(path, user_id):
        raise JobError(f"file {file_id} points outside this user's storage prefix and was not read")
    return row


def _load_source(ctx: JobContext, row: dict, sample_rate: int, cache: dict[str, str]) -> np.ndarray:
    """The whole record as ``(2, n)`` at the export's sample rate."""
    path = row["storage_path"]
    local = cache.get(path)
    if local is None:
        local = ctx.download(path)
        cache[path] = local
    y, sr = load_audio(local)
    y = as_stereo(y)
    if int(sr) != int(sample_rate) and y.shape[-1] > 0:
        import librosa

        y = np.ascontiguousarray(
            np.asarray(librosa.resample(y, orig_sr=int(sr), target_sr=int(sample_rate)), dtype=np.float32)
        )
    return y


def _region_manifest(song: Song, region: Region) -> dict[str, Any]:
    lineage = region.lineage
    return {
        "id": region.id,
        "file_id": region.file_id,
        "start_s": round(region.start_s, 6),
        "duration_s": round(region.duration_s, 6),
        "offset_s": round(region.offset_s, 6),
        "gain": region.gain,
        "rate": region.rate,
        "start_bar": None if song.bar_at(region.start_s) is None else round(song.bar_at(region.start_s), 4),
        "end_bar": None if song.bar_at(region.end_s) is None else round(song.bar_at(region.end_s), 4),
        "source_bars": None if region.source_bars is None else {
            "from_bar": region.source_bars.from_bar, "to_bar": region.source_bars.to_bar,
            "bars": region.source_bars.bars,
        },
        "lineage_line": region.lineage_line,
        "lineage": None if lineage is None else {
            "file_name": lineage.file_name, "parent_file_id": lineage.parent_file_id, "kind": lineage.kind,
            "stem": lineage.stem, "separation_model": lineage.separation_model,
            "separation_model_label": lineage.separation_model_label,
            "take_start_s": lineage.take_start_s, "take_end_s": lineage.take_end_s,
            "downbeat_s": lineage.downbeat_s, "source_bpm": lineage.source_bpm,
            "source_beats_per_bar": lineage.source_beats_per_bar, "cents": lineage.cents,
            "stretch": lineage.stretch, "candidate_id": lineage.candidate_id, "reason": lineage.reason,
            "confidence": lineage.confidence,
        },
    }


def _plan(song: Song, tracks: list[Track], held: list[Track], fmt: str) -> ExportPlan:
    tonic = song.key.tonic if song.key else None
    mode = song.key.mode if song.key else None
    names = unique_names([stem_filename(i + 1, t.name, song.bpm, tonic, mode, fmt) for i, t in enumerate(tracks)])
    stems = [
        StemEntry(position=i + 1, track_id=t.id, name=t.name, filename=names[i], gain=t.gain,
                  muted=t.muted, soloed=t.soloed, provenance=t.provenance, source_file_ids=t.file_ids)
        for i, t in enumerate(tracks)
    ]
    # A held-back lane keeps its place in the *song*, not its place in the list
    # of things that were left out: the producer is looking for the third lane
    # down, and calling it 01 would send them to the wrong one.
    in_song = {t.id: i + 1 for i, t in enumerate(song.tracks)}
    held_back = [
        HeldBackEntry(position=in_song.get(t.id, 0), name=t.name,
                      reason="muted" if t.muted else "not soloed", provenance=t.provenance)
        for t in held
    ]
    return ExportPlan(
        folder=folder_name(song.name, song.bpm, tonic, mode),
        zip_name=zip_filename(song.name, song.bpm, tonic, mode),
        stems=stems,
        held_back=held_back,
        has_tempo_map=bool(song.bpm),
    )


def _midi_entries(db: Database, ctx: JobContext, ids: list[str], user_id: str, tracks: list[Track]
                  ) -> tuple[list[MidiEntry], list[tuple[str, str]]]:
    """The MIDI the session references, resolved, ownership-checked and downloaded."""
    lane_of: dict[str, tuple[int, str]] = {}
    for i, track in enumerate(tracks):
        for file_id in track.file_ids:
            lane_of.setdefault(file_id, (i + 1, track.name))
    entries: list[MidiEntry] = []
    files: list[tuple[str, str]] = []
    raw_names: list[str] = []
    pending: list[tuple[dict, Optional[tuple[int, str]]]] = []
    for midi_id in ids[:MAX_MIDI]:
        rows = db.select("midi", {"id": midi_id}, limit=1)
        if not rows:
            continue
        row = rows[0]
        if user_id and row.get("user_id") != user_id:
            raise JobError(f"the export references MIDI {midi_id}, which does not belong to this user")
        path = row.get("storage_path") or ""
        if not owner_path_ok(path, user_id):
            raise JobError(f"MIDI {midi_id} points outside this user's storage prefix and was not read")
        lane = lane_of.get(str(row.get("source_file_id") or ""))
        pending.append((row, lane))
        raw_names.append(midi_filename(lane[0] if lane else len(pending), lane[1] if lane else "session",
                                       str(row.get("kind") or "midi")))
    for (row, lane), name in zip(pending, unique_names(raw_names)):
        local = ctx.download(row["storage_path"])
        entry = MidiEntry(midi_id=str(row["id"]), kind=str(row.get("kind") or "midi"), filename=name,
                          storage_path=row["storage_path"], source_file_id=row.get("source_file_id"),
                          lane=lane[1] if lane else None)
        entries.append(entry)
        files.append((entry.zip_path, local))
    return entries, files


def run(job: dict, db: Database, storage: Storage, ctx: JobContext) -> dict:
    params = params_of(job)
    user_id = str(job.get("user_id") or "")
    if not user_id:
        raise JobError("an export job needs a user_id")

    try:
        song = Song.parse(params.get("song"))
    except ExportError as exc:
        raise JobError(str(exc)) from exc

    fmt = str(params.get("format", DEFAULT_FORMAT)).lower()
    if fmt not in FORMATS:
        raise JobError(f"params.format must be one of {sorted(FORMATS)}, got {fmt!r}")
    bit_depth = _int_param(params, "bit_depth", BIT_DEPTHS, DEFAULT_BIT_DEPTH)
    sample_rate = _int_param(params, "sample_rate", SAMPLE_RATES, DEFAULT_SAMPLE_RATE)
    include_muted = bool(params.get("include_muted", False))
    midi_ids = [str(x) for x in (params.get("midi_ids") or []) if isinstance(x, str)]

    tracks, held = exported_tracks(song, include_muted)
    if not tracks:
        raise JobError("every lane in the song is muted, so there is nothing to export")

    ctx.progress(0.02, "plan")
    estimated = estimate_bytes(len(tracks), song.length_s, sample_rate, CHANNELS, bit_depth, fmt)
    try:
        assert_under_cap(estimated, detail=cap_advice(fmt, bit_depth))
    except ExportError as exc:
        raise JobError(str(exc)) from exc

    plan = _plan(song, tracks, held, fmt)
    total_samples = song_samples(song, sample_rate)
    if total_samples <= 0:
        raise JobError("the song is empty")

    ctx.progress(0.05, "resolve")
    rows: dict[str, dict] = {}
    for track in tracks:
        for file_id in track.file_ids:
            if file_id not in rows:
                rows[file_id] = _resolve_file(db, file_id, user_id)

    midi_entries, midi_files = _midi_entries(db, ctx, midi_ids, user_id, tracks)
    plan.midi = midi_entries

    # --- render, one lane at a time --------------------------------------------
    subtype = FORMATS[fmt]["subtype"][bit_depth]
    container = "FLAC" if fmt == "flac" else "WAV"
    downloads: dict[str, str] = {}
    entries: list[tuple[str, str]] = []
    rendered_bytes = 0
    for i, (track, stem) in enumerate(zip(tracks, plan.stems)):
        ctx.progress(0.1 + 0.75 * (i / max(1, len(tracks))), f"render {track.name}")
        sources = {fid: _load_source(ctx, rows[fid], sample_rate, downloads) for fid in track.file_ids}
        audio = render_track(track, sources, sample_rate, total_samples, track_gain=track.gain)
        sources.clear()
        stem.peak_dbfs = peak_dbfs(audio)
        stem.clipped = bool(np.max(np.abs(audio)) > 1.0) if audio.size else False
        if stem.clipped:
            plan.notes.append(
                f"{track.name} peaks at {stem.peak_dbfs:+.1f} dBFS and is clipped in this file. "
                "Nothing here normalises or limits, so the fix is to lower the lane and export again."
            )
        local = os.path.join(ctx.workdir, stem.filename)
        sf.write(local, np.clip(audio.T, -1.0, 1.0), sample_rate, subtype=subtype, format=container)
        del audio
        rendered_bytes += os.path.getsize(local)
        try:
            assert_under_cap(rendered_bytes, detail=cap_advice(fmt, bit_depth))
        except ExportError as exc:
            raise JobError(str(exc)) from exc
        stem.regions = [_region_manifest(song, r) for r in track.regions]
        entries.append((stem.zip_path, local))
    entries.extend(midi_files)

    # --- the grid, the readme, the manifest ------------------------------------
    ctx.progress(0.88, "documents")
    generated_at = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    tonic = song.key.tonic if song.key else None
    mode = song.key.mode if song.key else None
    tempo_events: list[TempoEvent] = []
    texts: list[tuple[str, str]] = []
    if song.bpm:
        tempo_events = [TempoEvent(0.0, float(song.bpm), song.beats_per_bar)]
        midi_path = os.path.join(ctx.workdir, TEMPO_MIDI_NAME)
        with open(midi_path, "wb") as fh:
            fh.write(tempo_map_midi(tempo_events, song.length_s, name=f"{song.name} tempo map",
                                    tonic=tonic, mode=mode))
        entries.append((TEMPO_MIDI_NAME, midi_path))
        texts.append((TEMPO_TEXT_NAME, tempo_map_text(tempo_events, song.length_s, sample_rate=sample_rate,
                                                      tonic=tonic, mode=mode)))
    else:
        plan.notes.append("This session has no measured tempo, so there is no bar grid in this export "
                          "and none was invented. The stems still line up exactly at zero.")

    common = dict(generated_at=generated_at, fmt=fmt, bit_depth=bit_depth, sample_rate=sample_rate,
                  channels=CHANNELS, length_samples=total_samples, tempo_events=tempo_events)
    texts.append((MANIFEST_NAME, manifest_json(manifest_payload(song, plan, **common))))
    texts.append((README_NAME, render_readme(song, plan, include_muted=include_muted, **common)))

    # --- the zip ---------------------------------------------------------------
    ctx.progress(0.92, "zip")
    zip_local = os.path.join(ctx.workdir, plan.zip_name)
    try:
        zip_bytes = write_zip(zip_local, plan.folder, entries, texts)
    except ExportError as exc:
        raise JobError(str(exc)) from exc

    ctx.progress(0.96, "upload")
    storage_path = f"derived/{user_id}/bundles/{job['id']}.zip"
    storage.upload(storage_path, zip_local, content_type_for(storage_path))

    return {
        "storage_path": storage_path,
        "filename": plan.zip_name,
        "folder": plan.folder,
        "size_bytes": int(zip_bytes),
        "size_human": human_bytes(zip_bytes),
        "estimated_bytes": int(estimated),
        "cap_bytes": EXPORT_CAP_BYTES,
        "format": fmt,
        "bit_depth": bit_depth,
        "sample_rate": sample_rate,
        "channels": CHANNELS,
        "length_s": round(song.length_s, 6),
        "length_samples": total_samples,
        "bpm": song.bpm,
        "beats_per_bar": song.beats_per_bar,
        "key": None if song.key is None else {"tonic": song.key.tonic, "mode": song.key.mode},
        "tempo_map": plan.has_tempo_map,
        "stems": [
            {"position": s.position, "track_id": s.track_id, "name": s.name, "file": s.zip_path,
             "peak_dbfs": None if s.peak_dbfs is None or s.peak_dbfs == float("-inf") else round(s.peak_dbfs, 2),
             "clipped": s.clipped}
            for s in plan.stems
        ],
        "not_exported": [{"name": h.name, "reason": h.reason} for h in plan.held_back],
        "midi": [{"file": m.zip_path, "kind": m.kind, "midi_id": m.midi_id} for m in plan.midi],
        "notes": list(plan.notes),
    }


__all__ = ["MAX_MIDI", "run"]
