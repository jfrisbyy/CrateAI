#!/usr/bin/env python3
"""Run the audio quality chain on a file and print what each stage cost.

    python scripts/quality_chain.py path/to/record.wav
    python scripts/quality_chain.py record.wav --stem drums --ratio 0.73 --pitch +6
    python scripts/quality_chain.py --self-test          # no file needed
    python scripts/quality_chain.py record.wav --engines # compare every stretcher

This is the measurement that found the muddy-layers bug: 8-20 kHz energy
relative to the whole signal, and how much of each onset's sharpness survives,
at the source, after separation, and after a stretch. Exits non-zero when a
stage spends more than its budget, so it can be wired into a check.

Separation defaults to the band-split stand-in, which is not a separation model
and proves nothing about one; pass --real to use the installed separator (needs
the GPU image and a model download).
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "analysis"))

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from lockedgroove.combine.align import (  # noqa: E402
    ENGINES,
    available_engines,
    engine_installed,
    stretch_and_shift,
)
from lockedgroove.quality.chain import run_chain  # noqa: E402
from lockedgroove.quality.fixtures import transient_bed  # noqa: E402
from lockedgroove.quality.metrics import air_db, transient_retention  # noqa: E402


def self_test_file(directory: str) -> str:
    y, _ = transient_bed()
    path = str(pathlib.Path(directory) / "transient_bed.wav")
    sf.write(path, np.stack([y, y]).T, 44100)
    return path


def compare_engines(ratios: list[float]) -> int:
    """Every installed stretcher against the same material, on the same two numbers."""
    y, onsets = transient_bed()
    sr = 44100
    print(f"transient bed: {len(y) / sr:.1f} s, {len(onsets)} onsets, "
          f"8-20 kHz at {air_db(y, sr):+.2f} dB\n")
    print(f"{'engine':14s} {'ratio':>6s} {'air delta':>10s} {'transients kept':>16s}")
    for name in ENGINES:
        if name == "varispeed":
            continue  # only defined when the pitch change follows the speed change
        if not engine_installed(name):
            print(f"{name:14s} {'-':>6s} {'not installed here':>27s}")
            continue
        for ratio in ratios:
            out = stretch_and_shift(y, sr, ratio, 0.0, engine=name)[0]
            kept = transient_retention(y, out, sr, ratio, onsets)
            print(f"{name:14s} {ratio:6.2f} {air_db(out, sr) - air_db(y, sr):+9.2f} dB {kept:15.3f}")
    print(f"\ninstalled, best first: {', '.join(available_engines())}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", nargs="?", help="audio file to run the chain on")
    parser.add_argument("--self-test", action="store_true", help="use the built-in fixture instead of a file")
    parser.add_argument("--engines", action="store_true", help="compare every installed stretcher and exit")
    parser.add_argument("--stem", default="other", help="which stem to carry into the stretch (default: other)")
    parser.add_argument("--model", default=None, help="separation model; default is the best available")
    parser.add_argument("--ratio", type=float, default=0.83, help="stretch ratio (>1 shorter)")
    parser.add_argument("--pitch", type=float, default=0.0, help="pitch shift in semitones")
    parser.add_argument("--engine", default=None, choices=sorted(ENGINES), help="force a stretch engine")
    parser.add_argument("--real", action="store_true", help="use the installed separator, not the stand-in")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args()

    if args.engines:
        return compare_engines([0.73, 0.83, 1.18])
    if not args.path and not args.self_test:
        parser.error("give a file, or --self-test, or --engines")

    with tempfile.TemporaryDirectory() as tmp:
        path = args.path or self_test_file(tmp)
        backend = None
        if not args.real:
            from lockedgroove.stems.separate import FakeSeparator

            backend = FakeSeparator()
        report = run_chain(path, backend=backend, model=args.model, stem=args.stem, ratio=args.ratio,
                           semitones=args.pitch, engine=args.engine)

    if args.json:
        print(json.dumps(report.to_json(), indent=2))
    else:
        print(f"source: {path}")
        print(f"separator: {report.context['model']['model']} "
              f"({report.context['model']['model_tier']} tier) - {report.context['model_reason']}")
        print(report.table())
    if not report.ok:
        print("\nthe chain spent more than its budget; see the FAIL lines above", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
