"""Sample pairs: an original record, the song that flipped it, and what the owner knows.

This is the only evaluation set that measures the thing the product is for.
Everything else in the harness scores the pipeline against annotations
(tempo, key, beats, sections); a pair asks the product's real question:

    point the loop finder at the original record -- does it surface the
    section the producer actually used?

A pair is a hand-written entry in a manifest, an audio file for the original,
and (optionally) one for the finished song. Nothing here is generated: the
manifest is written by the person who knows the flip, so every field is
optional except the original and one timestamp, and a field that is missing
removes a metric rather than failing the load (OPEN_QUESTIONS 42).

Manifest (``data/sample_pairs/pairs.json``; see
``scripts/datasets/sample_pairs.example.json`` and ``scripts/README.md``)::

    {
      "dataset": "sample_pairs",
      "audio_dir": "audio",
      "items": [
        {
          "id": "pair01",
          "original": "original.wav",
          "song": "flip.wav",
          "flip": {"from": "1:04", "to": "1:12"},
          "tempo_ratio": 1.08,
          "pitch_semitones": "+2",
          "filtered": "low-passed, drums gone",
          "notes": "four bars of the horn line, chopped on the 2"
        },
        {"id": "pair02", "original": "other.wav", "flip": "2:31"}
      ]
    }

``flip`` is the only field that carries real information for the headline
metric and it is deliberately loose: ``"1:04"``, ``"1:04-1:12"``,
``{"at": "1:04"}``, ``{"from": 64, "to": 72}``, ``[64, 72]`` and
``{"at": "1:04", "bars": 4, "source_bpm": 93}`` all parse. A bare timestamp
scores ``flip_mark`` only; a span scores the whole family.

Audio never leaves the machine: the manifest and the files live under
``data/`` (gitignored), and the harness copies only numbers -- spans, ratios,
ranks -- plus the ``id`` you chose into the shareable results document.
``title``, ``artist`` and ``notes`` stay local.
"""

from __future__ import annotations

import json
import math
import pathlib
import time
from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np

from .metrics import FLIP_RANK_DEPTH, MARK_TOLERANCE_S, Prediction, prediction_from_report

AUDIO_SUFFIXES: tuple[str, ...] = (".wav", ".flac", ".aiff", ".aif", ".mp3", ".m4a", ".ogg")

PAIR_STAGES: tuple[str, ...] = ("tempo", "beats", "onsets", "key", "structure")
"""What the original needs: the beat grid the finder anchors on, plus the two
sections the finder reads (``onsets``, ``structure``) and the key the transform
needs. Loudness, groove and spectral change nothing here and are not run."""

SONG_STAGES: tuple[str, ...] = ("tempo", "key")
"""What the finished song needs: only the two values the alignment plan reads."""

MANIFEST_NAMES: tuple[str, ...] = ("pairs.json", "sample_pairs.json", "manifest.json")

SYNTHETIC_SR = 22050


# --------------------------------------------------------------------------
# reading what a human wrote
# --------------------------------------------------------------------------

