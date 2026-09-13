#!/usr/bin/env python3
"""Build the deterministic synthetic evaluation set into data/synthetic/ (gitignored).

Every item is rendered from an explicit spec with ``lockedgroove.testing.synth``;
nothing is recorded, downloaded, or hand-labeled. Each item is a WAV plus a JSON
truth file::

    {bpm, key: {tonic, mode}, downbeats_s, beats_s,
     sections: [{start_s, end_s, label}], loop_period_bars, ...}

The set varies

* tempo, 65-175 BPM, including half/double pairs (70/140, 75/150, 80/160,
  87.5/175) so octave errors are exercised;
* key, all 24, through diatonic chord progressions and arpeggios built from
  ``synth.triad`` / ``synth.chord_progression`` / ``synth.arpeggio``;
* the offset of the first downbeat: leading silence and pickups (a partial
  bar before the first downbeat);
* swing (50 / 58 / 62 / 66.7 %) with programmed and sampled-break feel;
* structure: ABAB, AABA, ABCB with 4- and 8-bar loops;
* stereo width (mono, 0.3, 0.6) and sample rate (22050, a few at 44100);
* drums on/off and three drum patterns.

Usage::

    python scripts/build_synthetic_dataset.py            # build into data/synthetic
    python scripts/build_synthetic_dataset.py --list     # print the spec table only
    python scripts/build_synthetic_dataset.py --force    # re-render existing items
    python scripts/build_synthetic_dataset.py --limit 5  # first five items only

Deterministic: the same spec, seed, and synth version give byte-identical WAVs.
The manifest records the builder version and a hash of synth.py so a change to
either shows up as a different manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import time
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "analysis"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from lockedgroove.testing import synth  # noqa: E402

BUILDER_VERSION = 1
DEFAULT_SEED = 20260913
DEFAULT_OUT = ROOT / "data" / "synthetic"
TAIL_S = 0.35
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
KEYS = [(t, m) for m in ("major", "minor") for t in PITCH_CLASSES]

# scale degree -> (semitones above the tonic, triad quality)
MAJOR_DEGREES = {"I": (0, "major"), "ii": (2, "minor"), "iii": (4, "minor"),
                 "IV": (5, "major"), "V": (7, "major"), "vi": (9, "minor")}
MINOR_DEGREES = {"i": (0, "minor"), "III": (3, "major"), "iv": (5, "minor"),
                 "v": (7, "minor"), "VI": (8, "major"), "VII": (10, "major")}

# one chord per bar; the loop is ``loop_bars`` long and repeats through a section
LOOPS: dict[str, dict[int, dict[str, list[str]]]] = {
    "major": {
        4: {"A": ["I", "V", "vi", "IV"], "B": ["vi", "IV", "I", "V"], "C": ["I", "IV", "ii", "V"]},
        8: {"A": ["I", "V", "vi", "IV", "I", "V", "ii", "V"],
            "B": ["vi", "IV", "I", "V", "vi", "ii", "IV", "V"],
            "C": ["I", "iii", "IV", "V", "I", "IV", "ii", "V"]},
    },
    "minor": {
        4: {"A": ["i", "VI", "III", "VII"], "B": ["iv", "i", "VI", "VII"], "C": ["i", "iv", "v", "i"]},
        8: {"A": ["i", "VI", "III", "VII", "i", "VI", "iv", "VII"],
            "B": ["iv", "i", "VI", "VII", "iv", "v", "VI", "VII"],
            "C": ["i", "iv", "v", "i", "III", "VI", "iv", "VII"]},
    },
}

PATTERNS = {
    "boom_bap": synth.Pattern.boom_bap,
    "four_on_floor": synth.Pattern.four_on_floor,
    "kick_on_one": synth.Pattern.kick_on_one,
}


# --------------------------------------------------------------------------
# spec table
# --------------------------------------------------------------------------

def _spec(name: str, **kw: Any) -> dict[str, Any]:
    base = dict(
        name=name, bpm=90.0, tonic="C", mode="major", structure="ABAB", loop_bars=4, section_bars=8,
        pattern="boom_bap", harmonic="chords", swing=50.0, jitter_ms=0.0, spectral_variation=0.0,
        lead_s=0.0, pickup_beats=0, width=0.0, with_drums=True, sr=22050, octave=4,
    )
    base.update(kw)
    base["bpm"] = float(base["bpm"])
    return base


def build_specs() -> list[dict[str, Any]]:
    """The full spec table: 48 items, deterministic, no randomness."""
    specs: list[dict[str, Any]] = []
    structures = ["ABAB", "AABA", "ABCB"]
    patterns = ["boom_bap", "four_on_floor", "kick_on_one"]
    harmonics = ["chords", "arpeggio", "both"]
    leads = [0.0, 0.3, 0.9, 1.6]
    pickups = [0, 2, 1, 3]
    widths = [0.0, 0.3, 0.6]

    # 1) all 24 keys, tempos spread across the range
    tempos24 = [65, 72, 78, 84, 88, 92, 96, 100, 104, 108, 112, 116,
                120, 124, 128, 132, 138, 144, 150, 156, 162, 168, 172, 175]
    for i, ((tonic, mode), bpm) in enumerate(zip(KEYS, tempos24, strict=True)):
        specs.append(_spec(
            f"key{i:02d}_{tonic.replace('#', 's')}_{mode}_{bpm:g}bpm", bpm=bpm, tonic=tonic, mode=mode,
            structure=structures[i % 3], loop_bars=4, section_bars=4 if bpm < 100 else 8,
            pattern=patterns[i % 3], harmonic=harmonics[(i // 3) % 3],
            lead_s=leads[i % 4], pickup_beats=pickups[(i // 4) % 4], width=widths[i % 3],
            octave=4 if i % 2 == 0 else 3, sr=44100 if i % 12 == 5 else 22050,
        ))

    # 2) half/double pairs: both members in range, so an octave error on one is exactly the other
    for j, (lo, hi) in enumerate([(70, 140), (75, 150), (80, 160), (87.5, 175)]):
        for which, bpm in (("half", lo), ("double", hi)):
            tonic, mode = KEYS[(7 * j + (0 if which == "half" else 13)) % 24]
            specs.append(_spec(
                f"octave{j}_{which}_{bpm:g}bpm", bpm=bpm, tonic=tonic, mode=mode,
                structure=structures[j % 3], loop_bars=4, section_bars=4 if bpm < 100 else 8,
                pattern=patterns[(j + 1) % 3], harmonic=harmonics[j % 3],
                lead_s=leads[(j + 1) % 4], pickup_beats=pickups[j % 4], width=widths[(j + 1) % 3],
            ))

    # 3) swing, programmed (exact grid) and sampled (jitter + spectral variation)
    swings = [(86, 58.0, 0.0), (92, 62.0, 0.0), (98, 66.7, 0.0), (118, 58.0, 6.0), (126, 62.0, 6.0), (134, 66.7, 6.0)]
    for j, (bpm, swing, jitter) in enumerate(swings):
        tonic, mode = KEYS[(5 * j + 3) % 24]
        specs.append(_spec(
            f"swing{j}_{swing:g}pct_{'sampled' if jitter else 'programmed'}_{bpm}bpm", bpm=bpm, tonic=tonic, mode=mode,
            structure=structures[(j + 2) % 3], loop_bars=4, section_bars=4 if bpm < 100 else 8,
            pattern="boom_bap", harmonic=harmonics[(j + 1) % 3], swing=swing, jitter_ms=jitter,
            spectral_variation=0.2 if jitter else 0.0, lead_s=leads[j % 4], pickup_beats=pickups[(j + 2) % 4],
            width=widths[j % 3],
        ))

    # 4) 8-bar loops (8-bar sections, 32 bars) at tempos where that stays under ~75 s
    for j, (bpm, structure) in enumerate([(110, "ABAB"), (126, "AABA"), (140, "ABCB"), (170, "ABAB")]):
        tonic, mode = KEYS[(11 * j + 6) % 24]
        specs.append(_spec(
            f"loop8_{structure}_{bpm}bpm", bpm=bpm, tonic=tonic, mode=mode, structure=structure,
            loop_bars=8, section_bars=8, pattern=patterns[j % 3], harmonic=harmonics[(j + 2) % 3],
            lead_s=leads[(j + 2) % 4], pickup_beats=pickups[(j + 1) % 4], width=widths[(j + 2) % 3],
            sr=44100 if j == 1 else 22050,
        ))

    # 5) drums off: harmonic rhythm is the only tempo cue
    for j, bpm in enumerate([68, 82, 95, 122, 146, 165]):
        tonic, mode = KEYS[(9 * j + 1) % 24]
        specs.append(_spec(
            f"nodrums{j}_{harmonics[j % 3]}_{bpm}bpm", bpm=bpm, tonic=tonic, mode=mode,
            structure=structures[j % 3], loop_bars=4, section_bars=4 if bpm < 100 else 8,
            harmonic=harmonics[j % 3], with_drums=False, lead_s=0.5 if j % 2 else 0.0,
            pickup_beats=0, width=widths[j % 3], octave=3 if j % 2 else 4,
        ))
    return specs


# --------------------------------------------------------------------------
# rendering
# --------------------------------------------------------------------------

def degree_triad(tonic: str, mode: str, degree: str, octave: int) -> list[float]:
    interval, quality = (MAJOR_DEGREES if mode == "major" else MINOR_DEGREES)[degree]
    root_midi = synth.midi_note(tonic, octave) + interval
    return synth.triad(PITCH_CLASSES[root_midi % 12], quality, root_midi // 12 - 1)


def _fit(y: np.ndarray, n: int) -> np.ndarray:
    if len(y) >= n:
        return y[:n]
    return np.concatenate([y, np.zeros(n - len(y), dtype=np.float32)])


def render_section(label: str, spec: dict[str, Any]) -> np.ndarray:
    sr, bpm = spec["sr"], spec["bpm"]
    bar_s = 240.0 / bpm
    loop_bars, section_bars = spec["loop_bars"], spec["section_bars"]
    repeats = max(1, section_bars // loop_bars)
    degrees = LOOPS[spec["mode"]][loop_bars][label]
    chords = [degree_triad(spec["tonic"], spec["mode"], d, spec["octave"]) for d in degrees]
    n = int(round(section_bars * bar_s * sr))
    kind = spec["harmonic"]
    layers: list[np.ndarray] = []
    gains: list[float] = []
    if kind in ("chords", "both") or label == "C":
        amp = 0.45 if label != "C" else 0.35
        layers.append(_fit(synth.chord_progression(chords, 4, bpm, sr, repeats=repeats, amplitude=amp), n))
        gains.append(1.0)
    if kind in ("arpeggio", "both") or label == "B":
        notes_per_beat = 4 if label == "B" else 2
        bars: list[np.ndarray] = []
        for c in chords * repeats:
            bars.append(synth.arpeggio(list(c) + [c[0] + 12], bpm, bar_s, sr,
                                       notes_per_beat=notes_per_beat, amplitude=0.3))
        layers.append(_fit(np.concatenate(bars), n))
        gains.append(1.0 if kind == "arpeggio" else 0.7)
    if label == "C":
        # a low root drone marks the C section apart from A and B
        root = chords[0][0] - 12
        layers.append(_fit(synth.tone(root, section_bars * bar_s, sr, amplitude=0.22, harmonics=3), n))
        gains.append(1.0)
    return synth.mix(*layers, gains=gains)


def render_item(spec: dict[str, Any]) -> tuple[np.ndarray, dict[str, Any]]:
    sr, bpm = spec["sr"], spec["bpm"]
    beat_s = 60.0 / bpm
    bar_s = 4 * beat_s
    labels = list(spec["structure"])
    section_bars = spec["section_bars"]
    total_bars = section_bars * len(labels)
    body_n = int(round(total_bars * bar_s * sr)) + int(round(TAIL_S * sr))

    harmonic = np.zeros(body_n, dtype=np.float32)
    for si, label in enumerate(labels):
        seg = render_section(label, spec)
        start = int(round(si * section_bars * bar_s * sr))
        seg = seg[: body_n - start]
        harmonic[start:start + len(seg)] += seg
    layers, gains = [harmonic], [0.8]
    if spec["with_drums"]:
        drums = synth.drum_loop(
            bpm, total_bars, PATTERNS[spec["pattern"]](), sr, swing_pct=spec["swing"],
            jitter_ms=spec["jitter_ms"], velocity_jitter=0.15 if spec["jitter_ms"] else 0.0,
            spectral_variation=spec["spectral_variation"], seed=spec["seed"],
        )
        layers.append(_fit(drums, body_n))
        gains.append(0.9)
    body = synth.normalize(synth.mix(*layers, gains=gains), 0.9)

    k = int(spec["pickup_beats"])
    pickup = synth.crop(body, bar_s - k * beat_s, bar_s, sr) if k else np.zeros(0, dtype=np.float32)
    lead = synth.silence(spec["lead_s"], sr)
    y = synth.concat(lead, pickup, body)

    t_lead = len(lead) / sr
    t0 = (len(lead) + len(pickup)) / sr  # first full-bar downbeat
    beats = [t_lead + j * beat_s for j in range(k)] + [t0 + i * beat_s for i in range(4 * total_bars)]
    downbeats = [t0 + b * bar_s for b in range(total_bars)]
    sections = []
    for si, label in enumerate(labels):
        start_bar = si * section_bars
        sections.append({
            "label": label, "start_bar": start_bar, "bars": section_bars,
            "start_s": round(t0 + start_bar * bar_s, 6), "end_s": round(t0 + (start_bar + section_bars) * bar_s, 6),
        })
    truth = {
        "id": spec["name"],
        "bpm": bpm,
        "key": {"tonic": spec["tonic"], "mode": spec["mode"]},
        "meter": "4/4",
        "downbeats_s": [round(t, 6) for t in downbeats],
        "beats_s": [round(t, 6) for t in beats],
        "sections": sections,
        "loop_period_bars": spec["loop_bars"],
        "first_downbeat_s": round(t0, 6),
        "duration_s": round(len(y) / sr, 6),
        "sr": sr,
        "channels": 2 if spec["width"] > 0 else 1,
        "params": {k_: v for k_, v in spec.items() if k_ != "name"},
    }
    if spec["width"] > 0:
        y = synth.to_stereo(y, spec["width"])
    return y, truth


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------

def _synth_hash() -> str:
    return hashlib.sha256(pathlib.Path(synth.__file__).read_bytes()).hexdigest()[:16]


def build(out: pathlib.Path, seed: int, limit: int | None, force: bool, quiet: bool = False) -> list[dict[str, Any]]:
    specs = build_specs()
    if limit is not None:
        specs = specs[:limit]
    out.mkdir(parents=True, exist_ok=True)
    manifest_items = []
    t_start = time.perf_counter()
    for i, spec in enumerate(specs):
        spec = dict(spec, seed=seed + i)
        wav = out / f"{spec['name']}.wav"
        js = out / f"{spec['name']}.json"
        if wav.exists() and js.exists() and not force:
            truth = json.loads(js.read_text())
            status = "kept"
        else:
            t0 = time.perf_counter()
            y, truth = render_item(spec)
            data = y.T if y.ndim == 2 else y
            sf.write(str(wav), data, spec["sr"], subtype="PCM_16")
            js.write_text(json.dumps(truth, indent=1))
            status = f"rendered in {time.perf_counter() - t0:.1f}s"
        manifest_items.append({
            "id": spec["name"], "wav": wav.name, "truth": js.name, "duration_s": truth["duration_s"],
            "bpm": truth["bpm"], "key": truth["key"], "structure": spec["structure"],
            "loop_period_bars": spec["loop_bars"], "with_drums": spec["with_drums"], "seed": spec["seed"],
        })
        if not quiet:
            print(f"[{i + 1:2d}/{len(specs)}] {spec['name']:<44s} {truth['duration_s']:6.1f}s  {status}")
    manifest = {
        "dataset": "synthetic",
        "builder_version": BUILDER_VERSION,
        "seed": seed,
        "synth_sha256_16": _synth_hash(),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(manifest_items),
        "items": manifest_items,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    if not quiet:
        total = sum(it["duration_s"] for it in manifest_items)
        print(f"{len(manifest_items)} items, {total / 60:.1f} min of audio, {time.perf_counter() - t_start:.1f}s -> {out}")
    return manifest_items


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--limit", type=int, default=None, help="build only the first N items")
    ap.add_argument("--force", action="store_true", help="re-render items that already exist")
    ap.add_argument("--list", action="store_true", help="print the spec table and exit")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    if args.list:
        specs = build_specs()
        print(f"{'name':<44s} {'bpm':>6s} key        struct loop sec pattern        harm     swing lead pick width sr    drums")
        for s in specs[: args.limit]:
            print(f"{s['name']:<44s} {s['bpm']:6.1f} {s['tonic'] + ' ' + s['mode']:<10s} {s['structure']:<6s} "
                  f"{s['loop_bars']:>4d} {s['section_bars']:>3d} {s['pattern']:<14s} {s['harmonic']:<8s} "
                  f"{s['swing']:5.1f} {s['lead_s']:4.1f} {s['pickup_beats']:4d} {s['width']:5.1f} {s['sr']:<5d} "
                  f"{'on' if s['with_drums'] else 'off'}")
        print(f"{len(specs)} items")
        return 0
    build(args.out, args.seed, args.limit, args.force, args.quiet)
    return 0


if __name__ == "__main__":
    sys.exit(main())
