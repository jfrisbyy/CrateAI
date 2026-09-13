"""MIDI from the user's audio (BUILD_PACKET section 8).

- drums: measured hits (time, class, velocity) become notes AT THE MEASURED
  TIME; the quantized step and the offset in ms ride along in ``notes`` so the
  feel survives and the step view can show it.
- melody: Basic Pitch on a stem (lazy import; not installed everywhere).
- chords: chord segments become block chords.
- groove: a 16th-step offset template derived from the hits.

Every function returns a ``pretty_midi.PrettyMIDI`` plus a JSON-able notes
list (the ``midi.notes`` column) so the piano roll can edit it.
"""

from __future__ import annotations

import io
import json
import zipfile
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np
import pretty_midi

GM_DRUMS = {"kick": 36, "snare": 38, "hat": 42, "open_hat": 46, "other": 39, "clap": 39, "rim": 37, "tom": 45}
DEFAULT_VELOCITY = 100

CHORD_QUALITY = {
    "maj": [0, 4, 7], "min": [0, 3, 7], "dim": [0, 3, 6], "aug": [0, 4, 8],
    "maj7": [0, 4, 7, 11], "min7": [0, 3, 7, 10], "7": [0, 4, 7, 10], "sus2": [0, 2, 7], "sus4": [0, 5, 7],
}
PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLATS = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


@dataclass
class Hit:
    time_s: float
    cls: str
    velocity: float = 1.0  # 0..1


@dataclass
class Grid:
    """Beat grid needed to quantize: beat times in seconds and beats per bar."""

    beats_s: list[float]
    beats_per_bar: int = 4

    @property
    def bpm(self) -> float:
        if len(self.beats_s) < 2:
            return 120.0
        return 60.0 / float(np.median(np.diff(self.beats_s)))

    def sixteenths(self) -> np.ndarray:
        b = np.asarray(self.beats_s, dtype=float)
        if len(b) < 2:
            return b
        step = np.diff(b) / 4.0
        grid = np.concatenate([b[i] + step[i] * np.arange(4) for i in range(len(b) - 1)] + [b[-1:]])
        return grid

    def quantize(self, t: float) -> tuple[int, int, int, float]:
        """-> (bar, step_in_bar 0..15, global_step, offset_ms) for time ``t``."""
        grid = self.sixteenths()
        if len(grid) == 0:
            return 0, 0, 0, 0.0
        i = int(np.argmin(np.abs(grid - t)))
        offset_ms = float((t - grid[i]) * 1000.0)
        steps_per_bar = self.beats_per_bar * 4
        return i // steps_per_bar, i % steps_per_bar, i, offset_ms

    @classmethod
    def free(cls, bpm: float, bars: int = 8, beats_per_bar: int = 4, start_s: float = 0.0) -> "Grid":
        beat = 60.0 / bpm
        return cls(beats_s=[start_s + i * beat for i in range(bars * beats_per_bar + 1)], beats_per_bar=beats_per_bar)


@dataclass
class NoteEvent:
    pitch: int
    start_s: float
    end_s: float
    velocity: int
    cls: Optional[str] = None
    bar: Optional[int] = None
    step: Optional[int] = None
    offset_ms: Optional[float] = None

    def to_json(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class MidiResult:
    midi: pretty_midi.PrettyMIDI
    notes: list[NoteEvent]
    kind: str
    meta: dict[str, Any] = field(default_factory=dict)

    def to_bytes(self) -> bytes:
        buf = io.BytesIO()
        self.midi.write(buf)
        return buf.getvalue()

    def notes_json(self) -> list[dict[str, Any]]:
        return [n.to_json() for n in self.notes]


def _pm(bpm: float) -> pretty_midi.PrettyMIDI:
    return pretty_midi.PrettyMIDI(initial_tempo=float(bpm))


def drum_midi(hits: list[Hit], grid: Grid, note_length_s: float = 0.1, quantize: bool = False) -> MidiResult:
    """Drum hits to a GM drum track. Measured timing is preserved unless ``quantize``."""
    pm = _pm(grid.bpm)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="drums")
    notes: list[NoteEvent] = []
    grid16 = grid.sixteenths()
    for h in sorted(hits, key=lambda x: x.time_s):
        bar, step, gstep, offset_ms = grid.quantize(h.time_s)
        start = float(grid16[gstep]) if (quantize and len(grid16)) else float(h.time_s)
        vel = int(np.clip(round(h.velocity * 127), 1, 127))
        pitch = GM_DRUMS.get(h.cls, GM_DRUMS["other"])
        inst.notes.append(pretty_midi.Note(velocity=vel, pitch=pitch, start=start, end=start + note_length_s))
        notes.append(NoteEvent(pitch=pitch, start_s=start, end_s=start + note_length_s, velocity=vel, cls=h.cls,
                               bar=bar, step=step, offset_ms=0.0 if quantize else offset_ms))
    pm.instruments.append(inst)
    return MidiResult(midi=pm, notes=notes, kind="drums", meta={"bpm": grid.bpm, "quantized": quantize})


