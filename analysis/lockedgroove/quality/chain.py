"""The end-to-end quality check: source -> separation -> stretch, measured at each step.

This is the measurement that found the bug. A producer said three layered
results sounded muddy; running the chain on the same source showed where it went:

    source as uploaded            8-20 kHz at -19.5 dB
    after a weak separator                  -37.1 dB     <- 17.6 dB gone, ours
    after a reference separator             -19.5 dB     <- untouched

Nothing after the separation could have recovered it. So the chain is checked
against a **budget** at every stage and a violation is loud: the script exits
non-zero and the test fails.

The budgets are deliberately wide. A real separator moves the 8-20 kHz ratio by
a decibel or two depending on what it pulled out of the mix, and that is not a
defect; 17.6 dB is. The budget's job is to catch a class of change - swapping in
a cheaper model, dropping an engine, adding a resample nobody noticed - not to
police normal variation.

Two things this cannot decide on synthetic fixtures, and they are in the handoff:
whether a given separator's published SDR is real, and whether the result sounds
good. Both need a real record and real hardware.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ..stems.separate import (
    DEFAULT_STEMS,
    FakeSeparator,
    Separator,
    backend_available_models,
    resolve_model,
    separate_file,
)
from .bandwidth import Bandwidth, measure_bandwidth
from .metrics import StageLoss, air_db, detect_onsets_s, measure_stage, to_mono

SOURCE_STAGE = "source"
SEPARATION_STAGE = "separation"
SEPARATION_SUM_STAGE = "separation:sum"
STRETCH_STAGE = "stretch"


@dataclass(frozen=True)
class Budget:
    """What a stage is allowed to cost. ``air`` is a magnitude: fizz is as bad as dullness."""

    max_air_loss_db: float
    min_transient_retention: float

    def violations(self, loss: StageLoss) -> list[str]:
        out = []
        if loss.air_loss_db > self.max_air_loss_db:
            out.append(f"{loss.stage}: 8-20 kHz moved {loss.air_delta_db:+.2f} dB "
                       f"(budget {self.max_air_loss_db:.2f} dB)")
        if loss.transient_retention < self.min_transient_retention:
            out.append(f"{loss.stage}: transients down to {loss.transient_retention:.3f} of the source "
                       f"(budget {self.min_transient_retention:.3f})")
        return out


DEFAULT_BUDGETS: dict[str, Budget] = {
    # A separator legitimately changes one stem's balance; 6 dB is far above what
    # a good one costs and far below the 17.6 dB a weak one did.
    SEPARATION_STAGE: Budget(max_air_loss_db=6.0, min_transient_retention=0.35),
    # The stems summed back together should be close to the source. A separator
    # that lowpasses everything it touches shows up here even if no single stem does.
    SEPARATION_SUM_STAGE: Budget(max_air_loss_db=3.0, min_transient_retention=0.60),
    # A stretcher has no business touching the spectrum at all.
    STRETCH_STAGE: Budget(max_air_loss_db=1.0, min_transient_retention=0.60),
}


@dataclass
class ChainReport:
    sr: int
    source_air_db: float
    bandwidth: Bandwidth
    stages: list[StageLoss] = field(default_factory=list)
    budgets: dict[str, Budget] = field(default_factory=lambda: dict(DEFAULT_BUDGETS))
    context: dict = field(default_factory=dict)

    def budget_for(self, stage: str) -> Optional[Budget]:
        return self.budgets.get(stage) or self.budgets.get(stage.split(":")[0])

    def failures(self) -> list[str]:
        out: list[str] = []
        for loss in self.stages:
            budget = self.budget_for(loss.stage)
            if budget is not None:
                out.extend(budget.violations(loss))
        return out

    @property
    def ok(self) -> bool:
        return not self.failures()

    def to_json(self) -> dict:
        return {"sample_rate": self.sr, "source_air_db": round(self.source_air_db, 2),
                "bandwidth": self.bandwidth.to_json(), "stages": [s.to_json() for s in self.stages],
                "failures": self.failures(), "context": self.context}

    def table(self) -> str:
        width = max([len(s.stage) for s in self.stages] + [len(SOURCE_STAGE)])
        lines = [f"{'stage'.ljust(width)}   8-20 kHz    delta   transients   note",
                 f"{SOURCE_STAGE.ljust(width)}   {self.source_air_db:+7.2f} dB        -        -     "
                 f"bandwidth {_bandwidth_text(self.bandwidth)}"]
        for s in self.stages:
            lines.append(f"{s.stage.ljust(width)}   {s.air_db_after:+7.2f} dB  {s.air_delta_db:+7.2f}  "
                         f"{s.transient_retention:9.3f}   {s.note}")
        for failure in self.failures():
            lines.append(f"FAIL  {failure}")
        return "\n".join(lines)


def _bandwidth_text(bw: Bandwidth) -> str:
    if bw.hz is None:
        return "not measured"
    return f"{bw.hz / 1000:.1f} kHz (confidence {bw.confidence:.2f})"


def _sum_stems(stems) -> tuple[np.ndarray, int]:
    sr = stems[0].sr
    length = min(int(s.y.shape[-1]) for s in stems)
    return np.sum([to_mono(s.y)[:length] for s in stems], axis=0), sr


def run_chain(path: str, *, backend: Optional[Separator] = None, model: Optional[str] = None,
              stems_wanted: Sequence[str] = DEFAULT_STEMS, stem: str = "other", ratio: float = 0.83,
              semitones: float = 0.0, engine: Optional[str] = None,
              budgets: Optional[dict[str, Budget]] = None) -> ChainReport:
    """Separate ``path``, stretch one stem, and measure what each step cost.

    ``backend`` defaults to the band-split stand-in so this runs without a GPU;
    hand it a real separator to measure a real one. The stand-in is not a
    separation model and its numbers say nothing about one - what the default
    exercises is the *harness*.
    """
    from ..combine.align import stretch_and_shift, stretch_engine
    from ..ingest import load_audio

    backend = backend if backend is not None else FakeSeparator()
    source, sr = load_audio(path, mono=False)
    source = np.asarray(source, dtype=np.float32)
    mono = to_mono(source)
    onsets = detect_onsets_s(mono, sr)

    choice = resolve_model(model, stems_wanted, backend_available_models(backend),
                           stand_in=isinstance(backend, FakeSeparator))
    stems = separate_file(path, choice.model, backend)
    by_name = {s.name: s for s in stems}
    if stem not in by_name:
        stem = stems[0].name
    stem_audio = by_name[stem]
    stem_mono = to_mono(stem_audio.y)
    stem_sr = int(stem_audio.sr)

    report = ChainReport(sr=sr, source_air_db=air_db(mono, sr), bandwidth=measure_bandwidth(mono, sr),
                         budgets=dict(budgets or DEFAULT_BUDGETS),
                         context={"model": choice.quality.to_json(), "model_reason": choice.reason,
                                  "stem": stem, "ratio": ratio, "semitones": semitones,
                                  "engine": stretch_engine(engine)})

    summed, sum_sr = _sum_stems(stems)
    report.stages.append(measure_stage(SEPARATION_SUM_STAGE, mono, summed, sum_sr, 1.0, onsets,
                                       note="every stem added back together"))
    report.stages.append(measure_stage(f"{SEPARATION_STAGE}:{stem}", mono, stem_mono, stem_sr, 1.0, onsets,
                                       note=f"{choice.quality.tier} tier, {choice.quality.model}"))

    stretched = stretch_and_shift(stem_mono, stem_sr, ratio, semitones, engine=engine)
    report.stages.append(measure_stage(STRETCH_STAGE, stem_mono, to_mono(stretched), stem_sr, ratio,
                                       note=f"×{ratio:g}, {semitones:+g} st, {report.context['engine']}",
                                       band_scale=2.0 ** (semitones / 12.0)))
    return report


__all__ = ["Budget", "ChainReport", "DEFAULT_BUDGETS", "SEPARATION_STAGE", "SEPARATION_SUM_STAGE",
           "SOURCE_STAGE", "STRETCH_STAGE", "run_chain"]
