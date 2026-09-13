import io
import zipfile

import numpy as np
import pytest

from lockedgroove.chops.chop import chop_filename, chop_grid, chop_manual, chop_transients, extract
from lockedgroove.chops.midi import (
    Grid, Hit, apply_groove, bundle_zip, chord_label_to_pitches, chords_midi, drum_midi, groove_midi, groove_template,
)
from lockedgroove.testing.synth import Pattern, drum_loop, silence

SR = 22050


def test_transient_chops_find_the_hits():
    # 8 kicks, one per 8th note at 120 BPM (0.25 s apart), 2 seconds
    pat = Pattern(kick={0: 1.0, 2: 1.0, 4: 1.0, 6: 1.0, 8: 1.0, 10: 1.0, 12: 1.0, 14: 1.0})
    y = drum_loop(120, 1, pat, SR)
    segs = chop_transients(y, SR)
    assert len(segs) == 8
    for i, s in enumerate(segs):
        assert abs(s.start_s - i * 0.25) < 0.05
        assert s.index == i
    capped = chop_transients(y, SR, count=4)
    assert len(capped) == 4 and capped == sorted(capped, key=lambda s: s.start_s)


def test_transient_min_gap_merges_close_onsets():
    y = drum_loop(120, 1, Pattern(kick={0: 1.0, 4: 1.0}), SR)
    onsets = [0.0, 0.01, 1.0, 1.02]  # pairs closer than 40 ms collapse
    segs = chop_transients(y, SR, onsets_s=onsets, min_gap_ms=40)
    assert len(segs) == 2


def test_grid_chops_equal_slices():
    bars = [0.0, 2.0, 4.0, 6.0]
    segs = chop_grid(bars, 0, 3, 4)
    assert len(segs) == 16
    assert all(abs(s.duration_s - 0.5) < 1e-9 for s in segs)
    assert segs[0].name == "bar 1.1" and segs[-1].name == "bar 4.4"
    # a bar past the last downbeat uses the median bar length
    segs2 = chop_grid(bars, 3, 4, 2)
    assert abs(segs2[-1].end_s - 10.0) < 1e-9


def test_manual_chops():
    segs = chop_manual([1.5, 0.5, 3.0, -1.0, 10.0], end_s=4.0)
    assert [(s.start_s, s.end_s) for s in segs] == [(0.5, 1.5), (1.5, 3.0), (3.0, 4.0)]


def test_extract_applies_fades_and_keeps_channels():
    y = np.ones((2, SR), dtype=np.float32)
    seg = chop_manual([0.0], end_s=0.5)[0]
    out = extract(y, SR, seg, fade_ms=3.0)
    assert out.shape == (2, int(0.5 * SR))
    assert out[0, 0] == 0.0 and out[0, -1] == 0.0 and out[0, SR // 4] == 1.0
    assert chop_filename("My Loop", seg) == "My-Loop_chop01.wav"


def test_drum_midi_preserves_measured_offsets():
    grid = Grid.free(90.0, bars=2)
    step = 60.0 / 90 / 4
    hits = [Hit(0.0, "kick", 1.0), Hit(4 * step + 0.012, "snare", 0.8), Hit(10 * step - 0.008, "kick", 0.9),
            Hit(2 * step, "hat", 0.5)]
    res = drum_midi(hits, grid)
    assert res.kind == "drums" and len(res.notes) == 4
    snare = next(n for n in res.notes if n.cls == "snare")
    assert snare.pitch == 38 and abs(snare.start_s - (4 * step + 0.012)) < 1e-9
    assert snare.step == 4 and abs(snare.offset_ms - 12.0) < 1e-6
    late_kick = next(n for n in res.notes if n.cls == "kick" and n.step == 10)
    assert abs(late_kick.offset_ms + 8.0) < 1e-6
    data = res.to_bytes()
    assert data[:4] == b"MThd"
    q = drum_midi(hits, grid, quantize=True)
    assert all(n.offset_ms == 0.0 for n in q.notes)
    assert abs(next(n for n in q.notes if n.cls == "snare").start_s - 4 * step) < 1e-9


def test_chords_midi_and_labels():
    assert chord_label_to_pitches("F:min", 4) == [65, 68, 72]
    assert chord_label_to_pitches("Bb", 4) == [70, 74, 77]
    assert chord_label_to_pitches("C#m", 3) == [49, 52, 56]
    assert chord_label_to_pitches("N") == []
    res = chords_midi([{"start_s": 0, "end_s": 2, "label": "F:min", "confidence": 0.8},
                       {"start_s": 2, "end_s": 4, "label": "N", "confidence": 0.1}], 90.0)
    assert len(res.notes) == 3 and all(n.end_s == 2.0 for n in res.notes)


def test_groove_template_and_apply():
    grid = Grid.free(100.0, bars=4)
    step = 60.0 / 100 / 4
    hits = []
    for bar in range(4):
        base = bar * 16 * step
        hits += [Hit(base + s * step + (0.02 if s % 4 == 2 else 0.0), "hat", 0.6) for s in range(0, 16, 2)]
    tpl = groove_template(hits, grid)
    off = {t["step"]: t["offset_ms"] for t in tpl["steps"]}
    assert abs(off[2] - 20.0) < 1e-6 and abs(off[0]) < 1e-6
    assert tpl["swing_pct"] > 52  # late off-8ths read as swing
    gm = groove_midi(tpl, bars=1)
    assert len(gm.notes) == 16
    straight = drum_midi([Hit(2 * step, "kick", 1.0)], grid)
    moved = apply_groove(straight, tpl, grid)
    assert abs(moved.notes[0].start_s - (2 * step + 0.02)) < 1e-6


def test_bundle_zip_has_manifest():
    data = bundle_zip({"a.wav": b"RIFF", "kit.mid": b"MThd"}, {"bpm": 90})
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = set(z.namelist())
        assert names == {"a.wav", "kit.mid", "manifest.json"}


def test_melody_requires_basic_pitch():
    pytest.importorskip("basic_pitch")
