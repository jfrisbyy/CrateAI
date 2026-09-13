"""Compose a beat breakdown from measured report fields only.

BUILD_PACKET section 11. The composer never invents: every Fact points at the
report path it came from, carries the confidence, and the hedge word is
chosen by band (>= 0.8 none, 0.6-0.8 "likely", 0.4-0.6 "roughly", < 0.4
"I can't tell"). A null field produces a `missing` entry naming the job that
would measure it. The language layer narrates ``BreakdownContent`` and may not
add a fact that isn't here; that contract is tested on the web side with
adversarial fixtures.

Inputs:
  report        the original file's AnalysisReport (effective() is applied here)
  stem_reports  {"drums": AnalysisReport, "bass": ..., "vocals": ..., "other": ...}
                per-stem reports when separation has run (more accurate drums,
                bass, harmony, melodic, instrumentation)
  web_context   the cited findings from the web information tools, or None
  title/artist  what identifies the track, if anything
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal, Optional

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from ..report import AnalysisReport, DrumPattern, effective, hedge_word
from .words import (
    bandwidth_text,
    bar_number,
    bpm_text,
    db,
    key_display,
    pct,
    seconds,
    steps_phrase,
    with_hedge,
)

SectionKey = Literal["vitals", "structure", "sample", "drums", "bass", "harmony", "melodic",
                     "arrangement", "mix", "context", "recipe"]

SECTION_TITLES: dict[str, str] = {
    "vitals": "The vitals",
    "structure": "The structure",
    "sample": "The sample",
    "drums": "The drums",
    "bass": "The bass",
    "harmony": "The harmony",
    "melodic": "The melodic layer",
    "arrangement": "The arrangement",
    "mix": "The mix",
    "context": "The context",
    "recipe": "The recipe",
}

SECTION_ORDER: list[str] = list(SECTION_TITLES.keys())


class Fact(BaseModel):
    """One measured statement. ``text`` already carries the hedge."""

    model_config = ConfigDict(extra="forbid")

    text: str
    source: str = Field(description="report path, e.g. 'tempo.bpm' or 'stems.drums.drums.patterns[0]'")
    confidence: Optional[float] = None
    hedge: str = ""
    value: Any = None
    time_s: Optional[float] = None
    end_s: Optional[float] = None
    bar: Optional[int] = None
    citation: Optional[dict[str, Any]] = None


class Missing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str
    text: str
    job: Optional[str] = None
    """job kind (and params) that would measure it, e.g. 'stems' or 'analyze:chords'"""


class BreakdownSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: SectionKey
    title: str
    facts: list[Fact] = Field(default_factory=list)
    missing: list[Missing] = Field(default_factory=list)

    @property
    def available(self) -> bool:
        return bool(self.facts)


class BreakdownContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.0"] = "1.0"
    file_id: Optional[str] = None
    generated_at: str = ""
    analysis_version: int = 0
    identified: bool = False
    title: Optional[str] = None
    artist: Optional[str] = None
    sections: list[BreakdownSection] = Field(default_factory=list)
    requires: list[str] = Field(default_factory=list, description="jobs to queue before the breakdown is complete")

    def section(self, key: str) -> BreakdownSection:
        for s in self.sections:
            if s.key == key:
                return s
        raise KeyError(key)

    def all_fact_texts(self) -> list[str]:
        return [f.text for s in self.sections for f in s.facts]


def _fact(text: str, source: str, confidence: Optional[float] = None, value: Any = None,
          time_s: Optional[float] = None, end_s: Optional[float] = None, bar: Optional[int] = None,
          hedged: bool = True) -> Fact:
    hedge = hedge_word(confidence) if confidence is not None else ""
    if hedged and confidence is not None:
        text = with_hedge(hedge, text)
    return Fact(text=text, source=source, confidence=confidence, hedge=hedge, value=value,
                time_s=time_s, end_s=end_s, bar=bar)


def _bar_len_s(report: AnalysisReport) -> Optional[float]:
    if report.beats and len(report.beats.downbeats_s) >= 2:
        d = report.beats.downbeats_s
        return float(np.median(np.diff(d)))
    if report.tempo and report.tempo.bpm:
        bpb = 4
        if report.beats:
            try:
                bpb = int(report.beats.meter.split("/")[0])
            except (ValueError, AttributeError):
                bpb = 4
        return 60.0 / report.tempo.bpm * bpb
    return None


def _time_for_bar(report: AnalysisReport, bar_index: int) -> Optional[float]:
    if report.beats and report.beats.downbeats_s and 0 <= bar_index < len(report.beats.downbeats_s):
        return float(report.beats.downbeats_s[bar_index])
    bl = _bar_len_s(report)
    if bl is None:
        return None
    first = report.beats.downbeats_s[0] if report.beats and report.beats.downbeats_s else 0.0
    return first + bar_index * bl


# ---------------------------------------------------------------------------
# section builders
# ---------------------------------------------------------------------------

def _vitals(r: AnalysisReport) -> BreakdownSection:
    sec = BreakdownSection(key="vitals", title=SECTION_TITLES["vitals"])
    if r.tempo is None:
        sec.missing.append(Missing(field="tempo", text="Tempo wasn't measured yet.", job="analyze"))
    else:
        t = r.tempo
        text = f"It sits at {bpm_text(t.bpm)} BPM."
        if t.confidence < 0.8 and t.alternates_bpm:
            alts = " or ".join(bpm_text(a) for a in t.alternates_bpm)
            text = f"It sits at {bpm_text(t.bpm)} BPM, though it could be {alts} depending on how you count it."
        sec.facts.append(_fact(text, "tempo.bpm", t.confidence, t.bpm, time_s=0.0))
    if r.key is None:
        sec.missing.append(Missing(field="key", text="Key wasn't measured yet.", job="analyze"))
    else:
        k = r.key
        text = f"The key is {key_display(k.tonic, k.mode)}."
        if k.confidence < 0.8 and k.alternate is not None:
            text = (f"The key is {key_display(k.tonic, k.mode)}, with "
                    f"{key_display(k.alternate.tonic, k.alternate.mode)} as the other reading.")
        sec.facts.append(_fact(text, "key", k.confidence, {"tonic": k.tonic, "mode": k.mode}))
    if r.beats is not None:
        sec.facts.append(_fact(f"It's in {r.beats.meter}.", "beats.meter", None, r.beats.meter, hedged=False))
    if r.groove is None:
        sec.missing.append(Missing(field="groove", text="Feel wasn't measured yet.", job="analyze"))
    else:
        g = r.groove
        if g.feel == "straight":
            text = "The feel is straight."
        elif g.feel == "swung":
            text = f"The feel is swung, about {pct(g.swing_pct)}."
        else:
            text = (f"The feel is loose: hits land {g.timing_deviation_ms.std:.0f} ms either side of the grid "
                    f"on average.")
        sec.facts.append(_fact(text, "groove", g.confidence, {"feel": g.feel, "swing_pct": g.swing_pct}))
    return sec


def _structure(r: AnalysisReport) -> BreakdownSection:
    sec = BreakdownSection(key="structure", title=SECTION_TITLES["structure"])
    s = r.structure
    if s is None:
        sec.missing.append(Missing(field="structure", text="Structure wasn't measured yet.", job="analyze"))
        return sec
    if not s.sections:
        sec.facts.append(_fact("No section boundaries were found; it plays as one section.", "structure.sections",
                               0.5, [], hedged=True))
    for i, section in enumerate(s.sections):
        text = f"Bars {bar_number(section.start_bar)} to {bar_number(section.start_bar) + section.bars - 1}: {section.label}, {section.bars} bars."
        sec.facts.append(_fact(text, f"structure.sections[{i}]", section.confidence,
                               {"label": section.label, "bars": section.bars, "energy": section.energy},
                               time_s=section.start_s, end_s=section.end_s, bar=section.start_bar, hedged=False))
    # energy rises and drops
    energies = [x.energy for x in s.sections]
    if len(energies) >= 2:
        for i in range(1, len(energies)):
            delta = energies[i] - energies[i - 1]
            if abs(delta) >= 0.15:
                verb = "rises" if delta > 0 else "drops"
                sec.facts.append(_fact(
                    f"Energy {verb} going into bar {bar_number(s.sections[i].start_bar)} ({s.sections[i].label}).",
                    f"structure.sections[{i}].energy", s.sections[i].confidence, delta,
                    time_s=s.sections[i].start_s, bar=s.sections[i].start_bar, hedged=False))
    if s.loop_period_bars:
        sec.facts.append(_fact(f"The whole thing sits on a {s.loop_period_bars}-bar loop.",
                               "structure.loop_period_bars", s.loop_period_confidence, s.loop_period_bars))
    return sec


def _sample(r: AnalysisReport) -> BreakdownSection:
    sec = BreakdownSection(key="sample", title=SECTION_TITLES["sample"])
    su = r.sample_use
    if su is None:
        sec.missing.append(Missing(field="sample_use", text="Sample use wasn't measured yet.",
                                   job="analyze:sample_use"))
        return sec
    if su.is_loop_based is None:
        sec.facts.append(_fact("I couldn't tell whether it's loop-based.", "sample_use.is_loop_based",
                               su.confidence, None, hedged=False))
    elif su.is_loop_based:
        period = r.structure.loop_period_bars if r.structure and r.structure.loop_period_bars else None
        base = "It's loop-based" + (f", on a {period}-bar phrase." if period else ".")
        sec.facts.append(_fact(base, "sample_use.is_loop_based", su.confidence, True))
        if su.chop_count_estimate:
            if su.chop_reordering_detected and su.chop_order:
                order = "-".join(str(i + 1) for i in su.chop_order)
                text = f"{su.chop_count_estimate} chops, played in the order {order}."
            elif su.chop_reordering_detected:
                text = f"{su.chop_count_estimate} chops, reordered from the source."
            else:
                text = f"{su.chop_count_estimate} chops, played in order."
            sec.facts.append(_fact(text, "sample_use.chop_count_estimate", su.confidence,
                                   {"count": su.chop_count_estimate, "reordered": su.chop_reordering_detected}))
    else:
        sec.facts.append(_fact("It isn't loop-based; the material doesn't repeat as a sample would.",
                               "sample_use.is_loop_based", su.confidence, False))
    if su.pitch_shift_semitones_estimate is not None:
        st = su.pitch_shift_semitones_estimate
        direction = "up" if st > 0 else "down"
        text = f"The sample is pitched {direction} {abs(st):g} semitone{'s' if abs(st) != 1 else ''} from the source."
        sec.facts.append(_fact(text, "sample_use.pitch_shift_semitones_estimate", su.confidence, st))
    if su.sample_bars:
        bars = su.sample_bars
        ranges = _ranges(bars)
        text = "The sample carries bars " + ", ".join(
            f"{bar_number(a)}" if a == b else f"{bar_number(a)}–{bar_number(b)}" for a, b in ranges) + "."
        sec.facts.append(_fact(text, "sample_use.sample_bars", su.confidence, bars, hedged=False))
    return sec


def _ranges(indexes: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for i in sorted(set(indexes)):
        if out and i == out[-1][1] + 1:
            out[-1] = (out[-1][0], i)
        else:
            out.append((i, i))
    return out


def _pattern_text(p: DrumPattern) -> list[str]:
    lines: list[str] = []
    kick_steps = [h.step for h in p.kick if h.frequency >= 0.5]
    snare_steps = [h.step for h in p.snare if h.frequency >= 0.5 and h.step not in p.ghost_notes]
    if kick_steps:
        lines.append(f"Kick on {steps_phrase(kick_steps)}.")
    if snare_steps:
        s = f"Snare on {steps_phrase(snare_steps)}"
        if p.ghost_notes:
            s += f", with a ghost before {steps_phrase([min((g + 1) - (g + 1) % 4 + 4, 15) for g in p.ghost_notes])}"
        lines.append(s + ".")
    hats = [h for h in p.hat if h.frequency >= 0.5]
    if hats:
        steps = sorted(h.step for h in hats)
        if len(steps) >= 12:
            density = "16ths"
        elif len(steps) >= 6:
            density = "8ths"
        elif len(steps) >= 3:
            density = "quarters"
        else:
            density = "sparse"
        text = f"Hats on {density}"
        if p.hat_open_ratio is not None and p.hat_open_ratio > 0.1:
            text += f", about {pct(p.hat_open_ratio * 100)} open"
        lines.append(text + ".")
    return lines


def _drums(r: AnalysisReport, stems: dict[str, AnalysisReport]) -> BreakdownSection:
    sec = BreakdownSection(key="drums", title=SECTION_TITLES["drums"])
    source_report = stems.get("drums") or r
    source_prefix = "stems.drums." if "drums" in stems else ""
    d = source_report.drums
    if d is None:
        job = "analyze:drums" if "drums" in stems else "stems"
        sec.missing.append(Missing(field="drums", text="The drums weren't analyzed yet; separating stems gets the pattern.",
                                   job=job))
        return sec
    est = d.source_estimate
    if est == "sampled_break":
        text = "The drums are a sampled break: the hits drift against the grid and vary in tone the way a played break does."
    elif est == "programmed":
        text = "The drums are programmed: the hits sit on the grid with near-identical tone every time."
    elif est == "mixed":
        text = "The drums are mixed: some hits sit dead on the grid with identical tone, others drift and vary like a break."
    else:
        text = "I can't tell whether the drums are a break or programmed."
    sec.facts.append(_fact(text, f"{source_prefix}drums.source_estimate", d.source_confidence, est,
                           hedged=est != "unknown"))
    if d.layered_kick:
        sec.facts.append(_fact("Two kick spectra show up, so the kick is layered.", f"{source_prefix}drums.layered_kick",
                               d.source_confidence, True))
    for p in d.patterns:
        section_label = None
        if r.structure and 0 <= p.section_index < len(r.structure.sections):
            section_label = r.structure.sections[p.section_index].label
            time_s = r.structure.sections[p.section_index].start_s
            bar = r.structure.sections[p.section_index].start_bar
        else:
            time_s, bar = None, None
        where = f"In {section_label}" if section_label else f"In section {p.section_index + 1}"
        lines = _pattern_text(p)
        if not lines:
            continue
        text = f"{where}: " + " ".join(lines)
        sec.facts.append(_fact(text, f"{source_prefix}drums.patterns[{p.section_index}]", d.source_confidence,
                               p.model_dump(), time_s=time_s, bar=bar, hedged=False))
    if r.groove and r.groove.feel == "swung":
        sec.facts.append(_fact(f"Swing is {pct(r.groove.swing_pct)}.", "groove.swing_pct", r.groove.confidence,
                               r.groove.swing_pct))
    # where the drums drop out
    inst = (stems.get("drums") or r).instrumentation or r.instrumentation
    if inst:
        for ps in inst.per_section:
            for ev in ps.exits:
                if ev.instrument == "drums":
                    sec.facts.append(_fact(f"The drums drop out at bar {bar_number(ev.bar)}.",
                                           "instrumentation.per_section", inst.confidence, ev.bar,
                                           time_s=_time_for_bar(r, ev.bar), bar=ev.bar))
    return sec


def _bass(r: AnalysisReport, stems: dict[str, AnalysisReport]) -> BreakdownSection:
    sec = BreakdownSection(key="bass", title=SECTION_TITLES["bass"])
    bass = stems.get("bass")
    if bass is None:
        sec.missing.append(Missing(field="stems.bass", text="Separate stems to read the bass.", job="stems"))
        return sec
    present = bass.loudness is not None and bass.loudness.integrated_lufs > -40
    if not present:
        sec.facts.append(_fact("There's no real bass part; the low end comes from the sample.", "stems.bass.loudness",
                               0.7, False))
        return sec
    sec.facts.append(_fact("There's a bass part.", "stems.bass.loudness", 0.9, True, hedged=False))
    if bass.chords and bass.chords.segments and r.chords and r.chords.segments:
        follows = _root_motion_follows(bass, r)
        if follows is not None:
            text = ("The bass follows the sample's roots." if follows
                    else "The bass moves on its own, not just tracking the sample's roots.")
            sec.facts.append(_fact(text, "stems.bass.chords", min(bass.chords.segments[0].confidence, 0.8), follows))
    if bass.effects_estimates and bass.effects_estimates.sidechain_ducking.detected:
        sd = bass.effects_estimates.sidechain_ducking
        depth = f" by about {db(sd.depth_db, signed=False)}" if sd.depth_db is not None else ""
        sec.facts.append(_fact(f"The bass ducks under the kick{depth}.", "stems.bass.effects_estimates.sidechain_ducking",
                               sd.confidence, sd.depth_db))
    return sec


def _root_motion_follows(bass: AnalysisReport, r: AnalysisReport) -> Optional[bool]:
    """True when the bass chord roots match the song's chord roots most of the time."""
    if not (bass.chords and r.chords):
        return None
    matches = 0
    total = 0
    for seg in r.chords.segments:
        mid = (seg.start_s + seg.end_s) / 2
        b = next((s for s in bass.chords.segments if s.start_s <= mid < s.end_s), None)
        if b is None or seg.label == "N" or b.label == "N":
            continue
        total += 1
        if _root(seg.label) == _root(b.label):
            matches += 1
    if total == 0:
        return None
    return matches / total >= 0.6


