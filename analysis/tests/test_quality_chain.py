"""quality/chain.py: the end-to-end check, and proof that it still sees the original bug.

The chain is only worth having if it fails when something gets lossier. So one
test runs it on a healthy path and one runs it on a separator that lowpasses
what it returns - the exact shape of the failure that made three layered results
sound muddy - and insists the harness catches it.
"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from lockedgroove.quality.chain import (
    DEFAULT_BUDGETS,
    SEPARATION_STAGE,
    STRETCH_STAGE,
    Budget,
    run_chain,
)
from lockedgroove.quality.fixtures import lossy_copy, transient_bed
from lockedgroove.stems.separate import FakeSeparator, StemAudio

SR = 44100
WEAK_SEPARATOR_CUTOFF_HZ = 8000.0


@pytest.fixture(scope="module")
def source(tmp_path_factory):
    y, _ = transient_bed(SR)
    path = tmp_path_factory.mktemp("chain") / "source.wav"
    sf.write(path, np.stack([y, y]).T, SR)
    return str(path)


class LowpassingSeparator(FakeSeparator):
    """A stand-in that dulls everything it returns: the bug, reproduced on demand."""

    def __init__(self, cutoff_hz: float = WEAK_SEPARATOR_CUTOFF_HZ):
        self.cutoff_hz = cutoff_hz

    def separate(self, path: str, model: str) -> list[StemAudio]:
        out = []
        for stem in super().separate(path, model):
            dulled = np.stack([lossy_copy(ch, stem.sr, self.cutoff_hz) for ch in stem.y])
            out.append(StemAudio(name=stem.name, y=dulled.astype(np.float32), sr=stem.sr))
        return out


def test_a_healthy_chain_stays_inside_its_budget(source):
    report = run_chain(source, stem="other", ratio=0.83)
    assert report.ok, report.table()
    assert report.bandwidth.hz is not None
    assert [s.stage for s in report.stages][-1] == STRETCH_STAGE
    assert report.context["model"]["is_stand_in"] is True
    assert "stand_in" in report.to_json()["context"]["model"]["model_tier"]


def test_the_harness_catches_a_separator_that_throws_away_the_top_end(source):
    """This is the regression the whole module exists for: 17.6 dB, gone, unrecoverable."""
    report = run_chain(source, backend=LowpassingSeparator(), stem="other", ratio=0.83)
    assert not report.ok
    failures = " ".join(report.failures())
    assert "8-20 kHz" in failures
    separation = [s for s in report.stages if s.stage.startswith(SEPARATION_STAGE)][0]
    assert separation.air_delta_db < -10.0
    assert "FAIL" in report.table()


def test_the_summed_stems_catch_it_even_when_one_stem_would_not(source):
    report = run_chain(source, backend=LowpassingSeparator(), stem="bass", ratio=0.83)
    summed = [s for s in report.stages if s.stage == "separation:sum"][0]
    assert summed.air_delta_db < -10.0
    assert not report.ok


def test_a_pitch_shift_is_not_counted_as_damage(source):
    """Transposing up genuinely moves energy into the air band; the budget follows it."""
    report = run_chain(source, stem="other", ratio=0.83, semitones=6.0)
    stretch = [s for s in report.stages if s.stage == STRETCH_STAGE][0]
    assert abs(stretch.air_delta_db) < DEFAULT_BUDGETS[STRETCH_STAGE].max_air_loss_db


def test_budgets_can_be_tightened_and_then_bite(source):
    strict = dict(DEFAULT_BUDGETS)
    strict[STRETCH_STAGE] = Budget(max_air_loss_db=0.0001, min_transient_retention=0.99)
    report = run_chain(source, stem="other", ratio=0.83, budgets=strict)
    assert not report.ok
    assert any(STRETCH_STAGE in f for f in report.failures())


def test_the_report_serialises_everything_a_claim_would_need(source):
    data = run_chain(source, stem="drums", ratio=0.73).to_json()
    assert set(data) >= {"sample_rate", "source_air_db", "bandwidth", "stages", "failures", "context"}
    assert data["bandwidth"]["method"]
    assert data["context"]["model"]["model_tier"]
    assert data["context"]["engine"]
    for stage in data["stages"]:
        assert {"stage", "air_db_before", "air_db_after", "air_delta_db", "transient_retention"} <= set(stage)
