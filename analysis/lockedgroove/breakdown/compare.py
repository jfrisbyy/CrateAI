"""Compare two files: same breakdown structure, side by side, with deltas.

The most valuable form is "my beat vs the reference": the deltas are worded
from A's point of view ("mine") against B ("the reference"). Every delta names
its report source and carries the lower of the two confidences.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..report import AnalysisReport, effective, hedge_word
from .words import bpm_text, key_display

PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


class Delta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section: Literal["vitals", "structure", "sample", "drums", "bass", "harmony", "mix"]
    metric: str
    a: Any = None
    b: Any = None
    delta: Optional[float] = None
    unit: str = ""
    text: str
    confidence: Optional[float] = None
    hedge: str = ""
    source: str


class ComparisonContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"] = "1.0"
    file_a_id: Optional[str] = None
    file_b_id: Optional[str] = None
    a_name: str = "mine"
    b_name: str = "the reference"
    generated_at: str = ""
    deltas: list[Delta] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)

    def for_section(self, section: str) -> list[Delta]:
        return [d for d in self.deltas if d.section == section]


def _min_conf(*vals: Optional[float]) -> Optional[float]:
    present = [v for v in vals if v is not None]
    return min(present) if present else None


def _key_relation(a: AnalysisReport, b: AnalysisReport) -> tuple[str, int]:
    ta, tb = PITCH.index(a.key.tonic), PITCH.index(b.key.tonic)
    if (a.key.tonic, a.key.mode) == (b.key.tonic, b.key.mode):
        return "same", 0
    if a.key.mode != b.key.mode:
        # relative: minor tonic is 3 semitones below its relative major
        if a.key.mode == "minor" and (ta + 3) % 12 == tb:
            return "relative", 0
        if a.key.mode == "major" and (tb + 3) % 12 == ta:
            return "relative", 0
        if ta == tb:
            return "parallel", 0
    dist = (tb - ta) % 12
    if dist > 6:
        dist -= 12
    return "different", dist


def compare(report_a: AnalysisReport, report_b: AnalysisReport,
            stems_a: Optional[dict[str, AnalysisReport]] = None,
            stems_b: Optional[dict[str, AnalysisReport]] = None,
            a_name: str = "mine", b_name: str = "the reference") -> ComparisonContent:
    a, b = effective(report_a), effective(report_b)
    sa = {k: effective(v) for k, v in (stems_a or {}).items()}
    sb = {k: effective(v) for k, v in (stems_b or {}).items()}
    out = ComparisonContent(file_a_id=report_a.file.id, file_b_id=report_b.file.id, a_name=a_name, b_name=b_name,
                            generated_at=datetime.now(UTC).isoformat())
    A = a_name.capitalize() if a_name != "mine" else "Mine"
    B = b_name

    def add(section, metric, text, source, av=None, bv=None, delta=None, unit="", conf=None):
        out.deltas.append(Delta(section=section, metric=metric, a=av, b=bv, delta=delta, unit=unit, text=text,
                                confidence=conf, hedge=hedge_word(conf) if conf is not None else "", source=source))

    # vitals
    if a.tempo and b.tempo:
        d = a.tempo.bpm - b.tempo.bpm
        add("vitals", "tempo_bpm", f"{A} runs at {bpm_text(a.tempo.bpm)} BPM, {B} at {bpm_text(b.tempo.bpm)} BPM ({d:+.1f}).",
            "tempo.bpm", a.tempo.bpm, b.tempo.bpm, d, "bpm", _min_conf(a.tempo.confidence, b.tempo.confidence))
    else:
        out.missing.append("tempo")
    if a.key and b.key:
        rel, dist = _key_relation(a, b)
        ka, kb = key_display(a.key.tonic, a.key.mode), key_display(b.key.tonic, b.key.mode)
        if rel == "same":
            text = f"Both are in {ka}."
        elif rel == "relative":
            text = f"{A} is in {ka}, {B} in {kb}: relative keys, the same notes."
        elif rel == "parallel":
            text = f"{A} is in {ka}, {B} in {kb}: same root, different mode."
        else:
            text = f"{A} is in {ka}, {B} in {kb}: {abs(dist)} semitone{'s' if abs(dist) != 1 else ''} apart."
        add("vitals", "key", text, "key", ka, kb, float(dist), "semitones", _min_conf(a.key.confidence, b.key.confidence))
    else:
        out.missing.append("key")
    if a.groove and b.groove:
        d = a.groove.swing_pct - b.groove.swing_pct
        add("vitals", "swing_pct", f"{A} swings {a.groove.swing_pct:.0f} against {B}'s {b.groove.swing_pct:.0f}.",
            "groove.swing_pct", a.groove.swing_pct, b.groove.swing_pct, d, "%",
            _min_conf(a.groove.confidence, b.groove.confidence))
        if a.groove.feel != b.groove.feel:
            add("vitals", "feel", f"{A} feels {a.groove.feel}; {B} feels {b.groove.feel}.", "groove.feel",
                a.groove.feel, b.groove.feel, None, "", _min_conf(a.groove.confidence, b.groove.confidence))
    else:
        out.missing.append("groove")

    # structure
    if a.structure and b.structure:
        if a.structure.loop_period_bars and b.structure.loop_period_bars:
            add("structure", "loop_period_bars",
                f"{A} sits on a {a.structure.loop_period_bars}-bar loop, {B} on a {b.structure.loop_period_bars}-bar loop.",
                "structure.loop_period_bars", a.structure.loop_period_bars, b.structure.loop_period_bars,
                float(a.structure.loop_period_bars - b.structure.loop_period_bars), "bars",
                _min_conf(a.structure.loop_period_confidence, b.structure.loop_period_confidence))
        add("structure", "section_count", f"{A} has {len(a.structure.sections)} sections, {B} has {len(b.structure.sections)}.",
            "structure.sections", len(a.structure.sections), len(b.structure.sections),
            float(len(a.structure.sections) - len(b.structure.sections)), "sections", None)
    else:
        out.missing.append("structure")

    # sample
    if a.sample_use and b.sample_use:
        if a.sample_use.chop_count_estimate and b.sample_use.chop_count_estimate:
            add("sample", "chop_count", f"{A} uses {a.sample_use.chop_count_estimate} chops, {B} {b.sample_use.chop_count_estimate}.",
                "sample_use.chop_count_estimate", a.sample_use.chop_count_estimate, b.sample_use.chop_count_estimate,
                float(a.sample_use.chop_count_estimate - b.sample_use.chop_count_estimate), "chops",
                _min_conf(a.sample_use.confidence, b.sample_use.confidence))
    else:
        out.missing.append("sample_use")

    # drums
    da = (sa.get("drums") or a).drums
    db_ = (sb.get("drums") or b).drums
    if da and db_:
        if da.source_estimate != db_.source_estimate:
            add("drums", "source", f"{A}'s drums read as {da.source_estimate.replace('_', ' ')}; {B}'s as {db_.source_estimate.replace('_', ' ')}.",
                "drums.source_estimate", da.source_estimate, db_.source_estimate, None, "",
                _min_conf(da.source_confidence, db_.source_confidence))
        if da.patterns and db_.patterns:
            ha = len([h for h in da.patterns[0].hat if h.frequency >= 0.5])
            hb = len([h for h in db_.patterns[0].hat if h.frequency >= 0.5])
            if ha and hb:
                ratio = ha / hb
                if ratio >= 1.5:
                    text = f"{A}'s hats are {ratio:.1f}x as dense as {B}'s."
                elif ratio <= 0.67:
                    text = f"{B}'s hats are {1 / ratio:.1f}x as dense as {A.lower()}'s."
                else:
                    text = "The hat density matches."
                add("drums", "hat_density", text, "drums.patterns[0].hat", ha, hb, ratio, "x",
                    _min_conf(da.source_confidence, db_.source_confidence))
            ka = sorted(h.step for h in da.patterns[0].kick if h.frequency >= 0.5)
            kb = sorted(h.step for h in db_.patterns[0].kick if h.frequency >= 0.5)
            if ka or kb:
                shared = len(set(ka) & set(kb))
                union = len(set(ka) | set(kb)) or 1
                sim = shared / union
                add("drums", "kick_pattern_similarity",
                    f"The kick patterns share {sim * 100:.0f} percent of their placements.",
                    "drums.patterns[0].kick", ka, kb, sim, "", _min_conf(da.source_confidence, db_.source_confidence))
            dens_d = da.patterns[0].density_per_bar - db_.patterns[0].density_per_bar
            add("drums", "density_per_bar", f"{A} lands {da.patterns[0].density_per_bar:.1f} hits a bar, {B} {db_.patterns[0].density_per_bar:.1f}.",
                "drums.patterns[0].density_per_bar", da.patterns[0].density_per_bar, db_.patterns[0].density_per_bar,
                dens_d, "hits/bar", _min_conf(da.source_confidence, db_.source_confidence))
    else:
        out.missing.append("drums")

    # bass vs sample overlap (needs stems on both sides)
    if sa.get("bass") and sa.get("other") and sb.get("bass") and sb.get("other"):
        def overlap(stems: dict[str, AnalysisReport]) -> Optional[bool]:
            other, bass = stems["other"], stems["bass"]
            if not (other.spectral and bass.loudness):
                return None
            bass_present = bass.loudness.integrated_lufs > -40
            return bool(bass_present and other.spectral.low_high_ratio_db > 0)
        oa, ob = overlap(sa), overlap(sb)
        if oa is not None and ob is not None:
            if oa and not ob:
                text = f"{A}'s sample sits in the same range as the bass; {B}'s doesn't."
            elif ob and not oa:
                text = f"{B}'s sample sits in the same range as its bass; {A.lower()}'s doesn't."
            elif oa and ob:
                text = "Both samples share range with their bass."
            else:
                text = "Neither sample fights its bass in the low end."
            add("bass", "sample_bass_overlap", text, "stems.other.spectral.low_high_ratio_db", oa, ob, None, "", 0.6)
    else:
        out.missing.append("stems")

    # harmony
    ca = (sa.get("other") or a).chords
    cb = (sb.get("other") or b).chords
    if ca and cb:
        la = [s.label for s in ca.segments if s.label != "N"]
        lb = [s.label for s in cb.segments if s.label != "N"]
        na, nb = len(set(la)), len(set(lb))
        add("harmony", "distinct_chords", f"{A} moves through {na} distinct chords, {B} through {nb}.",
            "chords.segments", na, nb, float(na - nb), "chords", None)
    else:
        out.missing.append("chords")

    # mix
    if a.loudness and b.loudness:
        d = a.loudness.integrated_lufs - b.loudness.integrated_lufs
        add("mix", "integrated_lufs", f"{A} is {abs(d):.1f} LU {'louder' if d > 0 else 'quieter'} than {B} ({a.loudness.integrated_lufs:.1f} vs {b.loudness.integrated_lufs:.1f} LUFS).",
            "loudness.integrated_lufs", a.loudness.integrated_lufs, b.loudness.integrated_lufs, d, "LU", None)
        dr = a.loudness.loudness_range_lu - b.loudness.loudness_range_lu
        add("mix", "loudness_range_lu", f"{A} has {a.loudness.loudness_range_lu:.1f} LU of range, {B} {b.loudness.loudness_range_lu:.1f}.",
            "loudness.loudness_range_lu", a.loudness.loudness_range_lu, b.loudness.loudness_range_lu, dr, "LU", None)
    else:
        out.missing.append("loudness")
    if a.spectral and b.spectral:
        d = a.spectral.low_high_ratio_db - b.spectral.low_high_ratio_db
        add("mix", "low_high_ratio_db", f"{A} is {abs(d):.1f} dB {'heavier' if d > 0 else 'lighter'} in the low end than {B}.",
            "spectral.low_high_ratio_db", a.spectral.low_high_ratio_db, b.spectral.low_high_ratio_db, d, "dB", None)
        dw = a.spectral.stereo_width - b.spectral.stereo_width
        add("mix", "stereo_width", f"{A} is {'wider' if dw > 0 else 'narrower'} ({a.spectral.stereo_width:.2f} vs {b.spectral.stereo_width:.2f}).",
            "spectral.stereo_width", a.spectral.stereo_width, b.spectral.stereo_width, dw, "", None)
        dc = a.spectral.centroid_hz_mean - b.spectral.centroid_hz_mean
        add("mix", "centroid_hz", f"{A} centers at {a.spectral.centroid_hz_mean:.0f} Hz, {B} at {b.spectral.centroid_hz_mean:.0f} Hz.",
            "spectral.centroid_hz_mean", a.spectral.centroid_hz_mean, b.spectral.centroid_hz_mean, dc, "Hz", None)
    else:
        out.missing.append("spectral")
    if a.effects_estimates and b.effects_estimates:
        sa_, sb_ = a.effects_estimates.sidechain_ducking, b.effects_estimates.sidechain_ducking
        if sa_.detected != sb_.detected:
            who = A if sa_.detected else B.capitalize()
            other = B if sa_.detected else A.lower()
            add("mix", "sidechain", f"{who} ducks the sample on the kick; {other} doesn't.", "effects_estimates.sidechain_ducking",
                sa_.detected, sb_.detected, None, "", _min_conf(sa_.confidence, sb_.confidence))
        elif sa_.detected and sa_.depth_db is not None and sb_.depth_db is not None:
            add("mix", "sidechain_depth", f"{A} ducks {sa_.depth_db:.1f} dB, {B} {sb_.depth_db:.1f} dB.",
                "effects_estimates.sidechain_ducking.depth_db", sa_.depth_db, sb_.depth_db, sa_.depth_db - sb_.depth_db,
                "dB", _min_conf(sa_.confidence, sb_.confidence))
        ra, rb = a.effects_estimates.reverb_tail_s, b.effects_estimates.reverb_tail_s
        if ra.value is not None and rb.value is not None:
            add("mix", "reverb_tail_s", f"{A}'s reverb tail is about {ra.value:.1f} s, {B}'s about {rb.value:.1f} s (rough).",
                "effects_estimates.reverb_tail_s", ra.value, rb.value, ra.value - rb.value, "s", _min_conf(ra.confidence, rb.confidence))
    out.missing = list(dict.fromkeys(out.missing))
    return out


__all__ = ["ComparisonContent", "Delta", "compare"]