def _root(label: str) -> str:
    return label.replace(":min", "").replace(":maj", "").replace("m", "").strip()


def _harmony(r: AnalysisReport, stems: dict[str, AnalysisReport]) -> BreakdownSection:
    sec = BreakdownSection(key="harmony", title=SECTION_TITLES["harmony"])
    src = stems.get("other") or r
    prefix = "stems.other." if "other" in stems else ""
    if src.chords is None:
        sec.missing.append(Missing(field="chords", text="Chords weren't measured yet.", job="analyze:chords"))
        return sec
    segs = [s for s in src.chords.segments if s.label != "N"]
    if not segs:
        sec.facts.append(_fact("No clear chord changes were found.", f"{prefix}chords.segments", 0.5, [], hedged=True))
    else:
        conf = float(np.mean([s.confidence for s in segs]))
        if r.structure and r.structure.sections:
            for section in r.structure.sections:
                labels = _dedupe_consecutive([s.label for s in segs if section.start_s <= s.start_s < section.end_s])
                if labels:
                    sec.facts.append(_fact(f"{section.label}: {' – '.join(labels)}.", f"{prefix}chords.segments",
                                           conf, labels, time_s=section.start_s, end_s=section.end_s,
                                           bar=section.start_bar))
        else:
            labels = _dedupe_consecutive([s.label for s in segs])
            sec.facts.append(_fact(f"The progression runs {' – '.join(labels[:16])}.", f"{prefix}chords.segments",
                                   conf, labels, time_s=segs[0].start_s))
    if r.key and src is not r and src.key:
        same = (src.key.tonic, src.key.mode) == (r.key.tonic, r.key.mode)
        text = ("The sample and the song share a key." if same else
                f"The sample reads as {key_display(src.key.tonic, src.key.mode)} against the song's "
                f"{key_display(r.key.tonic, r.key.mode)}.")
        sec.facts.append(_fact(text, "stems.other.key", min(src.key.confidence, r.key.confidence), same))
    return sec


