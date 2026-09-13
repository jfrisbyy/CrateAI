#!/usr/bin/env python3
"""Generate the shared loop-render test vector from the Python implementation.

  analysis/tests/fixtures/loop_render_vector.json

``lockedgroove.loops.render.render_loop`` is the source of truth; the vector
pins its output so ``web/lib/audio/renderLoop.ts`` (client preview) and the
Python renderer (canonical export) can be asserted against the same samples
(BUILD_PACKET section 7: "one shared test vector asserted by both").

Input: 0.6 s of stereo at 8000 Hz, a 110 Hz tone with a phase discontinuity
at 0.2 s plus a little noise, quantized to 6 decimals *before* rendering so
both languages start from the same float32 samples. The primary case is a
tail-mode loop whose raw cut lands off-phase (a large seam jump), with the
expected output at ~300 indices around the seam and both ends. ``extra_cases``
cover self mode (loop ends at the end of the file), no snapping, and mono.

Deterministic (seeded). Regenerate after any intentional change to the
renderer:

    python scripts/gen_loop_vector.py
    python scripts/gen_loop_vector.py --check   # exit 1 when the file is stale
"""

from __future__ import annotations

import json
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "analysis"))

from lockedgroove.loops.render import render_loop  # noqa: E402

OUT_PATH = ROOT / "analysis" / "tests" / "fixtures" / "loop_render_vector.json"

SEED = 20260913
SAMPLE_RATE = 8000
DURATION_S = 0.6
TONE_HZ = 110.0
INPUT_DECIMALS = 6
OUTPUT_DECIMALS = 7

PRIMARY = {"start_s": 0.1, "end_s": 0.5023, "crossfade_ms": 12.0, "snap_zero_crossing": True}
EXTRA_CASES = [
    {"name": "self_mode_end_of_file", "start_s": 0.1, "end_s": 0.598, "crossfade_ms": 12.0,
     "snap_zero_crossing": True, "channel_indices": [0, 1]},
    {"name": "no_snap", "start_s": 0.1, "end_s": 0.5023, "crossfade_ms": 12.0,
     "snap_zero_crossing": False, "channel_indices": [0, 1]},
    {"name": "mono_short_crossfade", "start_s": 0.05, "end_s": 0.35, "crossfade_ms": 5.0,
     "snap_zero_crossing": True, "channel_indices": [0]},
    {"name": "whole_file_raw", "start_s": 0.0, "end_s": 0.6, "crossfade_ms": 12.0,
     "snap_zero_crossing": True, "channel_indices": [0, 1]},
]


def synth_input() -> np.ndarray:
    rng = np.random.default_rng(SEED)
    n = int(round(DURATION_S * SAMPLE_RATE))
    t = np.arange(n) / SAMPLE_RATE
    phase = np.where(t < 0.2, 0.0, 1.3)  # discontinuity at 0.2 s
    left = 0.6 * np.sin(2 * np.pi * TONE_HZ * t + phase) + 0.02 * rng.standard_normal(n)
    right = 0.5 * np.sin(2 * np.pi * TONE_HZ * t + phase + 0.4) + 0.02 * rng.standard_normal(n)
    y = np.stack([left, right])
    y = np.round(np.clip(y, -1.0, 1.0), INPUT_DECIMALS)
    return y.astype(np.float32)


def pick_indices(length: int, n_edge: int = 120, n_mid: int = 60) -> list[int]:
    idx = set(range(0, min(length, n_edge)))
    idx.update(range(max(0, length - n_edge), length))
    mid = length // 2
    idx.update(range(max(0, mid - n_mid // 2), min(length, mid + n_mid // 2)))
    return sorted(idx)


def run_case(y: np.ndarray, case: dict) -> dict:
    chans = case.get("channel_indices", list(range(y.shape[0])))
    yin = y[chans]
    if len(chans) == 1:
        yin = yin[0]  # exercise the (n,) input path
    out, meta = render_loop(yin, SAMPLE_RATE, case["start_s"], case["end_s"],
                            crossfade_ms=case["crossfade_ms"], snap_zero_crossing=case["snap_zero_crossing"])
    indices = pick_indices(out.shape[1])
    return {
        "start_sample": meta["start_sample"],
        "end_sample": meta["end_sample"],
        "start_s": meta["start_s"],
        "end_s": meta["end_s"],
        "crossfade_samples": meta["crossfade_samples"],
        "mode": meta["mode"],
        "snapped_start_ms": meta["snapped_start_ms"],
        "snapped_end_ms": meta["snapped_end_ms"],
        "length": int(out.shape[1]),
        "channels": int(out.shape[0]),
        "indices": indices,
        "values": [[round(float(v), OUTPUT_DECIMALS) for v in out[c, indices]] for c in range(out.shape[0])],
    }


def build() -> dict:
    y = synth_input()
    vec = {
        "version": 1,
        "generator": "scripts/gen_loop_vector.py",
        "description": ("Shared loop-render vector: stereo 110 Hz tone with a phase jump at 0.2 s plus noise, "
                        "8000 Hz, 0.6 s. Expected values come from lockedgroove.loops.render.render_loop; "
                        "web/lib/audio/renderLoop.ts must match within 1e-4."),
        "tolerance": 1e-4,
        "sample_rate": SAMPLE_RATE,
        "channels": [[float(f"{v:.{INPUT_DECIMALS}f}") for v in y[c]] for c in range(y.shape[0])],
        **PRIMARY,
        "expected": run_case(y, {**PRIMARY, "channel_indices": [0, 1]}),
        "extra_cases": [{**case, "expected": run_case(y, case)} for case in EXTRA_CASES],
    }
    return vec


def render(vec: dict) -> str:
    # compact rows for the big arrays so the file stays commit-sized
    return json.dumps(vec, separators=(",", ":")) + "\n"


def main(check: bool = False) -> int:
    text = render(build())
    if check:
        if not OUT_PATH.exists() or OUT_PATH.read_text() != text:
            print(f"stale: {OUT_PATH}")
            return 1
        print("up to date")
        return 0
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(text)
    print(f"wrote {OUT_PATH.relative_to(ROOT)} ({len(text) / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(check="--check" in sys.argv))