def parse_timestamp(value: Any) -> float | None:
    """Seconds from ``64``, ``"64"``, ``"64.5s"``, ``"1:04"``, ``"1:04.5"``, ``"1:02:03"``.

    Returns ``None`` for anything that is not a time, so a typo drops one
    field instead of failing the pair.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    text = str(value).strip().lower().rstrip("s").strip()
    if not text:
        return None
    parts = text.split(":")
    if len(parts) > 3:
        return None
    total = 0.0
    try:
        for part in parts:
            total = total * 60.0 + float(part)
    except ValueError:
        return None
    return total if math.isfinite(total) else None


_RANGE_SEPARATORS = ("--", "–", "—", " to ", "..", "-")


def _split_range(text: str) -> tuple[str, str] | None:
    """``"1:04-1:12"`` -> ``("1:04", "1:12")``; ``None`` when it is a single time."""
    for sep in _RANGE_SEPARATORS:
        if sep in text:
            left, _, right = text.partition(sep)
            if left.strip() and right.strip():
                return left.strip(), right.strip()
    return None


def parse_flip(value: Any, source_bpm: float | None = None,
               beats_per_bar: int = 4) -> tuple[tuple[float, float] | None, float | None, list[str]]:
    """``(span, mark, notes)`` from whatever shape the owner wrote the section in.

    Accepts a number, ``"1:04"``, ``"1:04-1:12"``, ``[64, 72]`` and a mapping
    with ``from``/``to``, ``start``/``end``, ``at``, ``length_s`` or ``bars``.
    ``bars`` builds a span only together with a ``source_bpm`` the owner
    supplied: deriving the span from *our* tempo estimate would let a tempo
    error move the ground truth.
    """
    notes: list[str] = []
    if value is None:
        return None, None, notes
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return None, parse_timestamp(value), notes
    if isinstance(value, str):
        rng = _split_range(value.strip())
        if rng:
            a, b = parse_timestamp(rng[0]), parse_timestamp(rng[1])
            if a is not None and b is not None and b > a:
                return (a, b), a, notes
            notes.append("flip range unreadable")
            return None, None, notes
        mark = parse_timestamp(value)
        if mark is None:
            notes.append("flip timestamp unreadable")
        return None, mark, notes
    if isinstance(value, Sequence) and len(value) == 2:
        a, b = parse_timestamp(value[0]), parse_timestamp(value[1])
        if a is not None and b is not None and b > a:
            return (a, b), a, notes
        notes.append("flip span unreadable")
        return None, None, notes
    if not isinstance(value, Mapping):
        notes.append("flip unreadable")
        return None, None, notes

    start = next((parse_timestamp(value.get(k)) for k in ("from", "start", "start_s", "at", "time")
                  if value.get(k) is not None), None)
    end = next((parse_timestamp(value.get(k)) for k in ("to", "end", "end_s", "until")
                if value.get(k) is not None), None)
    if start is None and end is None:
        notes.append("flip has no timestamp")
        return None, None, notes
    if end is None and start is not None:
        length = parse_timestamp(value.get("length_s") or value.get("length") or value.get("duration_s"))
        if length is None:
            bars = value.get("bars")
            bpm = value.get("source_bpm") or value.get("bpm") or source_bpm
            if bars and bpm:
                try:
                    length = float(bars) * beats_per_bar * 60.0 / float(bpm)
                except (TypeError, ValueError, ZeroDivisionError):
                    length = None
            elif bars:
                notes.append("bars given without a source_bpm: recorded, but no span derived")
        if length is not None and length > 0:
            end = start + length
    if start is not None and end is not None and end > start:
        return (start, end), start, notes
    if start is not None and end is not None:
        notes.append("flip ends before it starts")
    return None, start, notes


def parse_number(value: Any) -> float | None:
    """A float from ``2``, ``"+2"``, ``"2 st"``, ``"x1.08"``, ``"108%"``; else ``None``."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    text = str(value).strip().lower()
    percent = text.endswith("%")
    for junk in ("%", "st", "semitones", "semitone", "semis", "×", "x", "bpm", "up", "down", "+"):
        text = text.replace(junk, " ")
    text = text.strip()
    if text.startswith("-"):
        sign, text = -1.0, text[1:].strip()
    else:
        sign = 1.0
    try:
        out = sign * float(text)
    except ValueError:
        return None
    if not math.isfinite(out):
        return None
    if percent:
        out /= 100.0
    if str(value).strip().lower().startswith("down"):
        out = -abs(out)
    return out


