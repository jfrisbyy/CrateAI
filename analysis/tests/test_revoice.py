import numpy as np
import pytest

from lockedgroove.chops.midi import Grid, MidiResult
from lockedgroove.revoice import neural
from lockedgroove.revoice.symbolic import (
    INSTRUMENTS,
    midi_for_instrument,
    midi_result_from_notes,
    render,
    render_simple,
    revoice,
)


def _melody(bpm=100.0) -> MidiResult:
    return midi_result_from_notes([
        {"pitch": 60, "start_s": 0.0, "end_s": 0.5, "velocity": 100},
        {"pitch": 64, "start_s": 0.6, "end_s": 1.1, "velocity": 90},
        {"pitch": 67, "start_s": 1.2, "end_s": 2.0, "velocity": 110},
    ], bpm)


def test_instrument_table_and_program_mapping():
    assert INSTRUMENTS["rhodes"]["program"] == 4 and INSTRUMENTS["acoustic_guitar"]["program"] == 25
    pm = midi_for_instrument(_melody(), "electric_guitar")
    assert pm.instruments[0].program == 27 and len(pm.instruments[0].notes) == 3
    with pytest.raises(ValueError):
        midi_for_instrument(_melody(), "kazoo")


def test_simple_renderer_produces_audio_of_the_right_length():
    pm = midi_for_instrument(_melody(), "rhodes")
    audio = render_simple(pm, sr=22050)
    assert audio.shape[0] == 2 and abs(audio.shape[1] / 22050 - 2.5) < 0.01
    assert np.max(np.abs(audio)) > 0.5
    # the first note is a C4: energy near 261.6 Hz in the first half second
    seg = audio[0, : 11025]
    spec = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(len(seg), 1 / 22050)
    assert abs(freqs[np.argmax(spec)] - 261.6) < 5


def test_revoice_with_prebuilt_midi_keeps_notes_editable_and_names_renderer():
    res = revoice(np.zeros(100, np.float32), 22050, "strings", bpm=100.0, midi=_melody(), out_sr=22050)
    assert res.instrument == "strings" and res.renderer in ("fluidsynth", "simple")
    assert res.midi.notes_json()[0]["pitch"] == 60
    assert res.audio.shape[0] == 2
    if res.renderer == "simple":
        assert any("preview quality" in n for n in res.notes)
    audio, renderer = render(_melody(), "rhodes", sr=22050, prefer_simple=True)
    assert renderer == "simple"


def test_keep_groove_moves_notes():
    grid = Grid.free(100.0, bars=2)
    tpl = {"bpm": 100.0, "steps_per_bar": 16, "steps": [{"step": s, "offset_ms": 20.0 if s == 4 else 0.0, "velocity": 0.8, "count": 1} for s in range(16)]}
    step = 60 / 100 / 4
    midi = midi_result_from_notes([{"pitch": 60, "start_s": 4 * step, "end_s": 4 * step + 0.2, "velocity": 100}], 100.0)
    res = revoice(np.zeros(10, np.float32), 22050, "rhodes", 100.0, keep_groove=True, groove_template=tpl, grid=grid,
                  midi=midi, out_sr=22050)
    assert abs(res.midi.notes[0].start_s - (4 * step + 0.02)) < 1e-6
    assert any("groove" in n for n in res.notes)


def test_neural_path_is_deferred_with_a_reason():
    assert not neural.is_available()
    with pytest.raises(NotImplementedError, match="symbolic"):
        neural.revoice_neural(np.zeros(10), 22050, "guitar")
