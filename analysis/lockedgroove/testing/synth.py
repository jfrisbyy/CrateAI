"""Synthetic audio for tests and the synthetic accuracy set.

Everything here is deterministic given ``seed``. Generators return mono float32
arrays in [-1, 1] unless noted. Nothing is downloaded; nothing is recorded.
These fixtures are what "tests before DSP" (principle 8) is written against.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

DEFAULT_SR = 22050


def _env_exp(n: int, sr: int, decay_s: float) -> np.ndarray:
    t = np.arange(n) / sr
    return np.exp(-t / max(decay_s, 1e-4)).astype(np.float32)


def _fade_out(y: np.ndarray, sr: int, ms: float = 5.0) -> np.ndarray:
    """Linear fade over the last ``ms`` so a truncated tail never clicks."""
    n = min(len(y), max(1, int(round(sr * ms / 1000))))
    if n > 1:
        y[-n:] = y[-n:] * np.linspace(1.0, 0.0, n, dtype=np.float32)
    return y


def normalize(y: np.ndarray, peak: float = 0.9) -> np.ndarray:
    m = float(np.max(np.abs(y))) if y.size else 0.0
    if m <= 0:
        return y.astype(np.float32)
    return (y / m * peak).astype(np.float32)


def silence(seconds: float, sr: int = DEFAULT_SR) -> np.ndarray:
    return np.zeros(int(round(seconds * sr)), dtype=np.float32)


def sine(freq_hz: float, seconds: float, sr: int = DEFAULT_SR, amplitude: float = 0.5, phase: float = 0.0) -> np.ndarray:
    t = np.arange(int(round(seconds * sr))) / sr
    return (amplitude * np.sin(2 * np.pi * freq_hz * t + phase)).astype(np.float32)


def click(sr: int = DEFAULT_SR, freq_hz: float = 1000.0, ms: float = 5.0, amplitude: float = 0.9) -> np.ndarray:
    n = int(round(sr * ms / 1000))
    t = np.arange(n) / sr
    env = np.hanning(2 * n)[n:] if n > 1 else np.ones(n)
    return (amplitude * np.sin(2 * np.pi * freq_hz * t) * env).astype(np.float32)


def click_track(bpm: float, seconds: float, sr: int = DEFAULT_SR, offset_s: float = 0.0,
                accent_every: int = 0, amplitude: float = 0.9) -> np.ndarray:
    """Clicks at every beat. ``accent_every`` > 0 makes every n-th click louder."""
    y = silence(seconds, sr)
    period = 60.0 / bpm
    c = click(sr, amplitude=amplitude)
    i = 0
    t = offset_s
    while t < seconds:
        start = int(round(t * sr))
        amp = 1.0
        if accent_every and i % accent_every == 0:
            amp = 1.0
        elif accent_every:
            amp = 0.6
        seg = c[: max(0, min(len(c), len(y) - start))]
        if len(seg):
            y[start:start + len(seg)] += (seg * amp).astype(np.float32)
        t += period
        i += 1
    return np.clip(y, -1, 1)


def kick(sr: int = DEFAULT_SR, seconds: float = 0.28, f_start: float = 160.0, f_end: float = 48.0,
         amplitude: float = 0.95, decay_s: float = 0.09, sweep_s: float = 0.03, brightness: float = 0.0) -> np.ndarray:
    n = int(round(seconds * sr))
    t = np.arange(n) / sr
    # exponential pitch sweep
    f = f_end + (f_start - f_end) * np.exp(-t / max(sweep_s, 1e-4))
    phase = 2 * np.pi * np.cumsum(f) / sr
    body = np.sin(phase) * _env_exp(n, sr, decay_s)
    if brightness > 0:
        rng = np.random.default_rng(0)
        body = body + brightness * rng.standard_normal(n) * _env_exp(n, sr, 0.008)
    return _fade_out((amplitude * body).astype(np.float32), sr)


def snare(sr: int = DEFAULT_SR, seconds: float = 0.22, amplitude: float = 0.8, tone_hz: float = 185.0,
          noise_mix: float = 0.7, decay_s: float = 0.07, seed: int = 1) -> np.ndarray:
    n = int(round(seconds * sr))
    rng = np.random.default_rng(seed)
    t = np.arange(n) / sr
    tone = np.sin(2 * np.pi * tone_hz * t) * _env_exp(n, sr, decay_s * 0.6)
    noise = rng.standard_normal(n).astype(np.float32)
    # simple one-pole high-pass on the noise to keep it out of the kick's band
    hp = np.zeros_like(noise)
    prev_x = prev_y = 0.0
    a = 0.97
    for i, x in enumerate(noise):
        prev_y = a * (prev_y + x - prev_x)
        prev_x = x
        hp[i] = prev_y
    hp = hp / (np.max(np.abs(hp)) + 1e-9) * _env_exp(n, sr, decay_s)
    y = (1 - noise_mix) * tone + noise_mix * hp
    return _fade_out((amplitude * y / (np.max(np.abs(y)) + 1e-9)).astype(np.float32), sr)


def hat(sr: int = DEFAULT_SR, seconds: float = 0.06, amplitude: float = 0.5, open_hat: bool = False,
        seed: int = 2) -> np.ndarray:
    if open_hat:
        seconds = max(seconds, 0.25)
    n = int(round(seconds * sr))
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(n).astype(np.float32)
    # two cascaded difference filters approximate a high-pass around 5-6 kHz
    hp = np.diff(noise, prepend=0.0)
    hp = np.diff(hp, prepend=0.0)
    hp = hp / (np.max(np.abs(hp)) + 1e-9)
    env = _env_exp(n, sr, 0.09 if open_hat else 0.018)
    return _fade_out((amplitude * hp * env).astype(np.float32), sr)


@dataclass
class Pattern:
    """One-bar pattern on a 16-step grid; values are velocities 0..1."""

    kick: dict[int, float] = field(default_factory=dict)
    snare: dict[int, float] = field(default_factory=dict)
    hat: dict[int, float] = field(default_factory=dict)
    open_hat: dict[int, float] = field(default_factory=dict)

    @staticmethod
    def boom_bap() -> "Pattern":
        return Pattern(
            kick={0: 1.0, 7: 0.85, 10: 0.9},
            snare={4: 1.0, 12: 1.0, 11: 0.35},
            hat={s: (0.8 if s % 4 == 0 else 0.55) for s in range(0, 16, 2)},
        )

    @staticmethod
    def four_on_floor() -> "Pattern":
        return Pattern(
            kick={0: 1.0, 4: 1.0, 8: 1.0, 12: 1.0},
            snare={4: 0.9, 12: 0.9},
            hat={s: 0.6 for s in range(2, 16, 4)},
        )

    @staticmethod
    def kick_on_one() -> "Pattern":
        return Pattern(kick={0: 1.0}, hat={s: 0.4 for s in range(0, 16, 4)})


def step_time_in_beat(step_in_beat: int, swing_pct: float) -> float:
    """Fraction of the beat at which 16th ``step_in_beat`` (0..3) falls.

    ``swing_pct`` is the position of the off-beat 8th as a percentage of the
    beat: 50 is straight, 66.7 is triplet swing.
    """
    s = swing_pct / 100.0
    if step_in_beat < 2:
        return step_in_beat / 2.0 * s
    return s + (step_in_beat - 2) / 2.0 * (1.0 - s)


def drum_loop(bpm: float, bars: int, pattern: Pattern | None = None, sr: int = DEFAULT_SR,
              swing_pct: float = 50.0, jitter_ms: float = 0.0, velocity_jitter: float = 0.0,
              spectral_variation: float = 0.0, seed: int = 0, offset_s: float = 0.0,
              tail_s: float = 0.0, beats_per_bar: int = 4) -> np.ndarray:
    """Render a drum pattern.

    ``jitter_ms`` and ``spectral_variation`` > 0 emulate a sampled break (hits
    drift and vary); zero emulates programmed drums.
    """
    pattern = pattern or Pattern.boom_bap()
    rng = np.random.default_rng(seed)
    beat_s = 60.0 / bpm
    bar_s = beat_s * beats_per_bar
    total_s = offset_s + bars * bar_s + tail_s + 0.5
    y = silence(total_s, sr)

    def place(sample: np.ndarray, t: float, vel: float) -> None:
        start = int(round(t * sr))
        if start < 0 or start >= len(y):
            return
        seg = sample[: len(y) - start]
        y[start:start + len(seg)] += (seg * vel).astype(np.float32)

    for bar in range(bars):
        for name, hits in (("kick", pattern.kick), ("snare", pattern.snare),
                           ("hat", pattern.hat), ("open_hat", pattern.open_hat)):
            for step, vel in hits.items():
                beat = step // 4
                frac = step_time_in_beat(step % 4, swing_pct)
                t = offset_s + bar * bar_s + (beat + frac) * beat_s
                if jitter_ms > 0:
                    t += rng.normal(0.0, jitter_ms / 1000.0)
                v = vel * (1.0 + (rng.uniform(-velocity_jitter, velocity_jitter) if velocity_jitter else 0.0))
                v = float(np.clip(v, 0.05, 1.0))
                sv = spectral_variation
                if name == "kick":
                    smp = kick(sr, f_start=160 * (1 + rng.uniform(-sv, sv)), decay_s=0.09 * (1 + rng.uniform(-sv, sv)),
                               brightness=abs(rng.uniform(0, sv)) if sv else 0.0)
                elif name == "snare":
                    smp = snare(sr, tone_hz=185 * (1 + rng.uniform(-sv, sv)), noise_mix=float(np.clip(0.7 + rng.uniform(-sv, sv), 0.2, 0.95)),
                                seed=int(rng.integers(0, 1_000_000)) if sv else 1)
                elif name == "hat":
                    smp = hat(sr, seed=int(rng.integers(0, 1_000_000)) if sv else 2)
                else:
                    smp = hat(sr, open_hat=True, seed=int(rng.integers(0, 1_000_000)) if sv else 3)
                place(smp, t, v)
    return np.clip(y, -1, 1)


def midi_to_hz(note: float) -> float:
    return 440.0 * 2 ** ((note - 69) / 12.0)


def tone(note_midi: float, seconds: float, sr: int = DEFAULT_SR, amplitude: float = 0.4,
         harmonics: int = 6, attack_s: float = 0.01, decay_s: float = 0.0) -> np.ndarray:
    """A harmonically rich note (odd/even harmonics rolling off) with a short attack."""
    n = int(round(seconds * sr))
    t = np.arange(n) / sr
    f0 = midi_to_hz(note_midi)
    y = np.zeros(n, dtype=np.float64)
    for h in range(1, harmonics + 1):
        if f0 * h >= sr / 2:
            break
        y += np.sin(2 * np.pi * f0 * h * t) / (h ** 1.5)
    env = np.ones(n)
    a = max(1, int(attack_s * sr))
    env[:a] = np.linspace(0, 1, a)
    if decay_s > 0:
        env *= _env_exp(n, sr, decay_s)
    r = max(1, int(0.01 * sr))
    env[-r:] *= np.linspace(1, 0, r)
    y = y * env
    return (amplitude * y / (np.max(np.abs(y)) + 1e-9)).astype(np.float32)


def chord(notes_midi: list[float], seconds: float, sr: int = DEFAULT_SR, amplitude: float = 0.5,
          decay_s: float = 0.0) -> np.ndarray:
    y = sum(tone(n, seconds, sr, amplitude=1.0, decay_s=decay_s) for n in notes_midi)
    return (amplitude * y / (np.max(np.abs(y)) + 1e-9)).astype(np.float32)


def arpeggio(notes_midi: list[float], bpm: float, seconds: float, sr: int = DEFAULT_SR,
             notes_per_beat: int = 2, amplitude: float = 0.5) -> np.ndarray:
    """Cycle through ``notes_midi`` at ``notes_per_beat`` for ``seconds``."""
    y = silence(seconds, sr)
    dur = 60.0 / bpm / notes_per_beat
    t = 0.0
    i = 0
    while t < seconds:
        note = tone(notes_midi[i % len(notes_midi)], dur, sr, amplitude=amplitude, decay_s=dur * 0.8)
        start = int(round(t * sr))
        seg = note[: len(y) - start]
        y[start:start + len(seg)] += seg
        t += dur
        i += 1
    return np.clip(y, -1, 1)


def chord_progression(chords: list[list[float]], beats_per_chord: float, bpm: float,
                      sr: int = DEFAULT_SR, repeats: int = 1, amplitude: float = 0.5) -> np.ndarray:
    seg_s = beats_per_chord * 60.0 / bpm
    parts = [chord(c, seg_s, sr, amplitude=amplitude, decay_s=seg_s * 1.5) for c in chords] * repeats
    return np.concatenate(parts).astype(np.float32)


def continuous_chord_progression(chords: list[list[float]], beats_per_chord: float, bpm: float,
                                 sr: int = DEFAULT_SR, repeats: int = 1, amplitude: float = 0.5,
                                 crossfade_ms: float = 50.0, harmonics: int = 6) -> np.ndarray:
    """Chords that crossfade into each other: no attacks or fades at the changes.

    Used where a bar boundary must be musically continuous (so a raw cut there
    is a detectable seam), unlike ``chord_progression`` whose notes have their
    own attack and release.
    """
    seg_s = beats_per_chord * 60.0 / bpm
    seq = chords * repeats
    total_n = int(round(seg_s * len(seq) * sr))
    t = np.arange(total_n) / sr
    y = np.zeros(total_n, dtype=np.float64)
    xf = int(crossfade_ms / 1000 * sr)
    for i, notes in enumerate(seq):
        start, end = i * seg_s, (i + 1) * seg_s
        a, b = int(round(start * sr)), int(round(end * sr))
        lo, hi = max(0, a - xf // 2), min(total_n, b + xf // 2)
        env = np.ones(hi - lo)
        if i > 0:
            env[: min(xf, len(env))] = np.linspace(0, 1, min(xf, len(env)))
        if i < len(seq) - 1:
            env[-min(xf, len(env)):] = np.minimum(env[-min(xf, len(env)):], np.linspace(1, 0, min(xf, len(env))))
        sig = np.zeros(hi - lo)
        for n in notes:
            f0 = midi_to_hz(n)
            for h in range(1, harmonics + 1):
                if f0 * h >= sr / 2:
                    break
                sig += np.sin(2 * np.pi * f0 * h * t[lo:hi]) / (h ** 1.5)
        y[lo:hi] += sig * env
    return (amplitude * y / (np.max(np.abs(y)) + 1e-9)).astype(np.float32)


NOTE = {n: i for i, n in enumerate(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"])}


def midi_note(name: str, octave: int = 4) -> int:
    return 12 * (octave + 1) + NOTE[name]


def triad(root: str, mode: str = "major", octave: int = 4) -> list[float]:
    r = midi_note(root, octave)
    third = 4 if mode == "major" else 3
    return [r, r + third, r + 7]


def mix(*tracks: np.ndarray, gains: list[float] | None = None) -> np.ndarray:
    n = max(len(t) for t in tracks)
    out = np.zeros(n, dtype=np.float32)
    for i, t in enumerate(tracks):
        g = gains[i] if gains else 1.0
        out[: len(t)] += t * g
    return np.clip(out, -1, 1)


def concat(*parts: np.ndarray) -> np.ndarray:
    return np.concatenate(parts).astype(np.float32)


def crop(y: np.ndarray, start_s: float, end_s: float, sr: int = DEFAULT_SR) -> np.ndarray:
    return y[int(round(start_s * sr)): int(round(end_s * sr))].copy()


def add_reverb(y: np.ndarray, sr: int = DEFAULT_SR, rt60_s: float = 1.5, wet: float = 0.5, seed: int = 3) -> np.ndarray:
    """Convolve with an exponentially decaying noise impulse response (RT60 = rt60_s)."""
    rng = np.random.default_rng(seed)
    n = int(round(rt60_s * 1.2 * sr))
    t = np.arange(n) / sr
    # amplitude decays 60 dB over rt60_s: exp(-6.91 t / rt60)
    ir = rng.standard_normal(n) * np.exp(-6.907755 * t / rt60_s)
    ir[0] = 0.0
    ir = ir / (np.sqrt(np.sum(ir ** 2)) + 1e-9)
    wet_sig = np.convolve(y, ir)[: len(y)]
    out = (1 - wet) * y + wet * wet_sig / (np.max(np.abs(wet_sig)) + 1e-9) * np.max(np.abs(y))
    return normalize(out, 0.9)


def sidechain(y: np.ndarray, trigger_times_s: list[float], sr: int = DEFAULT_SR, depth_db: float = 6.0,
              attack_s: float = 0.005, release_s: float = 0.25) -> np.ndarray:
    """Duck ``y`` by ``depth_db`` at each trigger with an exponential release."""
    gain = np.ones(len(y), dtype=np.float32)
    floor = 10 ** (-depth_db / 20.0)
    for t in trigger_times_s:
        i0 = int(round(t * sr))
        if i0 >= len(y):
            continue
        n = min(len(y) - i0, int(release_s * 4 * sr))
        tt = np.arange(n) / sr
        env = floor + (1 - floor) * (1 - np.exp(-tt / release_s))
        a = max(1, int(attack_s * sr))
        env[:a] = np.linspace(1.0, floor, a)[: len(env[:a])]
        gain[i0:i0 + n] = np.minimum(gain[i0:i0 + n], env.astype(np.float32))
    return (y * gain).astype(np.float32)


def to_stereo(y: np.ndarray, width: float = 0.0, seed: int = 4) -> np.ndarray:
    """(2, n) array. width 0 -> identical channels; 1 -> fully decorrelated side."""
    if width <= 0:
        return np.stack([y, y])
    rng = np.random.default_rng(seed)
    side = rng.standard_normal(len(y)).astype(np.float32)
    side = side / (np.max(np.abs(side)) + 1e-9) * np.max(np.abs(y)) * width
    return np.stack([y + side, y - side]).astype(np.float32) / (1 + width)


def loop_based_track(bpm: float = 90.0, sr: int = DEFAULT_SR, loop_bars: int = 4, sections: str = "ABAB",
                     section_bars: int = 8, seed: int = 0, with_drums: bool = True) -> tuple[np.ndarray, dict]:
    """A loop-based track: each section repeats a ``loop_bars`` chord loop.

    Returns the audio and ground truth: bpm, downbeats, section boundaries,
    section labels, loop period in bars.
    """
    beat_s = 60.0 / bpm
    bar_s = beat_s * 4
    loops = {
        "A": [triad("F", "minor", 4), triad("G#", "major", 4), triad("A#", "major", 4), triad("C", "minor", 4)],
        "B": [triad("D#", "major", 4), triad("F", "minor", 4), triad("C", "minor", 4), triad("G#", "major", 4)],
        "C": [triad("A#", "minor", 4), triad("C#", "major", 4), triad("D#", "major", 4), triad("F", "minor", 4)],
    }
    parts = []
    truth_sections = []
    bar = 0
    for label in sections:
        chords = loops[label][:loop_bars] if loop_bars <= 4 else (loops[label] * (loop_bars // 4 + 1))[:loop_bars]
        loop = chord_progression(chords, 4, bpm, sr, repeats=section_bars // loop_bars, amplitude=0.45)
        loop = loop[: int(round(section_bars * bar_s * sr))]
        if label == "B":
            loop = loop * 1.0 + arpeggio([midi_note("F", 5), midi_note("G#", 5), midi_note("C", 6)], bpm,
                                         len(loop) / sr, sr, amplitude=0.25)[: len(loop)]
        parts.append(loop)
        truth_sections.append({"label": label, "start_bar": bar, "bars": section_bars,
                               "start_s": bar * bar_s, "end_s": (bar + section_bars) * bar_s})
        bar += section_bars
    harmonic = concat(*parts)
    y = harmonic
    if with_drums:
        drums = drum_loop(bpm, bar, Pattern.boom_bap(), sr, seed=seed)[: len(harmonic)]
        y = mix(harmonic, drums, gains=[0.8, 0.9])
    truth = {
        "bpm": bpm,
        "downbeats_s": [b * bar_s for b in range(bar)],
        "beats_s": [b * beat_s for b in range(bar * 4)],
        "sections": truth_sections,
        "loop_period_bars": loop_bars,
        "key": {"tonic": "F", "mode": "minor"},
    }
    return normalize(y, 0.9), truth