def pair_truth(entry: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Ground truth for one manifest entry, plus notes about what could not be read.

    The notes reach the shared results document, so they name the field that
    could not be read and never quote what was written in it.

    Every field is optional. What is present decides which metrics apply:

    ====================================  ====================================
    the entry carries                     it scores
    ====================================  ====================================
    a flip span                           flip_top1, flip_topk, flip_mrr, flip_mark
    only a flip timestamp                 flip_mark
    a tempo ratio (or both BPMs)          tempo_ratio
    a pitch shift                         pitch_shift
    the record's own BPM / key            bpm_exact, bpm_octave, key_exact, key_relative
    ====================================  ====================================
    """
    notes: list[str] = []
    truth: dict[str, Any] = {"kind": "sample_pair"}

    original_bpm = parse_number(entry.get("original_bpm") or entry.get("record_bpm"))
    song_bpm = parse_number(entry.get("song_bpm") or entry.get("flip_bpm"))

    flip_value = next((entry[k] for k in ("flip", "section", "used", "span", "at")
                       if entry.get(k) is not None), None)
    span, mark, flip_notes = parse_flip(flip_value, source_bpm=original_bpm)
    notes += flip_notes
    if span is not None:
        truth["flip_span_s"] = [span[0], span[1]]
    if mark is not None:
        truth["flip_mark_s"] = mark

    tolerance = parse_number(entry.get("tolerance_s") or entry.get("tolerance"))
    truth["mark_tolerance_s"] = float(tolerance) if tolerance and tolerance > 0 else MARK_TOLERANCE_S

    ratio = parse_number(entry.get("tempo_ratio") or entry.get("stretch") or entry.get("stretch_ratio"))
    if ratio is None and original_bpm and song_bpm:
        ratio = song_bpm / original_bpm
    if ratio is not None and ratio <= 0:
        notes.append("tempo_ratio is not positive")
        ratio = None
    if ratio is not None:
        truth["tempo_ratio"] = float(ratio)

    pitch = parse_number(entry.get("pitch_semitones") or entry.get("pitch") or entry.get("semitones"))
    cents = parse_number(entry.get("pitch_cents") or entry.get("cents"))
    if pitch is None and cents is not None:
        pitch = cents / 100.0
    if pitch is not None:
        truth["pitch_semitones"] = float(pitch)

    # the owner's own knowledge of the record is annotation like any other
    if original_bpm:
        truth["bpm"] = float(original_bpm)
    key = entry.get("original_key") or entry.get("record_key") or entry.get("key")
    if key is not None:
        from .metrics import key_tuple

        parsed = key_tuple(key)
        if parsed:
            truth["key"] = {"tonic": parsed[0], "mode": parsed[1]}
        else:
            notes.append("key unreadable")
    return truth, notes


def scorable(truth: Mapping[str, Any]) -> bool:
    """True when something in this truth can actually be scored."""
    return any(truth.get(f) is not None for f in
               ("flip_span_s", "flip_mark_s", "tempo_ratio", "pitch_semitones", "bpm", "key"))


# --------------------------------------------------------------------------
# finding the files
# --------------------------------------------------------------------------

def resolve_audio(name: Any, *dirs: pathlib.Path) -> pathlib.Path | None:
    """A file named in the manifest, looked for in each directory, with or without a suffix."""
    if not name:
        return None
    raw = str(name).strip()
    if not raw:
        return None
    p = pathlib.Path(raw).expanduser()
    if p.is_absolute():
        return p if p.is_file() else None
    candidates: list[pathlib.Path] = []
    for d in dirs:
        candidates.append(d / p)
        if not p.suffix:
            candidates += [d / f"{raw}{suffix}" for suffix in AUDIO_SUFFIXES]
    for c in candidates:
        if c.is_file():
            return c
    return None


def find_manifest(dataset_dir: pathlib.Path, repo_scripts: pathlib.Path | None = None) -> pathlib.Path | None:
    """Beside the audio first, then in the repo's ``scripts/datasets/`` (never the example)."""
    for name in MANIFEST_NAMES:
        p = dataset_dir / name
        if p.is_file():
            return p
    if repo_scripts is not None:
        p = repo_scripts / "datasets" / "sample_pairs.json"
        if p.is_file():
            return p
    return None


# --------------------------------------------------------------------------
# measuring: the loop finder on the original, the transform against the song
# --------------------------------------------------------------------------

def transform_from_predictions(original: Prediction, song: Prediction
                               ) -> tuple[float | None, float | None, dict[str, Any]]:
    """What ``combine.align.plan_alignment`` would do to sit the original in the song.

    The plan is taken from the same function the product uses, with the song as
    the target, so this metric measures the shipped alignment rather than a
    second implementation of it.
    """
    from ..combine.align import AlignItem, plan_alignment

    detail: dict[str, Any] = {
        "original_bpm": original.bpm, "song_bpm": song.bpm,
        "original_key": " ".join(original.key) if original.key else None,
        "song_key": " ".join(song.key) if song.key else None,
        "method": "combine.align.plan_alignment, song as target",
    }
    items = [
        AlignItem("song", bpm=song.bpm, tonic=song.key[0] if song.key else None,
                  mode=song.key[1] if song.key else None),
        AlignItem("original", bpm=original.bpm, tonic=original.key[0] if original.key else None,
                  mode=original.key[1] if original.key else None),
    ]
    plan = plan_alignment(items)
    item_plan = plan.items[1]
    ratio = float(item_plan.stretch_ratio) if (original.bpm and song.bpm) else None
    shift = float(item_plan.pitch_semitones) if (original.key and song.key) else None
    return ratio, shift, detail


def measure_pair(pred: Prediction, truth: Mapping[str, Any], y: np.ndarray, sr: int, report: Any,
                 top_k: int = FLIP_RANK_DEPTH) -> dict[str, float]:
    """Add the pair measurements to ``pred``; return stage timings. Never raises.

    ``loops`` are the finder's ranked candidate spans on the original record.
    ``tempo_ratio`` / ``pitch_semitones`` come from analysing the finished song
    and asking the alignment what it would do; both are skipped silently when
    the pair has no song file, and a failure lands in ``pred.errors`` so the
    metric misses with a reason instead of the run dying.
    """
    timings: dict[str, float] = {}
    t0 = time.perf_counter()
    try:
        from ..loops.finder import find_loops

        candidates = find_loops(y, sr, report, top_k=top_k)
        pred.loops = [(float(c.start_s), float(c.end_s)) for c in candidates]
        if not pred.loops:
            pred.errors.setdefault("loops", "the finder returned no candidates")
    except Exception as exc:
        pred.errors["loops"] = f"{type(exc).__name__}: {exc}"
    timings["loops"] = time.perf_counter() - t0

    song_path = truth.get("song_path")
    needs_transform = truth.get("tempo_ratio") is not None or truth.get("pitch_semitones") is not None
    if not needs_transform:
        return timings
    if not song_path:
        pred.errors.setdefault("transform", "no song file for this pair")
        return timings
    t0 = time.perf_counter()
    try:
        from ..ingest import load_audio
        from ..pipeline import analyze_array
        from ..report import effective

        sy, ssr = load_audio(str(song_path), mono=False)
        song_report, ctx = analyze_array(sy, ssr, stages=list(SONG_STAGES), return_context=True)
        song_pred = prediction_from_report(effective(song_report), ctx.errors)
        ratio, shift, detail = transform_from_predictions(pred, song_pred)
        pred.tempo_ratio, pred.pitch_semitones, pred.transform = ratio, shift, detail
        missing = [name for name, value in (("tempo", ratio), ("key", shift)) if value is None]
        if missing:
            pred.errors.setdefault("transform", f"the song has no {' or '.join(missing)}")
    except Exception as exc:
        pred.errors["transform"] = f"{type(exc).__name__}: {exc}"
    timings["song"] = time.perf_counter() - t0
    return timings


# --------------------------------------------------------------------------
# a synthetic pair, so the whole path runs before any real audio arrives
# --------------------------------------------------------------------------

def _speed_change(y: np.ndarray, sr: int, ratio: float) -> np.ndarray:
    """Play ``y`` ``ratio`` times faster, the way a sampler or a turntable does.

    Resampling moves tempo and pitch together, which is the flip this pair
    describes: the truth's tempo ratio and pitch shift are then two views of
    one operation rather than two independent claims.
    """
    from ..pipeline import resample

    out = resample(np.asarray(y, dtype=np.float32), sr, int(round(sr / ratio)))
    return np.asarray(out, dtype=np.float32)


def synthetic_pair(pair_id: str = "synthetic_01", sr: int = SYNTHETIC_SR, bpm: float = 96.0,
                   semitones: int = 2, section_bars: int = 4, sections: str = "ABAB",
                   used_section: int = 1, repeats: int = 2, seed: int = 0,
                   with_song: bool = True) -> dict[str, Any]:
    """An "original record" and a "song" that flipped a known section of it.

    The original is a loop-based track; the flip is one of its sections sped up
    by ``2 ** (semitones / 12)`` -- so the tempo ratio and the pitch shift are
    exact by construction -- looped, with different drums over it. Returns
    ``{"id", "original": (y, sr), "song": (y, sr) | None, "entry": {...}}``
    where ``entry`` is a manifest entry with the truth filled in.
    """
    from ..testing import synth as S

    y, truth = S.loop_based_track(bpm=bpm, sr=sr, loop_bars=min(4, section_bars), sections=sections,
                                  section_bars=section_bars, with_drums=True, seed=seed)
    bar_s = 4 * 60.0 / bpm
    start_s = used_section * section_bars * bar_s
    end_s = start_s + section_bars * bar_s
    entry: dict[str, Any] = {
        "id": pair_id,
        "original": f"{pair_id}_original.wav",
        "flip": {"from": round(start_s, 3), "to": round(end_s, 3)},
        "original_bpm": bpm,
        "notes": (f"synthetic: section {sections[used_section]} of a {sections} track, "
                  f"bars {used_section * section_bars}-{(used_section + 1) * section_bars}"),
    }
    song: tuple[np.ndarray, int] | None = None
    if with_song:
        ratio = float(2.0 ** (semitones / 12.0))
        section = S.crop(y, start_s, end_s, sr)
        sped = _speed_change(section, sr, ratio)
        looped = np.concatenate([sped] * max(1, repeats))
        song_bpm = bpm * ratio
        bars = max(1, int(round(len(looped) / sr / (4 * 60.0 / song_bpm))))
        drums = S.drum_loop(song_bpm, bars, S.Pattern.four_on_floor(), sr, seed=seed + 7)[: len(looped)]
        if len(drums) < len(looped):
            drums = np.pad(drums, (0, len(looped) - len(drums)))
        song = (S.normalize(S.mix(looped, drums, gains=[0.85, 0.75]), 0.9), sr)
        entry["song"] = f"{pair_id}_song.wav"
        entry["tempo_ratio"] = round(ratio, 4)
        entry["pitch_semitones"] = int(semitones)
        entry["song_bpm"] = round(song_bpm, 3)
        entry["filtered"] = "nothing removed; the whole section, sped up"
    entry["original_key"] = f"{truth['key']['tonic']} {truth['key']['mode']}"
    return {"id": pair_id, "original": (y, sr), "song": song, "entry": entry}


def synthetic_pair_set(sr: int = SYNTHETIC_SR, small: bool = False) -> list[dict[str, Any]]:
    """Two pairs: one fully documented, one with nothing but a timestamp.

    The second is the point: a pair whose owner only remembers "it's somewhere
    around here" must still load and still score ``flip_mark``. ``small``
    halves the records to two sections, for the tests.
    """
    full = synthetic_pair("synthetic_01", sr=sr, bpm=96.0, semitones=2, section_bars=4,
                          sections="AB" if small else "ABAB", used_section=1, seed=0)
    sparse = synthetic_pair("synthetic_02", sr=sr, bpm=84.0, section_bars=4,
                            sections="AB" if small else "ABCB", used_section=1, seed=3, with_song=False)
    mark = sparse["entry"]["flip"]["from"]
    minutes, seconds = divmod(float(mark), 60.0)
    sparse["entry"]["flip"] = f"{int(minutes)}:{seconds:04.1f}"
    sparse["entry"].pop("original_bpm", None)
    sparse["entry"].pop("original_key", None)
    sparse["entry"]["tolerance_s"] = 2.0
    sparse["entry"]["notes"] = "synthetic: a pair with only a rough timestamp, and no finished song"
    return [full, sparse]


def write_synthetic_pair_set(out_dir: pathlib.Path, sr: int = SYNTHETIC_SR,
                             small: bool = False) -> pathlib.Path:
    """Render the synthetic pairs into ``out_dir`` and write the manifest; return its path."""
    import soundfile as sf

    out_dir = pathlib.Path(out_dir)
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for pair in synthetic_pair_set(sr=sr, small=small):
        entry = pair["entry"]
        sf.write(str(audio_dir / entry["original"]), np.asarray(pair["original"][0]), sr)
        if pair["song"] is not None:
            sf.write(str(audio_dir / entry["song"]), np.asarray(pair["song"][0]), sr)
        entries.append(entry)
    manifest = {
        "dataset": "sample_pairs",
        "note": ("Synthetic pairs from lockedgroove.eval.pairs.synthetic_pair_set: an original "
                 "record and a song that sped one of its sections up. They prove the path runs; "
                 "they say nothing about accuracy on real records."),
        "audio_dir": "audio",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "items": entries,
    }
    path = out_dir / "pairs.json"
    path.write_text(json.dumps(manifest, indent=1) + "\n")
    return path


__all__ = [
    "AUDIO_SUFFIXES", "MANIFEST_NAMES", "PAIR_STAGES", "SONG_STAGES", "SYNTHETIC_SR",
    "find_manifest", "measure_pair", "pair_truth", "parse_flip", "parse_number", "parse_timestamp",
    "resolve_audio", "scorable", "synthetic_pair", "synthetic_pair_set",
    "transform_from_predictions", "write_synthetic_pair_set",
]