def chord_label_to_pitches(label: str, octave: int = 4) -> list[int]:
    """'F:min' / 'F:maj' / 'Fm' / 'F' / 'Bb:maj7' -> MIDI pitches. 'N' -> []."""
    if not label or label == "N":
        return []
    if ":" in label:
        root, quality = label.split(":", 1)
    elif label.endswith("m") and len(label) > 1 and label[:-1] in PITCH + list(FLATS):
        root, quality = label[:-1], "min"
    else:
        root, quality = label, "maj"
    root = FLATS.get(root, root)
    if root not in PITCH:
        return []
    intervals = CHORD_QUALITY.get(quality, CHORD_QUALITY["maj"])
    base = 12 * (octave + 1) + PITCH.index(root)
    return [base + i for i in intervals]


def chords_midi(segments: list[dict[str, Any]], bpm: float, octave: int = 4) -> MidiResult:
    """Chord segments ({start_s, end_s, label, confidence}) become block chords."""
    pm = _pm(bpm)
    inst = pretty_midi.Instrument(program=4, name="chords")  # electric piano
    notes: list[NoteEvent] = []
    for seg in segments:
        for p in chord_label_to_pitches(seg["label"], octave):
            n = pretty_midi.Note(velocity=DEFAULT_VELOCITY, pitch=p, start=float(seg["start_s"]), end=float(seg["end_s"]))
            inst.notes.append(n)
            notes.append(NoteEvent(pitch=p, start_s=n.start, end_s=n.end, velocity=n.velocity, cls=seg["label"]))
    pm.instruments.append(inst)
    return MidiResult(midi=pm, notes=notes, kind="chords", meta={"bpm": bpm})


def melody_midi(y: np.ndarray, sr: int, bpm: float, onset_threshold: float = 0.5, frame_threshold: float = 0.3,
                min_note_len_ms: float = 58.0) -> MidiResult:
    """Melody via Basic Pitch on an isolated stem. Raises ImportError when basic-pitch isn't installed."""
    from basic_pitch import ICASSP_2022_MODEL_PATH  # type: ignore
    from basic_pitch.inference import predict  # type: ignore

    mono = np.asarray(y, dtype=np.float32)
    if mono.ndim == 2:
        mono = mono.mean(axis=0)
    _, midi_data, note_events = predict((mono, sr) if False else mono, ICASSP_2022_MODEL_PATH,  # noqa: F841
                                        onset_threshold=onset_threshold, frame_threshold=frame_threshold,
                                        minimum_note_length=min_note_len_ms) if False else _basic_pitch_on_array(
        mono, sr, onset_threshold, frame_threshold, min_note_len_ms)
    notes = [NoteEvent(pitch=int(n[2]), start_s=float(n[0]), end_s=float(n[1]), velocity=int(np.clip(round(n[3] * 127), 1, 127)))
             for n in note_events]
    midi_data = _pm(bpm)
    inst = pretty_midi.Instrument(program=0, name="melody")
    for n in notes:
        inst.notes.append(pretty_midi.Note(velocity=n.velocity, pitch=n.pitch, start=n.start_s, end=n.end_s))
    midi_data.instruments.append(inst)
    return MidiResult(midi=midi_data, notes=notes, kind="melody", meta={"bpm": bpm, "model": "basic-pitch"})


def _basic_pitch_on_array(mono: np.ndarray, sr: int, onset_threshold: float, frame_threshold: float,
                          min_note_len_ms: float):
    """Basic Pitch wants a path; write a temp WAV and run it."""
    import os
    import tempfile

    import soundfile as sf
    from basic_pitch import ICASSP_2022_MODEL_PATH  # type: ignore
    from basic_pitch.inference import predict  # type: ignore

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        sf.write(path, mono, sr)
        model_output, midi_data, note_events = predict(path, ICASSP_2022_MODEL_PATH, onset_threshold=onset_threshold,
                                                       frame_threshold=frame_threshold,
                                                       minimum_note_length=min_note_len_ms)
    finally:
        os.unlink(path)
    return model_output, midi_data, note_events