def _dedupe_consecutive(labels: list[str]) -> list[str]:
    out: list[str] = []
    for lab in labels:
        if not out or out[-1] != lab:
            out.append(lab)
    return out


def _melodic(r: AnalysisReport, stems: dict[str, AnalysisReport]) -> BreakdownSection:
    sec = BreakdownSection(key="melodic", title=SECTION_TITLES["melodic"])
    if not stems:
        sec.missing.append(Missing(field="stems", text="Separate stems to read the melodic layer.", job="stems"))
        return sec
    vocals = stems.get("vocals")
    if vocals is not None:
        present = vocals.loudness is not None and vocals.loudness.integrated_lufs > -40
        if present:
            is_chop = bool(vocals.sample_use and vocals.sample_use.is_loop_based)
            text = ("There's a vocal, and it repeats like a chop rather than a performance." if is_chop
                    else "There's a vocal that reads as a performance, not a chop.")
            conf = vocals.sample_use.confidence if vocals.sample_use else 0.5
            sec.facts.append(_fact(text, "stems.vocals.sample_use", conf, is_chop))
            if vocals.spectral:
                sec.facts.append(_fact(f"The vocal centers around {vocals.spectral.centroid_hz_mean:.0f} Hz.",
                                       "stems.vocals.spectral.centroid_hz_mean", None,
                                       vocals.spectral.centroid_hz_mean, hedged=False))
        else:
            sec.facts.append(_fact("No vocal.", "stems.vocals.loudness", 0.9, False, hedged=False))
    other = stems.get("other")
    if other is not None and other.spectral is not None:
        sec.facts.append(_fact(f"The harmonic layer centers around {other.spectral.centroid_hz_mean:.0f} Hz.",
                               "stems.other.spectral.centroid_hz_mean", None, other.spectral.centroid_hz_mean,
                               hedged=False))
    if not sec.facts:
        sec.missing.append(Missing(field="stems.vocals", text="Vocal and other stems weren't analyzed yet.",
                                   job="analyze"))
    return sec


