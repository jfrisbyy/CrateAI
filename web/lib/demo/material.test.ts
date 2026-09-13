import { describe, expect, it } from "vitest";
import { hedgeWord } from "@/lib/report/hedge";
import { lineageParts, sourceBars } from "@/lib/session/lineage";
import { candidateLength, downbeatOf, tileCandidate, trackFromCandidate } from "@/lib/session/rack";
import { BED_ID, buildDemoLibrary, bedCandidate, demoCompatRack, demoLoopsRack, DEMO_BARS, DEMO_BPM } from "./material";
import { barSeconds } from "./synth";

const SR = 44100;
const library = buildDemoLibrary(SR);
const rack = demoCompatRack(library);

describe("the crate", () => {
  it("holds the bed and five drum records, all ready and all analysed", () => {
    expect(library.files).toHaveLength(6);
    for (const file of library.files) {
      expect(file.status).toBe("ready");
      expect(file.report).not.toBeNull();
      expect(file.peaks).not.toBeNull();
      expect(file.duration_s).toBeGreaterThan(1);
    }
  });

  it("measures each row's peaks from the samples that will actually play", () => {
    for (const file of library.files) {
      const pcm = library.pcm.get(file.id);
      expect(pcm).toBeDefined();
      expect(file.duration_s).toBeCloseTo(pcm!.durationS, 3);
      expect(file.channels).toBe(pcm!.channels.length);
      // a waveform with shape, not a flat line
      expect(Math.max(...(file.peaks?.max ?? [0]))).toBeGreaterThan(0.2);
    }
  });

  it("gives every file a length of whole bars after its lead-in, so a tiling has no gap", () => {
    for (const file of library.files) {
      const report = file.report;
      const downbeats = report?.beats?.downbeats_s ?? [];
      const first = downbeats[0] ?? 0;
      const bars = downbeats.length;
      const bpm = report?.beats ? 60 / (report.beats.times_s[1] - report.beats.times_s[0]) : 0;
      expect(bars).toBeGreaterThan(0);
      expect((file.duration_s ?? 0) - first).toBeCloseTo(bars * barSeconds(bpm), 2);
    }
  });

  it("starts every record after its own silence, so a play starts on the one", () => {
    for (const file of library.files) {
      expect(downbeatOf(file)).toBeGreaterThan(0.1);
    }
  });

  it("marks the drum stems as stems, with the separator that made them", () => {
    expect(library.stems).toHaveLength(5);
    for (const stem of library.stems) {
      expect(stem.stem).toBe("drums");
      expect(["htdemucs_ft", "bs_roformer"]).toContain(stem.model);
      expect(library.files.some((f) => f.id === stem.stem_file_id)).toBe(true);
    }
  });
});

