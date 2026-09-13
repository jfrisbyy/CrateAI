// The prototype's audio, synthesised.
//
// There is no user audio in the demo and nothing may be downloaded, so the
// material a producer hears at /demo is made here: a few seconds of a chord
// bed with a bassline, and five drum breaks with different kits, tempos and
// feels. It is honest about being synthetic — the page says so — and it is
// deliberately the *only* thing about the prototype that is faked. Everything
// downstream (the decode cache, the scheduler, the engine, the rack, the
// timeline) sees the same shape it sees from a real upload.
//
// Pure and framework-free, like lib/session: every function here takes numbers
// and returns Float32Arrays, so the whole of it runs and is asserted in node.
// The browser half is lib/demo/audio.ts, which does nothing but pack these
// channels into an AudioBuffer.
//
// The DSP is deliberately plain. A convincing kick is a sine with a fast pitch
// envelope; a convincing snare is noise plus two body tones; a Rhodes is a
// sine with two decaying harmonics on top of it. Decent-sounding matters here,
// realism does not.

import type { Peaks } from "@/lib/types/db";

/** Interleaved-free PCM: one Float32Array per channel, all the same length. */
export interface Pcm {
  channels: Float32Array[];
  sampleRate: number;
  durationS: number;
}

/** Steps in a bar. Everything below is written on a 16th grid in 4/4. */
export const STEPS_PER_BAR = 16;
export const BEATS_PER_BAR = 4;

/** Seconds in one bar at a tempo, in 4/4. Same arithmetic as lib/session/time.ts. */
export function barSeconds(bpm: number): number {
  return (60 / bpm) * BEATS_PER_BAR;
}

/** Seconds in one sixteenth at a tempo. */
export function stepSeconds(bpm: number): number {
  return 60 / bpm / 4;
}

/**
 * A small deterministic PRNG (mulberry32). Noise has to be reproducible or the
 * peaks drawn on a rack row would not be the peaks of the audio that plays.
 */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Equal temperament, A4 = 440 Hz. */
export function midiHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Soft clipping, so a stacked lane is round rather than square. The Padé
 * approximation of tanh, clamped: a per-sample `Math.tanh` over a few million
 * samples is most of a second on its own.
 */