def groove_template(hits: list[Hit], grid: Grid) -> dict[str, Any]:
    """Per-16th-step mean offset (ms) and velocity, the shape a DAW groove file carries."""
    steps_per_bar = grid.beats_per_bar * 4
    offsets: dict[int, list[float]] = {s: [] for s in range(steps_per_bar)}
    vels: dict[int, list[float]] = {s: [] for s in range(steps_per_bar)}
    for h in hits:
        _, step, _, off = grid.quantize(h.time_s)
        offsets[step].append(off)
        vels[step].append(h.velocity)
    template = [{"step": s, "offset_ms": float(np.mean(offsets[s])) if offsets[s] else 0.0,
                 "velocity": float(np.mean(vels[s])) if vels[s] else 0.0, "count": len(offsets[s])}
                for s in range(steps_per_bar)]
    off_8ths = [t["offset_ms"] for t in template if t["step"] % 4 == 2 and t["count"]]
    beat_ms = 60000.0 / grid.bpm
    swing_pct = 50.0 + (float(np.mean(off_8ths)) / beat_ms * 100.0 if off_8ths else 0.0)
    return {"bpm": grid.bpm, "steps_per_bar": steps_per_bar, "steps": template, "swing_pct": swing_pct}


def groove_midi(template: dict[str, Any], bars: int = 1) -> MidiResult:
    """A groove template as a MIDI clip of hi-hat ticks carrying the offsets (importable as a DAW groove)."""
    bpm = float(template["bpm"])
    pm = _pm(bpm)
    inst = pretty_midi.Instrument(program=0, is_drum=True, name="groove")
    step_s = 60.0 / bpm / 4.0
    notes: list[NoteEvent] = []
    for bar in range(bars):
        for t in template["steps"]:
            start = bar * template["steps_per_bar"] * step_s + t["step"] * step_s + t["offset_ms"] / 1000.0
            vel = int(np.clip(round(max(t["velocity"], 0.3) * 127), 1, 127))
            inst.notes.append(pretty_midi.Note(velocity=vel, pitch=GM_DRUMS["hat"], start=start, end=start + 0.05))
            notes.append(NoteEvent(pitch=GM_DRUMS["hat"], start_s=start, end_s=start + 0.05, velocity=vel, bar=bar,
                                   step=t["step"], offset_ms=t["offset_ms"]))
    pm.instruments.append(inst)
    return MidiResult(midi=pm, notes=notes, kind="groove", meta={"bpm": bpm})


def apply_groove(result: MidiResult, template: dict[str, Any], grid: Grid, strength: float = 1.0) -> MidiResult:
    """Move each note by the template offset of its step (used when re-voicing keeps the source feel)."""
    step_off = {t["step"]: t["offset_ms"] for t in template["steps"]}
    grid16 = grid.sixteenths()
    for inst in result.midi.instruments:
        for note in inst.notes:
            _, step, gstep, _ = grid.quantize(note.start)
            base = float(grid16[gstep]) if len(grid16) else note.start
            dur = note.end - note.start
            note.start = base + step_off.get(step, 0.0) / 1000.0 * strength
            note.end = note.start + dur
    for n in result.notes:
        _, step, gstep, _ = grid.quantize(n.start_s)
        base = float(grid16[gstep]) if len(grid16) else n.start_s
        dur = n.end_s - n.start_s
        n.start_s = base + step_off.get(step, 0.0) / 1000.0 * strength
        n.end_s = n.start_s + dur
        n.offset_ms = step_off.get(step, 0.0) * strength
    return result


def bundle_zip(files: dict[str, bytes], manifest: dict[str, Any]) -> bytes:
    """WAVs + .mid + manifest.json zipped (the export bundle)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
    return buf.getvalue()


__all__ = ["GM_DRUMS", "Grid", "Hit", "MidiResult", "NoteEvent", "apply_groove", "bundle_zip", "chord_label_to_pitches",
           "chords_midi", "drum_midi", "groove_midi", "groove_template", "melody_midi"]
