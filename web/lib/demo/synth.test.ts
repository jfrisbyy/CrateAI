import { describe, expect, it } from "vitest";
import {
  addHat,
  addKick,
  addSnare,
  barSeconds,
  edgeFades,
  KIT_DUSTY,
  KIT_MACHINE,
  midiHz,
  normalise,
  peaksFrom,
  renderBed,
  renderBreak,
  rng,
  stepSeconds,
  stepTime,
} from "./synth";

const SR = 44100;

function peak(channels: Float32Array[]): number {
  let loudest = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) loudest = Math.max(loudest, Math.abs(ch[i]));
  return loudest;
}

/** Energy in a window, for asserting that a hit landed where the grid says. */
function energy(ch: Float32Array, fromS: number, toS: number, sr = SR): number {
  let sum = 0;
  for (let i = Math.max(0, Math.round(fromS * sr)); i < Math.min(ch.length, Math.round(toS * sr)); i++) sum += ch[i] * ch[i];
  return sum;
}

describe("the maths the material rests on", () => {
  it("counts bars and sixteenths the way lib/session/time does", () => {
    expect(barSeconds(92)).toBeCloseTo((60 / 92) * 4, 12);
    expect(stepSeconds(92)).toBeCloseTo(60 / 92 / 4, 12);
    expect(stepSeconds(92) * 16).toBeCloseTo(barSeconds(92), 12);
  });

  it("puts equal temperament where a tuner would", () => {
    expect(midiHz(69)).toBeCloseTo(440, 9);
    expect(midiHz(57)).toBeCloseTo(220, 9);
    expect(midiHz(41)).toBeCloseTo(87.307, 3);
  });

  it("is deterministic, so the drawn peaks are the peaks of the audio that plays", () => {
    const a = rng(7);
    const b = rng(7);
    for (let i = 0; i < 32; i++) expect(a()).toBe(b());
    expect(rng(7)()).not.toBe(rng(8)());
  });

  it("swings the odd sixteenths late and leaves the even ones on the grid", () => {
    const spec = { bpm: 90, leadInS: 0.2, swing: 0.25 };
    const step = stepSeconds(90);
    expect(stepTime(spec, 0, 0)).toBeCloseTo(0.2, 12);
    expect(stepTime(spec, 0, 2)).toBeCloseTo(0.2 + 2 * step, 12);
    expect(stepTime(spec, 0, 1)).toBeCloseTo(0.2 + step + 0.25 * step, 12);
    expect(stepTime({ ...spec, swing: 0 }, 1, 4)).toBeCloseTo(0.2 + 20 * step, 12);
  });
});

describe("voices", () => {
  it("a kick puts its energy at the front and decays", () => {
    const out = new Float32Array(SR);
    addKick(out, 0.1, SR, 1, KIT_DUSTY);
    expect(energy(out, 0, 0.099)).toBe(0);
    expect(energy(out, 0.1, 0.16)).toBeGreaterThan(energy(out, 0.3, 0.36));
    expect(peak([out])).toBeGreaterThan(0.3);
  });

  it("a snare has more high content than a kick", () => {
    const kick = new Float32Array(SR / 2);
    const snare = new Float32Array(SR / 2);
    addKick(kick, 0, SR, 1, KIT_DUSTY);
    addSnare(snare, 0, SR, 1, KIT_DUSTY, rng(1));
    expect(zeroCrossings(snare)).toBeGreaterThan(zeroCrossings(kick) * 3);
  });

  it("an open hat rings longer than a closed one", () => {
    const closed = new Float32Array(SR);
    const open = new Float32Array(SR);
    addHat(closed, 0, SR, 1, KIT_DUSTY, false, rng(2));
    addHat(open, 0, SR, 1, KIT_DUSTY, true, rng(2));
    expect(energy(open, 0.1, 0.3)).toBeGreaterThan(energy(closed, 0.1, 0.3) * 10);
  });
});