function soft(x: number): number {
  if (x <= -3) return -1;
  if (x >= 3) return 1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// A quarter of a million `Math.sin` calls is fine; fifteen million is a frozen
// tab. Every oscillator below reads this table by phase instead, with linear
// interpolation, and every envelope is a multiply per sample rather than an
// `Math.exp`. The audible difference is nothing; the difference in build time
// is about eight to one.
const SINE_SIZE = 4096;
const SINE = buildSine();

function buildSine(): Float32Array {
  const table = new Float32Array(SINE_SIZE + 1);
  for (let i = 0; i <= SINE_SIZE; i++) table[i] = Math.sin((2 * Math.PI * i) / SINE_SIZE);
  return table;
}

/** One cycle of a sine, by phase in [0, 1). */
function sine(phase: number): number {
  const x = phase * SINE_SIZE;
  const i = x | 0;
  const a = SINE[i];
  return a + (SINE[i + 1] - a) * (x - i);
}

/** Per-sample multiplier for an exponential decay with time constant `tau`. */
function decayPerSample(tau: number, sr: number): number {
  return tau <= 0 ? 0 : Math.exp(-1 / (tau * sr));
}

/**
 * A voice is cut off when its envelope is still audible, so every one of them
 * tapers over its last few milliseconds. Without it a kick truncated at 5 % of
 * its peak is a click on every beat.
 */
function tailGain(i: number, frames: number, fadeFrames: number): number {
  const left = frames - i;
  return left < fadeFrames ? left / fadeFrames : 1;
}

/** Mix one sample in, ignoring anything that falls outside the file. */
function addAt(out: Float32Array, at: number, value: number): void {
  if (at >= 0 && at < out.length) out[at] += value;
}

// --- voices ------------------------------------------------------------------

/** The knobs that make one kit sound different from the next. */
export interface Kit {
  /** kick: start and end of the pitch sweep, in Hz, and how long it rings */
  kickFrom: number;
  kickTo: number;
  kickDecayS: number;
  kickDrive: number;
  /** snare: the two body tones, the noise level and the decay */
  snareBodyHz: number;
  snareNoise: number;
  snareDecayS: number;
  /** hats: how long and how bright */
  hatDecayS: number;
  hatOpenDecayS: number;
  hatBright: number;
  /** tape hiss under the whole kit, linear */
  hiss: number;
  /** how far off the grid a hit can land, milliseconds, either side */
  jitterMs: number;
  seed: number;
}

export const KIT_DUSTY: Kit = {
  kickFrom: 116, kickTo: 47, kickDecayS: 0.30, kickDrive: 2.1,
  snareBodyHz: 186, snareNoise: 0.62, snareDecayS: 0.15,
  hatDecayS: 0.040, hatOpenDecayS: 0.22, hatBright: 0.82,
  hiss: 0.0035, jitterMs: 5.5, seed: 0x51ed,
};

export const KIT_ROOM: Kit = {
  kickFrom: 132, kickTo: 52, kickDecayS: 0.24, kickDrive: 1.5,
  snareBodyHz: 206, snareNoise: 0.70, snareDecayS: 0.20,
  hatDecayS: 0.055, hatOpenDecayS: 0.30, hatBright: 0.90,
  hiss: 0.0022, jitterMs: 3.0, seed: 0x2c71,
};

export const KIT_HEAVY: Kit = {
  kickFrom: 104, kickTo: 41, kickDecayS: 0.42, kickDrive: 2.8,
  snareBodyHz: 168, snareNoise: 0.55, snareDecayS: 0.26,
  hatDecayS: 0.048, hatOpenDecayS: 0.26, hatBright: 0.74,
  hiss: 0.0048, jitterMs: 7.0, seed: 0x9a13,
};

export const KIT_MACHINE: Kit = {
  kickFrom: 150, kickTo: 55, kickDecayS: 0.17, kickDrive: 1.1,
  snareBodyHz: 232, snareNoise: 0.80, snareDecayS: 0.10,
  hatDecayS: 0.028, hatOpenDecayS: 0.16, hatBright: 0.97,
  hiss: 0.0006, jitterMs: 0, seed: 0x4411,
};

export const KIT_LIVE: Kit = {
  kickFrom: 122, kickTo: 49, kickDecayS: 0.33, kickDrive: 1.7,
  snareBodyHz: 196, snareNoise: 0.66, snareDecayS: 0.23,
  hatDecayS: 0.062, hatOpenDecayS: 0.34, hatBright: 0.86,
  hiss: 0.0040, jitterMs: 17, seed: 0x7f2d,
};

/** Kick: a sine whose pitch falls fast, with a click on the front. */
export function addKick(out: Float32Array, atS: number, sr: number, gain: number, kit: Kit): void {
  const start = Math.round(atS * sr);
  const frames = Math.ceil(kit.kickDecayS * 3.5 * sr);
  const fade = Math.ceil(0.004 * sr);
  const dEnv = decayPerSample(kit.kickDecayS, sr);
  const dPitch = decayPerSample(0.028, sr);
  const dClick = decayPerSample(0.0035, sr);
  let phase = 0;
  let env = 1;
  let pitch = 1;
  let click = 1;
  for (let i = 0; i < frames; i++) {
    const f = kit.kickTo + (kit.kickFrom - kit.kickTo) * pitch;
    phase += f / sr;
    if (phase >= 1) phase -= 1;
    addAt(out, start + i, soft(kit.kickDrive * (sine(phase) * env + click * 0.35)) * gain * 0.9 * tailGain(i, frames, fade));
    env *= dEnv;
    pitch *= dPitch;
    click *= dClick;
  }
}

/** Snare: two body tones under a burst of high-passed noise. */
export function addSnare(out: Float32Array, atS: number, sr: number, gain: number, kit: Kit, noise: () => number): void {
  const start = Math.round(atS * sr);
  const frames = Math.ceil(kit.snareDecayS * 3.5 * sr);
  const fade = Math.ceil(0.004 * sr);
  const inc1 = kit.snareBodyHz / sr;
  const inc2 = (kit.snareBodyHz * 1.78) / sr;
  const d1 = decayPerSample(kit.snareDecayS * 0.55, sr);
  const d2 = decayPerSample(kit.snareDecayS * 0.4, sr);
  const dn = decayPerSample(kit.snareDecayS, sr);
  let p1 = 0;
  let p2 = 0;
  let e1 = 1;
  let e2 = 1;
  let en = 1;
  let hp = 0;
  let last = 0;
  for (let i = 0; i < frames; i++) {
    const body = sine(p1) * e1 * 0.55 + sine(p2) * e2 * 0.28;
    const raw = noise() * 2 - 1;
    // one-pole high pass, so the noise reads as a snare rather than a whoosh
    hp = 0.86 * (hp + raw - last);
    last = raw;
    addAt(out, start + i, soft(1.5 * (body + hp * en * kit.snareNoise)) * gain * 0.72 * tailGain(i, frames, fade));
    p1 += inc1;
    if (p1 >= 1) p1 -= 1;
    p2 += inc2;
    if (p2 >= 1) p2 -= 1;
    e1 *= d1;
    e2 *= d2;
    en *= dn;
  }
}

/** Hat: noise through two high passes with a metallic ring on top. */
export function addHat(out: Float32Array, atS: number, sr: number, gain: number, kit: Kit, open: boolean, noise: () => number): void {
  const start = Math.round(atS * sr);
  const decay = open ? kit.hatOpenDecayS : kit.hatDecayS;
  const frames = Math.ceil(decay * 3.5 * sr);
  const fade = Math.ceil(0.003 * sr);
  const a = 0.6 + 0.38 * kit.hatBright;
  const inc1 = 8400 / sr;
  const inc2 = 11700 / sr;
  const d = decayPerSample(decay, sr);
  let hp1 = 0;
  let hp2 = 0;
  let last1 = 0;
  let last2 = 0;
  let p1 = 0;
  let p2 = 0;
  let env = 1;
  for (let i = 0; i < frames; i++) {
    const raw = noise() * 2 - 1;
    hp1 = a * (hp1 + raw - last1);
    last1 = raw;
    hp2 = a * (hp2 + hp1 - last2);
    last2 = hp1;
    const ring = sine(p1) * 0.12 + sine(p2) * 0.07;
    addAt(out, start + i, (hp2 + ring) * env * gain * 0.5 * tailGain(i, frames, fade));
    p1 += inc1;
    if (p1 >= 1) p1 -= 1;
    p2 += inc2;
    if (p2 >= 1) p2 -= 1;
    env *= d;
  }
}

/** Rim / side stick: a short woody knock. */
export function addRim(out: Float32Array, atS: number, sr: number, gain: number, noise: () => number): void {
  const start = Math.round(atS * sr);
  const frames = Math.ceil(0.06 * sr);
  const fade = Math.ceil(0.003 * sr);
  const inc1 = 780 / sr;
  const inc2 = 1620 / sr;
  const d = decayPerSample(0.012, sr);
  let p1 = 0;
  let p2 = 0;
  let env = 1;
  for (let i = 0; i < frames; i++) {
    const tone = sine(p1) * 0.6 + sine(p2) * 0.3;
    addAt(out, start + i, soft(2 * (tone + (noise() * 2 - 1) * 0.25)) * env * gain * 0.5 * tailGain(i, frames, fade));
    p1 += inc1;
    if (p1 >= 1) p1 -= 1;
    p2 += inc2;
    if (p2 >= 1) p2 -= 1;
    env *= d;
  }
}

/** Bass: a sine with two harmonics and a filter that closes as the note decays. */
export function addBass(out: Float32Array, atS: number, sr: number, midi: number, durS: number, gain: number): void {
  const start = Math.round(atS * sr);
  const frames = Math.ceil((durS + 0.14) * sr);
  const fade = Math.ceil(0.004 * sr);
  const held = Math.round(durS * sr);
  const attackFrames = Math.max(1, Math.round(0.006 * sr));
  const inc = midiHz(midi) / sr;
  const dSlow = decayPerSample(1.1, sr);
  const dRelease = decayPerSample(0.05, sr);
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let slow = 1;
  let release = 1;
  let lp = 0;
  for (let i = 0; i < frames; i++) {
    const attack = i < attackFrames ? i / attackFrames : 1;
    const env = attack * release * slow;
    const raw = sine(p1) + sine(p2) * 0.33 + sine(p3) * 0.14;
    // one-pole low pass that closes with the envelope: a plucked bass, not an organ
    lp += (0.1 + 0.3 * env) * (raw - lp);
    addAt(out, start + i, soft(1.3 * lp * env) * gain * 0.6 * tailGain(i, frames, fade));
    p1 += inc;
    if (p1 >= 1) p1 -= 1;
    p2 += 2 * inc;
    while (p2 >= 1) p2 -= 1;
    p3 += 3 * inc;
    while (p3 >= 1) p3 -= 1;
    slow *= dSlow;
    if (i >= held) release *= dRelease;
  }
}

/**
 * Rhodes-ish key: a fundamental with two fast-decaying harmonics. Written to
 * two channels with a few cents of detune between them, which is all the
 * stereo width the bed needs.
 */
export function addKey(left: Float32Array, right: Float32Array, atS: number, sr: number, midi: number, durS: number, gain: number, spreadCents: number): void {
  const start = Math.round(atS * sr);
  const frames = Math.ceil((durS + 0.45) * sr);
  const fade = Math.ceil(0.006 * sr);
  const held = Math.round(durS * sr);
  const attackFrames = Math.max(1, Math.round(0.008 * sr));
  const base = midiHz(midi);
  const d1 = decayPerSample(1.5, sr);
  const d2 = decayPerSample(0.42, sr);
  const d3 = decayPerSample(0.17, sr);
  const dRelease = decayPerSample(0.22, sr);
  for (const [out, cents] of [
    [left, -spreadCents],
    [right, spreadCents],
  ] as Array<[Float32Array, number]>) {
    const inc = (base * 2 ** (cents / 1200)) / sr;
    let p1 = 0;
    let p2 = 0;
    let p3 = 0;
    let e1 = 1;
    let e2 = 1;
    let e3 = 1;
    let release = 1;
    for (let i = 0; i < frames; i++) {
      const attack = i < attackFrames ? i / attackFrames : 1;
      const v = sine(p1) * e1 + sine(p2) * 0.3 * e2 + sine(p3) * 0.11 * e3;
      addAt(out, start + i, soft(1.1 * v) * attack * release * gain * 0.34 * tailGain(i, frames, fade));
      p1 += inc;
      if (p1 >= 1) p1 -= 1;
      p2 += 2 * inc;
      while (p2 >= 1) p2 -= 1;
      p3 += 4.02 * inc;
      while (p3 >= 1) p3 -= 1;
      e1 *= d1;
      e2 *= d2;
      e3 *= d3;
      if (i >= held) release *= dRelease;
    }
  }
}

// --- patterns ----------------------------------------------------------------

/**
 * One bar of one instrument on a 16th grid.
 *
 *   kick / snare: `X` accent, `x` normal, `g` ghost, `.` rest
 *   hat:          `X` accent, `x` closed, `o` open, `.` rest
 *   rim:          `x` hit, `.` rest
 */
export type BarPattern = string;

export interface BreakSpec {
  bpm: number;
  bars: number;
  /** silence before the downbeat: a real upload almost never starts on the one */
  leadInS: number;
  kit: Kit;
  kick: BarPattern[];
  snare: BarPattern[];
  hat: BarPattern[];
  rim?: BarPattern[];
  /** how far the odd sixteenths are pushed late, as a fraction of a sixteenth */
  swing?: number;
  /** peak the result is normalised to */
  peak?: number;
}

function velocityOf(symbol: string): number {
  switch (symbol) {
    case "X":
      return 1;
    case "x":
      return 0.78;
    case "o":
      return 0.72;
    case "g":
      return 0.26;
    default:
      return 0;
  }
}

/** When step `step` of bar `bar` lands, in seconds, including swing but not jitter. */
export function stepTime(spec: { bpm: number; leadInS: number; swing?: number }, bar: number, step: number): number {
  const stepS = stepSeconds(spec.bpm);
  const swing = (spec.swing ?? 0) * (step % 2 === 1 ? stepS : 0);
  return spec.leadInS + (bar * STEPS_PER_BAR + step) * stepS + swing;
}

/**
 * A drum break: `bars` bars at `bpm`, preceded by `leadInS` of silence.
 *
 * The file is exactly `leadInS + bars * barSeconds(bpm)` long, so that a
 * candidate auditioned from its downbeat tiles the session's loop without a
 * gap and without an overhang. That is not a synthesis nicety — it is what
 * `tileCandidate` assumes about a span, and getting it wrong here would look
 * like a bug in the scheduler.
 */
export function renderBreak(spec: BreakSpec, sampleRate: number): Pcm {
  const durationS = spec.leadInS + spec.bars * barSeconds(spec.bpm);
  const frames = Math.round(durationS * sampleRate);
  const mono = new Float32Array(frames);
  const noise = rng(spec.kit.seed);
  const jitter = rng(spec.kit.seed ^ 0x5bf0);
  const jitterS = spec.kit.jitterMs / 1000;

  for (let bar = 0; bar < spec.bars; bar++) {
    const kick = spec.kick[bar % spec.kick.length] ?? "";
    const snare = spec.snare[bar % spec.snare.length] ?? "";
    const hat = spec.hat[bar % spec.hat.length] ?? "";
    const rim = spec.rim ? (spec.rim[bar % spec.rim.length] ?? "") : "";
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      const at = stepTime(spec, bar, step);
      const wobble = jitterS === 0 ? 0 : (jitter() * 2 - 1) * jitterS;
      const k = velocityOf(kick.charAt(step));
      if (k > 0) addKick(mono, Math.max(0, at + wobble), sampleRate, k, spec.kit);
      const s = velocityOf(snare.charAt(step));
      if (s > 0) addSnare(mono, Math.max(0, at + wobble), sampleRate, s, spec.kit, noise);
      const h = hat.charAt(step);
      const hv = velocityOf(h);
      if (hv > 0) addHat(mono, Math.max(0, at + wobble), sampleRate, hv, spec.kit, h === "o", noise);
      if (velocityOf(rim.charAt(step)) > 0) addRim(mono, Math.max(0, at + wobble), sampleRate, 0.7, noise);
    }
  }

  if (spec.kit.hiss > 0) {
    const hiss = rng(spec.kit.seed ^ 0x1d3f);
    for (let i = 0; i < frames; i++) mono[i] += (hiss() * 2 - 1) * spec.kit.hiss;
  }
  normalise([mono], spec.peak ?? 0.6);
  edgeFades([mono], sampleRate);
  return { channels: [mono], sampleRate, durationS };
}