def _arrangement(r: AnalysisReport) -> BreakdownSection:
    sec = BreakdownSection(key="arrangement", title=SECTION_TITLES["arrangement"])
    inst = r.instrumentation
    if inst is None:
        sec.missing.append(Missing(field="instrumentation", text="Instrument entries and exits weren't measured yet.",
                                   job="stems"))
        return sec
    for ps in inst.per_section:
        for ev in ps.entries:
            sec.facts.append(_fact(f"{ev.instrument.capitalize()} enters at bar {bar_number(ev.bar)}.",
                                   f"instrumentation.per_section[{ps.section_index}].entries", inst.confidence,
                                   ev.model_dump(), time_s=_time_for_bar(r, ev.bar), bar=ev.bar))
        for ev in ps.exits:
            sec.facts.append(_fact(f"{ev.instrument.capitalize()} drops out at bar {bar_number(ev.bar)}.",
                                   f"instrumentation.per_section[{ps.section_index}].exits", inst.confidence,
                                   ev.model_dump(), time_s=_time_for_bar(r, ev.bar), bar=ev.bar))
    if not sec.facts and inst.per_section:
        present = sorted({p for ps in inst.per_section for p in ps.present})
        sec.facts.append(_fact(f"{', '.join(present)} play throughout; nothing enters or leaves." if present
                               else "Nothing was detected as present.",
                               "instrumentation.per_section", inst.confidence, present, hedged=False))
    return sec