describe("a rendered break", () => {
  const spec = {
    bpm: 88.5,
    bars: 4,
    leadInS: 0.22,
    kit: { ...KIT_DUSTY, jitterMs: 0, hiss: 0 },
    kick: ["X..............."],
    snare: ["....X..........."],
    hat: ["x.x.x.x.x.x.x.x."],
    peak: 0.6,
  };

  it("is exactly the lead-in plus whole bars, which is what the tiling assumes", () => {
    const pcm = renderBreak(spec, SR);
    expect(pcm.durationS).toBeCloseTo(0.22 + 4 * barSeconds(88.5), 12);
    expect(pcm.channels).toHaveLength(1);
    expect(pcm.channels[0].length).toBe(Math.round(pcm.durationS * SR));
    expect(pcm.sampleRate).toBe(SR);
  });

  it("starts silent for the lead-in and puts the first kick on the downbeat", () => {
    const pcm = renderBreak(spec, SR);
    const ch = pcm.channels[0];
    expect(energy(ch, 0, 0.2)).toBe(0);
    expect(energy(ch, 0.22, 0.3)).toBeGreaterThan(0);
  });

  it("puts the backbeat a beat and a half after the one, where the grid says", () => {
    const pcm = renderBreak(spec, SR);
    const ch = pcm.channels[0];
    const snareAt = 0.22 + 4 * stepSeconds(88.5);
    expect(energy(ch, snareAt, snareAt + 0.05)).toBeGreaterThan(energy(ch, snareAt - 0.09, snareAt - 0.04));
  });

  it("normalises to its peak and leaves headroom for the lanes stacked on it", () => {
    const pcm = renderBreak(spec, SR);
    expect(peak(pcm.channels)).toBeCloseTo(0.6, 2);
    expect(peak(pcm.channels)).toBeLessThan(1);
  });

  it("renders the same samples twice, so peaks measured once stay true", () => {
    const a = renderBreak(spec, SR).channels[0];
    const b = renderBreak(spec, SR).channels[0];
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 997) expect(a[i]).toBe(b[i]);
  });

  it("humanises a live kit and leaves a machine kit on the grid", () => {
    const machine = renderBreak({ ...spec, kit: KIT_MACHINE }, SR).channels[0];
    const firstHit = machine.findIndex((v) => Math.abs(v) > 0.01);
    expect(firstHit / SR).toBeCloseTo(0.22, 2);
  });
});

describe("a rendered bed", () => {
  const bed = {
    bpm: 92,
    bars: 4,
    leadInS: 0.31,
    peak: 0.42,
    keys: [{ bar: 0, step: 0, midi: 53, steps: 12 }],
    bass: [{ bar: 0, step: 0, midi: 41, steps: 6 }],
  };

  it("is stereo, exact in length, and wider than mono", () => {
    const pcm = renderBed(bed, SR);
    expect(pcm.channels).toHaveLength(2);
    expect(pcm.durationS).toBeCloseTo(0.31 + 4 * barSeconds(92), 12);
    let differs = 0;
    for (let i = 0; i < pcm.channels[0].length; i += 101) if (pcm.channels[0][i] !== pcm.channels[1][i]) differs++;
    expect(differs).toBeGreaterThan(0);
  });
});

describe("shaping and measuring", () => {
  it("normalise scales every channel by one factor, so the image does not move", () => {
    const l = Float32Array.from([0.1, -0.2, 0.4]);
    const r = Float32Array.from([0.05, -0.1, 0.2]);
    normalise([l, r], 0.8);
    expect(l[2]).toBeCloseTo(0.8, 6);
    expect(r[2]).toBeCloseTo(0.4, 6);
  });

  it("normalise leaves silence alone rather than dividing by zero", () => {
    const silent = new Float32Array(8);
    normalise([silent], 0.8);
    expect([...silent].every((v) => v === 0)).toBe(true);
  });

  it("fades both edges so a bar cut at the bar line does not click", () => {
    const ch = new Float32Array(1000).fill(1);
    edgeFades([ch], 1000, 0.01);
    expect(ch[0]).toBe(0);
    expect(ch[999]).toBe(0);
    expect(ch[500]).toBe(1);
  });

  it("measures peaks as min/max pairs in [-1, 1] with the asked-for point count", () => {
    const pcm = renderBreak(
      { bpm: 90, bars: 1, leadInS: 0, kit: KIT_DUSTY, kick: ["X..............."], snare: ["...."], hat: ["x.x.x.x.x.x.x.x."] },
      SR,
    );
    const peaks = peaksFrom(pcm.channels, 200);
    expect(peaks.version).toBe(1);
    expect(peaks.points).toBe(200);
    expect(peaks.min).toHaveLength(200);
    expect(peaks.max).toHaveLength(200);
    expect(Math.min(...peaks.min)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...peaks.max)).toBeLessThanOrEqual(1);
    // the shape is the audio's: the front of the bar is louder than the back
    expect(Math.max(...peaks.max.slice(0, 20))).toBeGreaterThan(Math.max(...peaks.max.slice(180)));
  });

  it("never asks for more points than there are samples", () => {
    const peaks = peaksFrom([new Float32Array(10)], 400);
    expect(peaks.points).toBe(10);
    expect(peaks.min).toHaveLength(10);
  });
});

function zeroCrossings(ch: Float32Array): number {
  let n = 0;
  for (let i = 1; i < ch.length; i++) if ((ch[i - 1] < 0 && ch[i] >= 0) || (ch[i - 1] >= 0 && ch[i] < 0)) n++;
  return n;
}