// --- the bed -----------------------------------------------------------------

/** One note in the bed: which sixteenth of which bar, what pitch, how long. */
export interface BedNote {
  bar: number;
  step: number;
  midi: number;
  /** length in sixteenths */
  steps: number;
  gain?: number;
}

export interface BedSpec {
  bpm: number;
  bars: number;
  leadInS: number;
  keys: BedNote[];
  bass: BedNote[];
  peak?: number;
}

/**
 * The record the producer is already working on: a Rhodes bed with a bassline,
 * in stereo, with the same exact-length rule as a break.
 */
export function renderBed(spec: BedSpec, sampleRate: number): Pcm {
  const durationS = spec.leadInS + spec.bars * barSeconds(spec.bpm);
  const frames = Math.round(durationS * sampleRate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const stepS = stepSeconds(spec.bpm);
  const at = (note: BedNote) => spec.leadInS + (note.bar * STEPS_PER_BAR + note.step) * stepS;

  for (const note of spec.keys) {
    addKey(left, right, at(note), sampleRate, note.midi, note.steps * stepS, note.gain ?? 1, 4.5);
  }
  const mono = new Float32Array(frames);
  for (const note of spec.bass) {
    addBass(mono, at(note), sampleRate, note.midi, note.steps * stepS, note.gain ?? 1);
  }
  for (let i = 0; i < frames; i++) {
    left[i] += mono[i];
    right[i] += mono[i];
  }
  normalise([left, right], spec.peak ?? 0.44);
  edgeFades([left, right], sampleRate);
  return { channels: [left, right], sampleRate, durationS };
}

// --- shaping and measuring ---------------------------------------------------

/** Scale every channel by one factor so the loudest sample lands on `peak`. */
export function normalise(channels: Float32Array[], peak: number): void {
  let loudest = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]);
      if (v > loudest) loudest = v;
    }
  }
  if (loudest <= 0) return;
  const factor = peak / loudest;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= factor;
  }
}

