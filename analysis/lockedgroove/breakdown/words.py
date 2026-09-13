"""Producer-language helpers shared by the breakdown composer and the chat.

Everything here is deterministic string formatting over measured values.
"""

from __future__ import annotations

from typing import Optional

from ..report import Mode

FLAT_SPELLING = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}
# Conventional spellings: minor keys and major keys that are usually written flat.
CONVENTIONAL_MAJOR_FLATS = {"D#", "G#", "A#"}      # Eb, Ab, Bb major
CONVENTIONAL_MINOR_FLATS = {"D#", "A#"}            # Eb minor, Bb minor
CONVENTIONAL_MAJOR_SHARPS = {"C#", "F#"}           # spelled Db and Gb? Db major is conventional; keep F# major
CONVENTIONAL_MINOR_SHARPS = {"C#", "F#", "G#"}     # C# minor, F# minor, G# minor

STEP_SUB = ["", "e", "and", "a"]
BEAT_WORD = ["one", "two", "three", "four"]


def key_display(tonic: str, mode: Mode) -> str:
    """Conventional spelling (OPEN_QUESTIONS C.13): F minor, Bb major, C# minor, Db major."""
    t = tonic
    if mode == "major":
        if tonic in CONVENTIONAL_MAJOR_FLATS or tonic == "C#":
            t = FLAT_SPELLING.get(tonic, tonic)
    else:
        if tonic in CONVENTIONAL_MINOR_FLATS:
            t = FLAT_SPELLING.get(tonic, tonic)
    return f"{t} {mode}"


def key_token(tonic: str, mode: Mode) -> str:
    """Compact key token for filenames and readouts: Fm, Bb, C#m, Ebm."""
    name = key_display(tonic, mode).split(" ")[0]
    return f"{name}m" if mode == "minor" else name


def step_name(step: int, beats_per_bar: int = 4) -> str:
    """0 -> 'the one', 2 -> 'the and of one', 10 -> 'the and of three', 11 -> 'the a of three'."""
    beat = (step // 4) % beats_per_bar
    sub = step % 4
    beat_word = BEAT_WORD[beat] if beat < 4 else str(beat + 1)
    if sub == 0:
        return f"the {beat_word}"
    return f"the {STEP_SUB[sub]} of {beat_word}"


def steps_phrase(steps: list[int]) -> str:
    names = [step_name(s) for s in sorted(steps)]
    if not names:
        return "nowhere"
    if len(names) == 1:
        return names[0]
    return ", ".join(names[:-1]) + " and " + names[-1]


def bpm_text(bpm: Optional[float]) -> str:
    if bpm is None:
        return "unknown"
    r = round(bpm)
    return f"{r}" if abs(bpm - r) < 0.05 else f"{bpm:.1f}"


def pct(x: float) -> str:
    return f"{x:.0f} percent"


def db(x: float, signed: bool = True) -> str:
    return f"{x:+.1f} dB" if signed else f"{abs(x):.1f} dB"


def seconds(x: float) -> str:
    return f"{x:.1f} s"


def bar_number(bar_index: int) -> int:
    """Bars are 1-based for producers; indexes are 0-based internally."""
    return bar_index + 1


# Above this the file has everything a 44.1 kHz container can hold; below the
# second, the record is the ceiling and no processing will get past it.
FULL_BANDWIDTH_HZ = 19000.0
LIMITED_BANDWIDTH_HZ = 16000.0


def khz(hz: float) -> str:
    return f"{hz / 1000:.1f} kHz"


def bandwidth_text(hz: Optional[float]) -> str:
    """What the file's true bandwidth means for a flip, in a producer's terms."""
    if hz is None:
        return "I haven't measured how far up this file actually goes."
    if hz >= FULL_BANDWIDTH_HZ:
        return f"The top end runs all the way to {khz(hz)}, so there's nothing missing up there."
    if hz >= LIMITED_BANDWIDTH_HZ:
        return (f"The file stops at {khz(hz)} - a little shy of the full top end, though you'd have to "
                "listen for it.")
    return (f"The file itself stops at {khz(hz)}: there is no air above that to bring back, so anything "
            "cut from this will sound as dark as the record does. That's the source, not the processing.")


def with_hedge(hedge: str, sentence: str) -> str:
    """Prefix a sentence with the hedge in the way a mentor would say it."""
    if not hedge:
        return sentence
    if hedge == "not measured":
        return sentence
    if hedge == "I can't tell":
        return f"I can't tell for sure, but it reads as: {sentence[0].lower() + sentence[1:]}"
    # "likely" / "roughly"
    return f"{hedge.capitalize()} {sentence[0].lower() + sentence[1:]}"


__all__ = ["FULL_BANDWIDTH_HZ", "LIMITED_BANDWIDTH_HZ", "bandwidth_text", "bar_number", "bpm_text", "db",
           "key_display", "key_token", "khz", "pct", "seconds", "step_name", "steps_phrase", "with_hedge"]