def _mix(r: AnalysisReport, stems: dict[str, AnalysisReport]) -> BreakdownSection:
    sec = BreakdownSection(key="mix", title=SECTION_TITLES["mix"])
    if r.loudness is None:
        sec.missing.append(Missing(field="loudness", text="Loudness wasn't measured yet.", job="analyze"))
    else:
        lo = r.loudness
        sec.facts.append(_fact(f"It's {lo.integrated_lufs:.1f} LUFS integrated, {lo.true_peak_dbtp:.1f} dBTP peak, "
                               f"with {lo.loudness_range_lu:.1f} LU of range.", "loudness", None,
                               lo.model_dump(), hedged=False))
    if r.spectral is None:
        sec.missing.append(Missing(field="spectral", text="Spectral balance wasn't measured yet.", job="analyze"))
    else:
        sp = r.spectral
        if sp.low_high_ratio_db > 6:
            bal = "heavy on the low end"
        elif sp.low_high_ratio_db < -6:
            bal = "bright, light on the low end"
        else:
            bal = "balanced between low and high"
        width = "mono" if sp.stereo_width < 0.1 else ("narrow" if sp.stereo_width < 0.35 else "wide")
        sec.facts.append(_fact(f"It's {bal} ({db(sp.low_high_ratio_db)} low against high) and {width} in the stereo field.",
                               "spectral", None, sp.model_dump(), hedged=False))
        bw = sp.bandwidth
        if bw is not None and bw.value is not None:
            sec.facts.append(_fact(bandwidth_text(bw.value), "spectral.bandwidth", bw.confidence, bw.value))
    fx = r.effects_estimates
    if fx is None:
        sec.missing.append(Missing(field="effects_estimates", text="Effects estimates weren't run yet.",
                                   job="analyze:effects_estimates"))
    else:
        sd = fx.sidechain_ducking
        if sd.detected:
            depth = f" about {db(sd.depth_db, signed=False)} deep" if sd.depth_db is not None else ""
            sec.facts.append(_fact(f"There's sidechain ducking on the kick,{depth}.", "effects_estimates.sidechain_ducking",
                                   sd.confidence, sd.depth_db))
        else:
            sec.facts.append(_fact("No sidechain ducking shows up.", "effects_estimates.sidechain_ducking",
                                   sd.confidence, False))
        snare_src = stems.get("drums")
        rv = (snare_src.effects_estimates.reverb_tail_s if snare_src and snare_src.effects_estimates
              else fx.reverb_tail_s)
        if rv.value is not None:
            sec.facts.append(_fact(f"The reverb tail is around {seconds(rv.value)} (rough).",
                                   "effects_estimates.reverb_tail_s", rv.confidence, rv.value))
        if fx.saturation_above_hz.value is not None:
            sec.facts.append(_fact(f"There's saturation above about {fx.saturation_above_hz.value:.0f} Hz (rough).",
                                   "effects_estimates.saturation_above_hz", fx.saturation_above_hz.confidence,
                                   fx.saturation_above_hz.value))
    return sec