describe("the rack the product's own arithmetic produces", () => {
  it("ranks five candidates against the bed", () => {
    expect(rack.candidates).toHaveLength(5);
    expect(rack.source?.bpm).toBe(DEMO_BPM);
    expect(rack.candidates.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("puts the two near-identical fits at the top and lets timbre break the tie", () => {
    const [first, second] = rack.candidates;
    expect(first.title).toBe("The Ardent Few — Masquerade — drums");
    expect(second.title).toBe("Rosewood Trio — In The Shade — drums");
    // the second is very slightly the better stretch; the first wins on timbre
    expect(first.fit!.rate).toBeGreaterThan(1);
    expect(second.fit!.rate).toBeLessThan(1);
    expect(first.measurements.some((m) => m.label.includes("% alike"))).toBe(true);
  });

  it("counts the 174 BPM record half-time rather than refusing it", () => {
    const cold = rack.candidates.find((c) => c.title.includes("Cold Room"));
    expect(cold).toBeDefined();
    expect(cold!.fit!.rate).toBeCloseTo(92 / 87, 6);
    expect(cold!.measurements.some((m) => m.label.includes("half-time"))).toBe(true);
  });

  it("says plainly that it cannot tell on the record with no measured tempo", () => {
    const loose = rack.candidates.find((c) => c.title.includes("Basement Tape"));
    expect(loose).toBeDefined();
    expect(loose!.fit!.rate).toBe(1);
    expect(hedgeWord(loose!.confidence)).toBe("I can't tell");
    expect(loose!.measurements.every((m) => !m.label.includes("BPM"))).toBe(true);
  });

  it("carries the separation model into the provenance of every drum row", () => {
    for (const candidate of rack.candidates) {
      expect(candidate.provenance.stem).toBe("drums");
      expect(candidate.provenance.separationModel).toBeTruthy();
      expect(candidate.provenance.separationModelLabel).toBeTruthy();
    }
    expect(rack.candidates.find((c) => c.title.includes("Cold Room"))!.provenance.separationModel).toBe("bs_roformer");
  });

  it("gives every row a reason, a confidence dot's worth of confidence and a waveform", () => {
    for (const candidate of rack.candidates) {
      expect(candidate.reason.length).toBeGreaterThan(4);
      expect(candidate.peaks).not.toBeNull();
      expect(candidate.fileDurationS).toBeGreaterThan(1);
      expect(candidate.audio.downbeatS).toBeGreaterThan(0);
    }
  });
});

describe("the loops rack, so the panel has a history of real objects", () => {
  const loops = demoLoopsRack(library);

  it("is three scored loops inside Masquerade, fitted to the session", () => {
    expect(loops.candidates).toHaveLength(3);
    expect(loops.origin).toBe("loops");
    expect(loops.candidates[0].confidence).toBe(0.86);
    for (const candidate of loops.candidates) {
      expect(candidate.fit!.rate).toBeCloseTo(DEMO_BPM / 88.5, 6);
      expect(candidate.measurements.some((m) => m.label.startsWith("loop score"))).toBe(true);
    }
  });

  it("ranks the loops by the finder's score, not by their position in the file", () => {
    expect(loops.candidates.map((c) => c.confidence)).toEqual([0.86, 0.79, 0.72]);
  });
});

describe("what the bed does when it lands in the song", () => {
  const bed = bedCandidate(library);
  const span = { startS: 0, endS: DEMO_BARS * barSeconds(DEMO_BPM) };

  it("is exactly four bars long at the session's tempo", () => {
    expect(candidateLength(bed)).toBeCloseTo(span.endS, 6);
    expect(bed.sourceBpm).toBe(DEMO_BPM);
    expect(bed.audio.fileId).toBe(BED_ID);
  });

  it("tiles the loop exactly once, with no gap and no overhang", () => {
    const plan = tileCandidate({ candidate: bed, trackId: "lane", span });
    expect(plan.repeats).toBe(1);
    const region = plan.regions[0];
    expect(region.startS).toBe(0);
    expect(region.durationS).toBeCloseTo(span.endS, 6);
    expect(region.offsetS).toBeCloseTo(bed.audio.downbeatS, 6);
  });

  it("arrives on the lane with a line saying which record it is", () => {
    const track = trackFromCandidate(bed, "lane");
    expect(track.provenance).toContain("Moonlight Highlife");
    expect(track.origin).toBe("candidate");
  });
});

describe("a drum candidate laid under the session", () => {
  const span = { startS: 0, endS: DEMO_BARS * barSeconds(DEMO_BPM) };

  it("fills the loop with whole repeats of itself, at its fit rate", () => {
    for (const candidate of rack.candidates) {
      const plan = tileCandidate({ candidate, trackId: "audition", span });
      const covered = plan.regions.reduce((end, r) => Math.max(end, r.startS + r.durationS), 0);
      expect(covered).toBeCloseTo(span.endS, 6);
      for (let i = 1; i < plan.regions.length; i++) {
        expect(plan.regions[i].startS).toBeCloseTo(plan.regions[i - 1].startS + plan.regions[i - 1].durationS, 6);
      }
    }
  });

  it("lands the measured records exactly on the bar and the unmeasured one short", () => {
    const fitted = rack.candidates.filter((c) => c.sourceBpm !== null);
    for (const candidate of fitted) {
      const plan = tileCandidate({ candidate, trackId: "audition", span });
      // every repeat is a whole number of session bars
      const bars = plan.cycleS / barSeconds(DEMO_BPM);
      expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6);
    }
    const loose = rack.candidates.find((c) => c.sourceBpm === null)!;
    const bars = tileCandidate({ candidate: loose, trackId: "audition", span }).cycleS / barSeconds(DEMO_BPM);
    expect(Math.abs(bars - Math.round(bars))).toBeGreaterThan(0.01);
  });

  it("keeps its lineage, and names the record's own bars", () => {
    const candidate = rack.candidates[0];
    const region = tileCandidate({ candidate, trackId: "audition", span }).regions[0];
    const bars = sourceBars(region, region.lineage);
    expect(bars).toEqual({ fromBar: 1, toBar: 4, bars: 4 });
    const labels = lineageParts(region, region.lineage).map((p) => p.label);
    expect(labels).toContain("drums");
    expect(labels.some((l) => l.startsWith("separated:"))).toBe(true);
    expect(labels).toContain("bars 1–4");
  });

  it("says the bars it is after a head trim, not the bars it arrived as", () => {
    const candidate = rack.candidates[0];
    const region = tileCandidate({ candidate, trackId: "audition", span }).regions[0];
    const rate = region.rate ?? 1;
    const oneBarOfSource = barSeconds(candidate.sourceBpm as number);
    const trimmed = { ...region, offsetS: region.offsetS + oneBarOfSource, durationS: region.durationS - oneBarOfSource / rate };
    expect(sourceBars(trimmed, region.lineage)).toEqual({ fromBar: 2, toBar: 4, bars: 3 });
  });
});
