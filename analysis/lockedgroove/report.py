"""AnalysisReport: the spine of the platform.

The JSON Schema in ``docs/analysis_report.schema.json`` and the TypeScript
types in ``web/lib/types/report.ts`` are both generated from these models
(``scripts/gen_report_types.py``). ``tests/test_report_schema.py`` asserts the
three agree, so edit the models here and regenerate; never edit the schema or
the TS file by hand.

Conventions (CLAUDE.md): times are seconds as float with an ``_s`` suffix,
tempo is float BPM, key is ``{tonic, mode}`` with sharps, confidence is a float
in ``[0, 1]``. A section that has not run is ``None``.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "3.0"

FileKind = Literal["original", "stem", "chop", "loop_render", "layer_render", "revoice_render"]
Mode = Literal["major", "minor"]
Feel = Literal["straight", "swung", "loose"]
DrumSource = Literal["sampled_break", "programmed", "mixed", "unknown"]
TagSource = Literal["model", "user"]

PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Hedging bands (BUILD_PACKET section 11). Narration picks the word by band.
HEDGE_BANDS: list[tuple[float, str]] = [
    (0.8, ""),
    (0.6, "likely"),
    (0.4, "roughly"),
    (0.0, "I can't tell"),
]


def hedge_word(confidence: Optional[float]) -> str:
    """Return the hedge for a confidence value.

    >= 0.8 -> ""            (state it plainly)
    0.6-0.8 -> "likely"
    0.4-0.6 -> "roughly"
    < 0.4   -> "I can't tell"
    None    -> "not measured"
    """
    if confidence is None:
        return "not measured"
    for floor, word in HEDGE_BANDS:
        if confidence >= floor:
            return word
    return "I can't tell"


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FileInfo(_Model):
    id: Optional[str] = None
    sha256: Optional[str] = None
    original_filename: Optional[str] = None
    duration_s: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    format: Optional[str] = None
    kind: FileKind = "original"
    parent_file_id: Optional[str] = None


class Tempo(_Model):
    bpm: float
    confidence: float = Field(ge=0.0, le=1.0)
    method: str
    alternates_bpm: list[float] = Field(default_factory=list, description="[half, double]")
    notes: Optional[str] = None


class Beats(_Model):
    times_s: list[float]
    confidence: float = Field(ge=0.0, le=1.0)
    method: str
    downbeats_s: list[float] = Field(default_factory=list)
    downbeat_phase: int = 0
    downbeat_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    downbeat_method: str = ""
    meter: str = "4/4"
    notes: Optional[str] = None


class KeyAlternate(_Model):
    tonic: str
    mode: Mode
    correlation: float


class Key(_Model):
    tonic: str
    mode: Mode
    confidence: float = Field(ge=0.0, le=1.0)
    method: str
    alternate: Optional[KeyAlternate] = None
    notes: Optional[str] = None


class ChordSegment(_Model):
    start_s: float
    end_s: float
    label: str
    confidence: float = Field(ge=0.0, le=1.0)


class Chords(_Model):
    segments: list[ChordSegment]
    method: str
    notes: Optional[str] = None


class Onsets(_Model):
    times_s: list[float]
    method: str
    count: int


class TimingDeviation(_Model):
    mean: float
    std: float


class Groove(_Model):
    swing_pct: float
    timing_deviation_ms: TimingDeviation
    feel: Feel
    method: str
    confidence: float = Field(ge=0.0, le=1.0)


class Section(_Model):
    start_s: float
    end_s: float
    start_bar: int
    bars: int
    label: str
    energy: float
    confidence: float = Field(ge=0.0, le=1.0)


class Structure(_Model):
    sections: list[Section]
    loop_period_bars: Optional[int] = None
    loop_period_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    method: str
    notes: Optional[str] = None


class DrumHit(_Model):
    """One position of a per-section drum pattern on a 16th grid.

    ``step`` is 0..15 within the bar. ``frequency`` is the fraction of bars in
    the section where a hit lands on this step. ``velocity`` is the mean
    normalized hit strength. ``offset_ms`` is the mean measured offset from the
    grid; positive is late. Offsets are what make the MIDI export keep the feel.
    """

    step: int = Field(ge=0)
    velocity: float = Field(ge=0.0, le=1.0)
    frequency: float = Field(ge=0.0, le=1.0)
    offset_ms: float = 0.0


class DrumPattern(_Model):
    section_index: int
    kick: list[DrumHit] = Field(default_factory=list)
    snare: list[DrumHit] = Field(default_factory=list)
    hat: list[DrumHit] = Field(default_factory=list)
    other: list[DrumHit] = Field(default_factory=list)
    accents: list[int] = Field(default_factory=list, description="steps carrying accents")
    density_per_bar: float = 0.0
    hat_open_ratio: Optional[float] = None
    ghost_notes: list[int] = Field(default_factory=list, description="snare steps with low velocity")


class Drums(_Model):
    source_estimate: DrumSource
    source_confidence: float = Field(ge=0.0, le=1.0)
    patterns: list[DrumPattern]
    layered_kick: Optional[bool] = None
    method: str
    notes: Optional[str] = None


class SampleUse(_Model):
    is_loop_based: Optional[bool] = None
    chop_count_estimate: Optional[int] = None
    chop_reordering_detected: Optional[bool] = None
    chop_order: list[int] = Field(default_factory=list)
    pitch_shift_semitones_estimate: Optional[float] = None
    pitch_shift_source_file_id: Optional[str] = None
    sample_bars: list[int] = Field(default_factory=list, description="bars where the sample is present")
    confidence: float = Field(ge=0.0, le=1.0)
    method: str
    notes: Optional[str] = None


class InstrumentEvent(_Model):
    instrument: str
    bar: int


class InstrumentationSection(_Model):
    section_index: int
    present: list[str]
    entries: list[InstrumentEvent] = Field(default_factory=list)
    exits: list[InstrumentEvent] = Field(default_factory=list)


class Instrumentation(_Model):
    per_section: list[InstrumentationSection]
    method: str
    confidence: float = Field(ge=0.0, le=1.0)


class Loudness(_Model):
    integrated_lufs: float
    true_peak_dbtp: float
    loudness_range_lu: float
    method: str


class Estimate(_Model):
    value: Optional[float] = None
    confidence: float = Field(ge=0.0, le=1.0)
    method: str
    notes: Optional[str] = None


class Spectral(_Model):
    centroid_hz_mean: float
    stereo_width: float
    low_high_ratio_db: float
    method: str
    bandwidth: Optional[Estimate] = None
    """Highest frequency still carrying real energy, in Hz: what the file actually has.

    An ``Estimate`` because unlike the other three it is not deterministic - a
    lossy encoder's lowpass reads with high confidence, a natural rolloff with
    less, and a signal measured on a resampled working copy cannot be trusted at
    all. ``None`` when it was not measured."""


class SidechainEstimate(_Model):
    detected: bool
    depth_db: Optional[float] = None
    confidence: float = Field(ge=0.0, le=1.0)
    method: str


class EffectsEstimates(_Model):
    reverb_tail_s: Estimate
    sidechain_ducking: SidechainEstimate
    saturation_above_hz: Estimate


class Tag(_Model):
    tag: str
    confidence: float = Field(ge=0.0, le=1.0)
    source: TagSource = "model"


class KeyEdit(_Model):
    tonic: str
    mode: Mode


class UserEdits(_Model):
    tempo_bpm: Optional[float] = None
    downbeat_phase: Optional[int] = None
    first_downbeat_s: Optional[float] = None
    key: Optional[KeyEdit] = None
    meter: Optional[str] = None
    section_labels: Optional[dict[str, str]] = Field(
        default=None, description="section index (as a string) -> label"
    )
    edited_at: Optional[str] = None


class Pending(_Model):
    """Present only while the report is still being written.

    A report is published stage by stage now (``pipeline.analyze_array``'s
    ``on_partial``), so a producer sees a real tempo at twenty seconds instead
    of a step name. That makes a new kind of mistake possible: something
    downstream reading a half-written report as if it were everything we know,
    and saying "no key was measured" about a stage that has not run yet.

    So a report under construction says so, in the report, and the rule is
    exactly one line: **``pending`` is set while it is partial and ``None``
    when it is finished.** Absence means complete, which keeps every reader
    written before this field existed correct about a finished report; and a
    partial is only ever stored while ``files.status = 'analyzing'``, so a
    reader that never learns about this field still has the row's status to go
    on. ``effective()`` carries it through untouched, and
    ``web/lib/report/effective.ts`` mirrors both halves.

    ``done`` and ``stages`` are the report's own field names, so a reader can
    say *which* measurement is still coming rather than only that one is.
    """

    stages: list[str] = Field(default_factory=list, description="report fields that have not run yet")
    done: list[str] = Field(default_factory=list, description="report fields that have run and are in this report")
    fraction: float = Field(default=0.0, ge=0.0, le=1.0, description="stages done / stages asked for")


class AnalysisReport(_Model):
    schema_version: Literal["3.0"] = SCHEMA_VERSION
    analysis_version: int = 0
    file: FileInfo = Field(default_factory=FileInfo)
    tempo: Optional[Tempo] = None
    beats: Optional[Beats] = None
    key: Optional[Key] = None
    chords: Optional[Chords] = None
    onsets: Optional[Onsets] = None
    groove: Optional[Groove] = None
    structure: Optional[Structure] = None
    drums: Optional[Drums] = None
    sample_use: Optional[SampleUse] = None
    instrumentation: Optional[Instrumentation] = None
    loudness: Optional[Loudness] = None
    spectral: Optional[Spectral] = None
    effects_estimates: Optional[EffectsEstimates] = None
    tags: list[Tag] = Field(default_factory=list)
    user_edits: UserEdits = Field(default_factory=UserEdits)
    pending: Optional[Pending] = Field(
        default=None,
        description="set while the analysis is still running; None on a finished report (see Pending)",
    )

    @classmethod
    def empty(cls, file: Optional[FileInfo] = None, analysis_version: int = 0) -> "AnalysisReport":
        return cls(file=file or FileInfo(), analysis_version=analysis_version)

    def to_json_dict(self) -> dict:
        return self.model_dump(mode="json")


def _shift_downbeats(beats: Beats, phase: int, first_downbeat_s: Optional[float]) -> list[float]:
    times = beats.times_s
    if not times:
        return []
    beats_per_bar = _beats_per_bar(beats.meter)
    if first_downbeat_s is not None:
        # nearest beat to the user's click becomes the anchor
        idx = min(range(len(times)), key=lambda i: abs(times[i] - first_downbeat_s))
        phase = idx % beats_per_bar
    return [t for i, t in enumerate(times) if i % beats_per_bar == phase]


def _beats_per_bar(meter: str) -> int:
    try:
        num, den = meter.split("/")
        num_i, den_i = int(num), int(den)
    except (ValueError, AttributeError):
        return 4
    if den_i == 8 and num_i % 3 == 0:
        return max(1, num_i // 3)  # 6/8 -> 2 dotted-quarter beats per bar
    return max(1, num_i)


def is_partial(report: "AnalysisReport | Mapping[str, object] | None") -> bool:
    """True while a report is still being written (see ``Pending``).

    Takes either the model or the raw jsonb straight out of ``files.report``,
    because half the readers have one and half have the other, and the answer
    must not depend on which. ``None``, and anything that is not a report, is
    not partial: an absent report is a different thing from an unfinished one
    and the caller already has to handle it.
    """
    if report is None:
        return False
    if isinstance(report, AnalysisReport):
        return report.pending is not None
    if isinstance(report, Mapping):
        return report.get("pending") is not None
    return False


def effective(report: AnalysisReport) -> AnalysisReport:
    """Resolve ``user_edits`` over analyzed values (principle 7).

    Every consumer reads the effective report, never the raw one. The returned
    object is a deep copy; the stored report keeps the prediction so the
    correction can be logged against it.

    A partial report stays partial: ``pending`` is copied through untouched, so
    ``is_partial(effective(r)) == is_partial(r)``. Resolving a correction over
    what has been measured so far is right — the correction wins whenever the
    measurement lands — but nothing here may make a half-written report look
    finished.
    """
    out = copy.deepcopy(report)
    edits = report.user_edits
    if edits.tempo_bpm is not None and out.tempo is not None:
        ratio = edits.tempo_bpm / out.tempo.bpm if out.tempo.bpm else 1.0
        out.tempo.bpm = edits.tempo_bpm
        out.tempo.confidence = 1.0
        out.tempo.method = "user"
        out.tempo.alternates_bpm = [edits.tempo_bpm / 2, edits.tempo_bpm * 2]
        # A halve/double edit keeps the beat grid consistent with the new tempo.
        if out.beats is not None and ratio and abs(ratio - round(ratio)) < 1e-6 and round(ratio) in (2, 4):
            out.beats.times_s = _subdivide(out.beats.times_s, int(round(ratio)))
        elif out.beats is not None and ratio and abs(1 / ratio - round(1 / ratio)) < 1e-6 and round(1 / ratio) in (2, 4):
            out.beats.times_s = out.beats.times_s[:: int(round(1 / ratio))]
    elif edits.tempo_bpm is not None and out.tempo is None:
        out.tempo = Tempo(bpm=edits.tempo_bpm, confidence=1.0, method="user",
                          alternates_bpm=[edits.tempo_bpm / 2, edits.tempo_bpm * 2])
    if out.beats is not None:
        if edits.meter is not None:
            out.beats.meter = edits.meter
        if edits.downbeat_phase is not None or edits.first_downbeat_s is not None or edits.meter is not None:
            phase = edits.downbeat_phase if edits.downbeat_phase is not None else out.beats.downbeat_phase
            out.beats.downbeats_s = _shift_downbeats(out.beats, phase, edits.first_downbeat_s)
            if out.beats.downbeats_s:
                # recover the phase actually used (first_downbeat_s may override)
                first = out.beats.downbeats_s[0]
                out.beats.downbeat_phase = out.beats.times_s.index(first) % _beats_per_bar(out.beats.meter)
            out.beats.downbeat_confidence = 1.0
            out.beats.downbeat_method = "user"
    if edits.key is not None:
        if out.key is None:
            out.key = Key(tonic=edits.key.tonic, mode=edits.key.mode, confidence=1.0, method="user")
        else:
            out.key.tonic = edits.key.tonic
            out.key.mode = edits.key.mode
            out.key.confidence = 1.0
            out.key.method = "user"
            out.key.alternate = None
    if edits.section_labels and out.structure is not None:
        for idx_str, label in edits.section_labels.items():
            try:
                idx = int(idx_str)
            except ValueError:
                continue
            if 0 <= idx < len(out.structure.sections):
                out.structure.sections[idx].label = label
                out.structure.sections[idx].confidence = 1.0
    return out


def _subdivide(times: list[float], factor: int) -> list[float]:
    if len(times) < 2:
        return list(times)
    out: list[float] = []
    for a, b in zip(times[:-1], times[1:]):
        step = (b - a) / factor
        out.extend(a + k * step for k in range(factor))
    out.append(times[-1])
    return out


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def key_name(tonic: str, mode: Mode) -> str:
    return f"{tonic} {mode}"


def json_schema() -> dict:
    """JSON Schema (draft 2020-12) for the report, as committed in docs/."""
    schema = AnalysisReport.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = "https://crateai.app/schemas/analysis_report.schema.json"
    schema["title"] = "AnalysisReport"
    return schema


__all__ = [
    "AnalysisReport", "Beats", "ChordSegment", "Chords", "DrumHit", "DrumPattern", "Drums",
    "EffectsEstimates", "Estimate", "FileInfo", "Groove", "Instrumentation",
    "InstrumentationSection", "InstrumentEvent", "Key", "KeyAlternate", "KeyEdit", "Loudness",
    "Onsets", "PITCH_CLASSES", "Pending", "SampleUse", "Section", "SidechainEstimate", "Spectral",
    "Structure", "Tag", "Tempo", "TimingDeviation", "UserEdits", "effective", "hedge_word",
    "is_partial", "json_schema", "key_name", "now_iso", "SCHEMA_VERSION",
]
