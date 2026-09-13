import numpy as np

from lockedgroove.beatbox.features import detect_onsets, hit_features
from lockedgroove.beatbox.train import Example, examples_from_recording, train
from lockedgroove.beatbox.transcribe import step_view, transcribe
from lockedgroove.chops.midi import Grid
from lockedgroove.testing.synth import hat, kick, silence, snare

SR = 22050


def _examples(n=20, seed=0):
    """Enrollment the way the app does it: one recording per class, segmented at onsets."""
    rng = np.random.default_rng(seed)
    ex = []
    for cls in ("kick", "snare", "hat"):
        y = silence(0.4 * n + 0.5, SR)
        for i in range(n):
            if cls == "kick":
                smp = kick(SR, f_start=150 * (1 + rng.uniform(-0.15, 0.15)), decay_s=0.09 * (1 + rng.uniform(-0.3, 0.3)),
                           brightness=rng.uniform(0, 0.15))
            elif cls == "snare":
                smp = snare(SR, tone_hz=185 * (1 + rng.uniform(-0.15, 0.15)), noise_mix=rng.uniform(0.5, 0.9),
                            seed=int(rng.integers(1e6)))
            else:
                smp = hat(SR, seed=int(rng.integers(1e6)), amplitude=rng.uniform(0.3, 0.7))
            j = int(round(i * 0.4 * SR))
            y[j:j + len(smp)] += smp
        ex += examples_from_recording(cls, np.clip(y, -1, 1), SR)
    return ex


def _recording(events, sr=SR, seed=0):
    rng = np.random.default_rng(seed)
    total = max(t for t, _ in events) + 0.5
    y = silence(total, sr)
    for t, cls in events:
        smp = {"kick": lambda: kick(sr, brightness=rng.uniform(0, 0.1)),
               "snare": lambda: snare(sr, seed=int(rng.integers(1e6))),
               "hat": lambda: hat(sr, seed=int(rng.integers(1e6)))}[cls]()
        i = int(round(t * sr))
        seg = smp[: len(y) - i]
        y[i:i + len(seg)] += seg
    return np.clip(y, -1, 1)


def test_features_shape_and_class_separation():
    fk, fs, fh = hit_features(kick(SR), SR), hit_features(snare(SR), SR), hit_features(hat(SR), SR)
    assert fk.shape == fs.shape == fh.shape == (33,)
    # low-band ratio orders kick > snare > hat; centroid orders the other way
    assert fk[28] > fs[28] > fh[28]
    assert fk[26] < fs[26] < fh[26]


def test_enrollment_trains_and_reports_cv_accuracy():
    res = train(_examples(20))
    assert res.classes == ["hat", "kick", "snare"]
    assert res.sample_count == 60
    assert res.cv_accuracy >= 0.85 and res.enabled, res.message
    assert res.model_bytes[:2] == b"\x80" or len(res.model_bytes) > 1000


def test_enrollment_refuses_with_too_few_examples():
    res = train(_examples(3))
    assert not res.enabled and res.model_bytes == b"" and "at least" in res.message


def test_examples_from_recording_segments_each_hit():
    y = _recording([(0.0, "kick"), (0.5, "kick"), (1.0, "kick"), (1.5, "kick")])
    ex = examples_from_recording("kick", y, SR)
    assert len(ex) == 4 and all(e.cls == "kick" for e in ex)


def test_transcription_recovers_pattern_with_offsets():
    model = train(_examples(20)).model_bytes
    bpm = 100.0
    step = 60.0 / bpm / 4
    events = []
    for bar in range(2):
        base = bar * 16 * step
        events += [(base + 0 * step, "kick"), (base + 4 * step + 0.015, "snare"), (base + 10 * step, "kick"),
                   (base + 12 * step - 0.010, "snare")]
        events += [(base + s * step, "hat") for s in (2, 6, 14)]
    y = _recording(sorted(events))
    hits, midi = transcribe(y, SR, model, grid=Grid.free(bpm, bars=3))
    assert len(hits) == len(events)
    classes = [h.cls for h in sorted(hits, key=lambda h: h.time_s)]
    truth = [c for _, c in sorted(events)]
    agreement = np.mean([a == b for a, b in zip(classes, truth)])
    assert agreement >= 0.85, list(zip(classes, truth))
    snare_hits = [h for h in hits if h.cls == "snare" and h.step == 4]
    assert snare_hits and abs(snare_hits[0].offset_ms - 15.0) < 12.0
    assert midi.kind == "drums" and len(midi.notes) == len(hits)
    view = step_view(hits)
    assert view[0]["bar"] == 0 and len(view[0]["steps"]) == 16
    assert any(cell["hits"] for cell in view[0]["steps"])


def test_free_grid_uses_first_hit_as_the_one():
    model = train(_examples(12, seed=3)).model_bytes
    y = _recording([(0.3, "kick"), (0.9, "snare"), (1.5, "kick"), (2.1, "snare")])
    hits, _ = transcribe(y, SR, model, bpm=100.0)
    first = min(hits, key=lambda h: h.time_s)
    assert first.bar == 0 and first.step == 0 and abs(first.offset_ms) < 1.0
    assert len(detect_onsets(y, SR)) == 4