/**
 * A few milliseconds of fade at each end. The transport already declicks every
 * scheduled piece; this is for the file itself, whose last bar is cut at the
 * bar line with a hat still ringing.
 */
export function edgeFades(channels: Float32Array[], sampleRate: number, fadeS = 0.004): void {
  const n = Math.min(Math.floor(fadeS * sampleRate), Math.floor((channels[0]?.length ?? 0) / 2));
  if (n <= 0) return;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const g = i / n;
      ch[i] *= g;
      ch[ch.length - 1 - i] *= g;
    }
  }
}

/**
 * The stored peaks a library row carries (docs/CONTRACTS.md section 6): a mono
 * mixdown reduced to `points` min/max pairs. The rack rows and the timeline
 * blocks draw from these, so computing them from the same samples that play is
 * what makes the drawn waveform the waveform you hear.
 */
export function peaksFrom(channels: Float32Array[], points = 400): Peaks {
  const length = channels[0]?.length ?? 0;
  const min: number[] = [];
  const max: number[] = [];
  const count = Math.max(1, Math.min(points, length));
  for (let p = 0; p < count; p++) {
    const from = Math.floor((p * length) / count);
    const to = Math.max(from + 1, Math.floor(((p + 1) * length) / count));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to && i < length; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i];
      const v = sum / Math.max(1, channels.length);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min.push(Number(lo.toFixed(4)));
    max.push(Number(hi.toFixed(4)));
  }
  return { version: 1, points: count, min, max };
}

/** Bytes a Pcm would occupy once it is an AudioBuffer; the decode cache's accounting. */
export function pcmBytes(pcm: Pcm): number {
  return pcm.channels.length * (pcm.channels[0]?.length ?? 0) * 4;
}
