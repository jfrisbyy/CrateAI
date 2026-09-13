"""Symbolic re-voice: transcribe to MIDI, render through a sampled instrument.

1. Isolate the source part (a stem or a chop): the caller passes that audio.
2. Extract MIDI with Basic Pitch (``chops.midi.melody_midi``). The MIDI is the
   editable object and is returned first.
3. Render the MIDI with FluidSynth through a General MIDI soundfont, or with
   the built-in additive renderer when FluidSynth isn't available (preview
   quality, labeled as such in the result).
4. Optionally apply the source's measured groove offsets.

Accuracy note for the chat: the symbolic path is only as good as the
transcription. Polyphonic sources have wrong or missing notes; the MIDI is
shown so the user fixes them and re-render is one click.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np
import pretty_midi

from ..chops.midi import Grid, MidiResult, NoteEvent, apply_groove

INSTRUMENTS: dict[str, dict[str, Any]] = {
    "upright_piano": {"program": 0, "label": "Upright piano"},
    "rhodes": {"program": 4, "label": "Rhodes electric piano"},
    "wurlitzer": {"program": 5, "label": "Wurlitzer"},
    "organ": {"program": 16, "label": "Drawbar organ"},
    "acoustic_guitar": {"program": 25, "label": "Acoustic guitar (steel)"},
    "nylon_guitar": {"program": 24, "label": "Acoustic guitar (nylon)"},
    "electric_guitar": {"program": 27, "label": "Electric guitar (clean)"},
    "upright_bass": {"program": 32, "label": "Upright bass"},
    "electric_bass": {"program": 33, "label": "Electric bass (finger)"},
    "strings": {"program": 48, "label": "String ensemble"},
    "brass": {"program": 61, "label": "Brass section"},
    "trumpet": {"program": 56, "label": "Trumpet"},
    "saxophone": {"program": 66, "label": "Tenor sax"},
    "flute": {"program": 73, "label": "Flute"},
    "vibraphone": {"program": 11, "label": "Vibraphone"},
    "synth_lead": {"program": 80, "label": "Synth lead (square)"},
    "synth_pad": {"program": 89, "label": "Synth pad (warm)"},
    "choir": {"program": 52, "label": "Choir aahs"},
}
DEFAULT_SOUNDFONT_ENV = "LOCKEDGROOVE_SOUNDFONT"
DEFAULT_SOUNDFONT_CANDIDATES = [
    "/usr/share/sounds/sf2/FluidR3_GM.sf2",
    "/usr/share/soundfonts/FluidR3_GM.sf2",
    "/usr/share/sounds/sf2/default-GM.sf2",
]


@dataclass
class RevoiceResult:
    midi: MidiResult
    audio: np.ndarray  # (channels, n)
    sr: int
    instrument: str
    renderer: str
    notes: list[str] = field(default_factory=list)


def find_soundfont() -> Optional[str]:
    env = os.environ.get(DEFAULT_SOUNDFONT_ENV)
    if env and os.path.exists(env):
        return env
    for c in DEFAULT_SOUNDFONT_CANDIDATES:
        if os.path.exists(c):
            return c
    return None


def midi_for_instrument(result: MidiResult, instrument: str) -> pretty_midi.PrettyMIDI:
    if instrument not in INSTRUMENTS:
        raise ValueError(f"unknown instrument {instrument!r}; choose one of {sorted(INSTRUMENTS)}")
    pm = pretty_midi.PrettyMIDI(initial_tempo=float(result.meta.get("bpm", 120.0)))
    inst = pretty_midi.Instrument(program=INSTRUMENTS[instrument]["program"], name=instrument)
    for n in result.notes:
        inst.notes.append(pretty_midi.Note(velocity=n.velocity, pitch=n.pitch, start=n.start_s, end=max(n.end_s, n.start_s + 0.03)))
    pm.instruments.append(inst)
    return pm


def render_fluidsynth(pm: pretty_midi.PrettyMIDI, soundfont: str, sr: int = 44100) -> Optional[np.ndarray]:
    """Render via pyfluidsynth (in-process) or the fluidsynth CLI. None when neither is available."""
    try:
        audio = pm.fluidsynth(fs=sr, sf2_path=soundfont)  # pretty_midi uses pyfluidsynth
        return np.stack([audio, audio]).astype(np.float32) if audio.ndim == 1 else np.asarray(audio, dtype=np.float32).T
    except Exception:
        pass
    cli = shutil.which("fluidsynth")
    if not cli:
        return None
    with tempfile.TemporaryDirectory() as td:
        mid = os.path.join(td, "in.mid")
        wav = os.path.join(td, "out.wav")
        pm.write(mid)
        subprocess.run([cli, "-ni", "-g", "0.8", "-F", wav, "-r", str(sr), soundfont, mid], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import soundfile as sf

        data, _ = sf.read(wav, dtype="float32", always_2d=True)
        return data.T


def render_simple(pm: pretty_midi.PrettyMIDI, sr: int = 44100, harmonics: int = 5) -> np.ndarray:
    """Additive fallback: harmonic tones with an attack/decay envelope. Preview quality."""
    end = max((n.end for i in pm.instruments for n in i.notes), default=1.0) + 0.5
    out = np.zeros(int(end * sr), dtype=np.float64)
    for inst in pm.instruments:
        program = inst.program
        brightness = 1.0 if program < 8 else (1.6 if 24 <= program < 32 else 0.7)
        for n in inst.notes:
            dur = max(n.end - n.start, 0.03)
            k = int(dur * sr)
            t = np.arange(k) / sr
            f0 = 440.0 * 2 ** ((n.pitch - 69) / 12)
            sig = np.zeros(k)
            for h in range(1, harmonics + 1):
                if f0 * h >= sr / 2:
                    break
                sig += np.sin(2 * np.pi * f0 * h * t) / (h ** (1.2 * brightness))
            a = max(1, int(0.01 * sr))
            env = np.ones(k)
            env[:a] = np.linspace(0, 1, a)
            env *= np.exp(-t / max(dur, 0.2))
            r = max(1, min(int(0.02 * sr), k))
            env[-r:] *= np.linspace(1, 0, r)
            start = int(n.start * sr)
            seg = sig * env * (n.velocity / 127.0)
            out[start:start + k] += seg[: len(out) - start]
    peak = np.max(np.abs(out)) or 1.0
    mono = (out / peak * 0.8).astype(np.float32)
    return np.stack([mono, mono])


def render(result: MidiResult, instrument: str, sr: int = 44100, soundfont: Optional[str] = None,
           prefer_simple: bool = False) -> tuple[np.ndarray, str]:
    pm = midi_for_instrument(result, instrument)
    if not prefer_simple:
        sf2 = soundfont or find_soundfont()
        if sf2:
            audio = render_fluidsynth(pm, sf2, sr)
            if audio is not None:
                return audio, "fluidsynth"
    return render_simple(pm, sr), "simple"


def transcribe(y: np.ndarray, sr: int, bpm: float) -> MidiResult:
    from ..chops.midi import melody_midi

    return melody_midi(y, sr, bpm)


def revoice(y: np.ndarray, sr: int, instrument: str, bpm: float, keep_groove: bool = False,
            groove_template: Optional[dict] = None, grid: Optional[Grid] = None, out_sr: int = 44100,
            midi: Optional[MidiResult] = None, soundfont: Optional[str] = None) -> RevoiceResult:
    """Symbolic path end to end. Pass ``midi`` to re-render edited notes without re-transcribing."""
    if instrument not in INSTRUMENTS:
        raise ValueError(f"unknown instrument {instrument!r}; choose one of {sorted(INSTRUMENTS)}")
    result = midi or transcribe(y, sr, bpm)
    notes = []
    if keep_groove and groove_template and grid is not None:
        result = apply_groove(result, groove_template, grid)
        notes.append("source groove offsets applied")
    audio, renderer = render(result, instrument, out_sr, soundfont)
    if renderer == "simple":
        notes.append("rendered with the built-in additive renderer (preview quality); install FluidSynth and a "
                     "General MIDI soundfont for the sampled instrument")
    if not midi:
        notes.append("transcription by Basic Pitch; polyphonic sources may have wrong or missing notes, edit the MIDI and re-render")
    return RevoiceResult(midi=result, audio=audio, sr=out_sr, instrument=instrument, renderer=renderer, notes=notes)


def midi_result_from_notes(notes: list[dict[str, Any]], bpm: float) -> MidiResult:
    """Rebuild a MidiResult from the editable notes JSON the piano roll sends back."""
    pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
    inst = pretty_midi.Instrument(program=0, name="melody")
    events = []
    for n in notes:
        ev = NoteEvent(pitch=int(n["pitch"]), start_s=float(n["start_s"]), end_s=float(n["end_s"]),
                       velocity=int(n.get("velocity", 100)))
        events.append(ev)
        inst.notes.append(pretty_midi.Note(velocity=ev.velocity, pitch=ev.pitch, start=ev.start_s, end=ev.end_s))
    pm.instruments.append(inst)
    return MidiResult(midi=pm, notes=events, kind="melody", meta={"bpm": bpm, "edited": True})


__all__ = ["INSTRUMENTS", "RevoiceResult", "find_soundfont", "midi_for_instrument", "midi_result_from_notes",
           "render", "render_fluidsynth", "render_simple", "revoice", "transcribe"]