def _context(identified: bool, web_context: Optional[dict[str, Any]]) -> BreakdownSection:
    sec = BreakdownSection(key="context", title=SECTION_TITLES["context"])
    if not identified:
        sec.missing.append(Missing(field="context", text="Identify the track and I can add what's been documented about it.",
                                   job="identify_context"))
        return sec
    if not web_context or not web_context.get("findings"):
        sec.missing.append(Missing(field="context", text="I couldn't find documented context for this track yet.",
                                   job="identify_context"))
        return sec
    for i, finding in enumerate(web_context["findings"]):
        text = finding.get("text") or ""
        cite = finding.get("citation") or {}
        if not text or not cite.get("url"):
            continue  # a world fact without a citation never enters the breakdown
        f = Fact(text=text, source=f"web_context.findings[{i}]", confidence=None, hedge="", value=finding.get("kind"),
                 citation=cite)
        sec.facts.append(f)
    if not sec.facts:
        sec.missing.append(Missing(field="context", text="Nothing citable was found.", job="identify_context"))
    return sec


def _recipe(r: AnalysisReport, stems: dict[str, AnalysisReport], content: BreakdownContent) -> BreakdownSection:
    """A synthesis in producer terms, derived only from facts already in the content."""
    sec = BreakdownSection(key="recipe", title=SECTION_TITLES["recipe"])
    steps: list[str] = []
    sources: list[str] = []
    if r.tempo and r.key:
        period = r.structure.loop_period_bars if r.structure and r.structure.loop_period_bars else None
        phrase = f"{period}-bar " if period else ""
        loop_based = r.sample_use.is_loop_based if r.sample_use else None
        what = "loop" if loop_based or loop_based is None else "phrase"
        steps.append(f"Find a {phrase}{what} around {bpm_text(r.tempo.bpm)} in {key_display(r.key.tonic, r.key.mode)}.")
        sources += ["tempo.bpm", "key"]
    if r.sample_use and r.sample_use.chop_count_estimate:
        n = r.sample_use.chop_count_estimate
        order = ""
        if r.sample_use.chop_reordering_detected and r.sample_use.chop_order:
            order = " and play them " + "-".join(str(i + 1) for i in r.sample_use.chop_order)
        steps.append(f"Chop it in {n}{order}.")
        sources.append("sample_use.chop_count_estimate")
    drums_report = stems.get("drums") or r
    if drums_report.drums and drums_report.drums.patterns:
        p = drums_report.drums.patterns[0]
        feel = ""
        if r.groove and r.groove.feel == "swung":
            feel = f"swung {pct(r.groove.swing_pct)} "
        kind = ("a live-feeling break" if drums_report.drums.source_estimate == "sampled_break"
                else "a programmed pattern" if drums_report.drums.source_estimate == "programmed" else "a drum pattern")
        kicks = [h.step for h in p.kick if h.frequency >= 0.5]
        detail = f" with the kick on {steps_phrase(kicks)}" if kicks else ""
        steps.append(f"Lay {kind} under it, {feel}{'' if feel else ''}{detail}.".replace(", .", ".").replace(" ,", ","))
        sources.append("drums.patterns[0]")
    bass = stems.get("bass")
    if bass and bass.loudness and bass.loudness.integrated_lufs > -40:
        steps.append("Add a bass part under the loop.")
        sources.append("stems.bass.loudness")
    if r.spectral and r.spectral.low_high_ratio_db > 6 and drums_report is not r:
        steps.append("Low-pass the loop so the break carries the top end.")
        sources.append("spectral.low_high_ratio_db")
    if r.effects_estimates and r.effects_estimates.sidechain_ducking.detected:
        sd = r.effects_estimates.sidechain_ducking
        depth = f" {db(sd.depth_db, signed=False)}" if sd.depth_db is not None else ""
        steps.append(f"Duck the sample{depth} on the kick.")
        sources.append("effects_estimates.sidechain_ducking")
    if r.loudness:
        steps.append(f"Aim the mix at about {r.loudness.integrated_lufs:.0f} LUFS.")
        sources.append("loudness.integrated_lufs")
    if not steps:
        sec.missing.append(Missing(field="recipe", text="There isn't enough measured yet to write a recipe.",
                                   job="analyze"))
        return sec
    for step, source in zip(steps, sources):
        sec.facts.append(Fact(text=step, source=source, confidence=None, hedge=""))
    return sec


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def requires_for(report: AnalysisReport, stem_reports: Optional[dict[str, AnalysisReport]]) -> list[str]:
    """Jobs that must run before the breakdown is complete (queued by the job runner).

    A missing stem means the whole separation job (which queues per-stem
    analysis itself); a stem that exists but was never analyzed means one
    per-stem analyze job.
    """
    req: list[str] = []
    core = ("tempo", "beats", "key", "onsets", "groove", "structure", "loudness", "spectral")
    if any(getattr(report, f) is None for f in core):
        req.append("analyze")
    stems = stem_reports or {}
    if any(stems.get(name) is None for name in ("drums", "bass", "other", "vocals")):
        req.append("stems")
    else:
        for name in ("drums", "bass", "other", "vocals"):
            if stems[name].tempo is None:
                req.append(f"analyze:{name}")
    return list(dict.fromkeys(req))


def compose(report: AnalysisReport, stem_reports: Optional[dict[str, AnalysisReport]] = None,
            title: Optional[str] = None, artist: Optional[str] = None,
            web_context: Optional[dict[str, Any]] = None) -> BreakdownContent:
    r = effective(report)
    stems = {k: effective(v) for k, v in (stem_reports or {}).items()}
    identified = bool(title or artist)
    content = BreakdownContent(
        file_id=report.file.id,
        generated_at=datetime.now(UTC).isoformat(),
        analysis_version=report.analysis_version,
        identified=identified,
        title=title,
        artist=artist,
        requires=requires_for(report, stem_reports),
    )
    content.sections = [
        _vitals(r),
        _structure(r),
        _sample(r),
        _drums(r, stems),
        _bass(r, stems),
        _harmony(r, stems),
        _melodic(r, stems),
        _arrangement(stems.get("drums") and _merge_instrumentation(r, stems) or r),
        _mix(r, stems),
        _context(identified, web_context),
    ]
    content.sections.append(_recipe(r, stems, content))
    return content


def _merge_instrumentation(r: AnalysisReport, stems: dict[str, AnalysisReport]) -> AnalysisReport:
    """Prefer instrumentation measured from stems when the original lacks it."""
    if r.instrumentation is not None:
        return r
    for rep in stems.values():
        if rep.instrumentation is not None:
            merged = r.model_copy(deep=True)
            merged.instrumentation = rep.instrumentation
            return merged
    return r


__all__ = ["BreakdownContent", "BreakdownSection", "Fact", "Missing", "SECTION_ORDER", "SECTION_TITLES",
           "compose", "requires_for"]
