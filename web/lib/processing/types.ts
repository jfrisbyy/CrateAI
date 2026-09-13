// Corrective processing: what a track's chain is, as data.
//
// The line this folder holds (docs/PRODUCT_DIRECTION.md, "Also in scope —
// corrective processing"):
//
//   In: anything that answers "does this fit, and can I make it fit?"
//   Out: anything that is production for its own sake.
//
// A separated trumpet came back dull and the only verdict available was "all
// three of these suck". An EQ answers that in ten seconds. A mastering chain
// does not, so there is not one. The limits below are where that line is
// actually drawn in code: a boost bigger than MAX_BOOST_DB or a high-pass
// above HIGHPASS_CEILING_HZ has stopped being a correction and started being
// an effect, and the AI seam clamps to these rather than doing what it is told.
//
// Everything here is plain data. No Web Audio, no React: the decisions live in
// eq.ts / chain.ts / plan.ts as pure functions, graph.ts only turns a plan into
// node parameters, and that split is why the arithmetic is asserted in node.

/** The seven slots in a track's EQ. Fixed, so a curve, a sentence and a stored row always mean the same band. */
export type BandId = "hp" | "ls" | "lo" | "mid" | "hi" | "hs" | "lp";

export const BAND_IDS: readonly BandId[] = ["hp", "ls", "lo", "mid", "hi", "hs", "lp"];

/** The biquad shape a slot uses when it is doing something. Matches BiquadFilterNode's type strings. */
export type BandKind = "highpass" | "lowshelf" | "peaking" | "highshelf" | "lowpass";

export interface EqBand {
  id: BandId;
  kind: BandKind;
  /** Hz */
  frequency: number;
  /** dB; always 0 for the pass filters, which have no gain */
  gainDb: number;
  /**
   * Resonance. Ignored by the shelves: the Web Audio spec computes shelving
   * filters with S = 1 and does not read Q, so the curve here does not read it
   * either, or the drawing and the sound would disagree.
   */
  q: number;
  enabled: boolean;
}

/**
 * One track's chain. Processing is a property of the track and survives with
 * it (persist.ts, and the migration), and it is never destructive: the source
 * audio is untouched and `removeProcessing` takes the whole thing off again.
 */
export interface TrackProcessing {
  /**
   * The A/B. True routes the dry signal straight through — a real bypass, not
   * a chain set to neutral — and it is the control a producer reaches for most.
   */
  bypassed: boolean;
  /** gain staging, dB, before the filters so a boost does not run the chain hot */
  trimDb: number;
  /**
   * Tuning, in cents. Honest about what it is: this resamples, so pitch and
   * time move together the way a sampler or a turntable does, exactly like a
   * region's own `rate`. Real pitch-shifting with time held is a render on the
   * compute side and is not pretended at here.
   */
  tuneCents: number;
  bands: EqBand[];
}

export interface LimiterSettings {
  enabled: boolean;
  /** dB; where it starts holding the peaks back */
  ceilingDb: number;
  releaseMs: number;
}

/**
 * The master bus: a level and a gentle limiter, and nothing else. There is no
 * makeup gain on purpose — makeup is what turns a safety net into a loudness
 * tool, and that is the far side of the line.
 */
export interface MasterProcessing {
  bypassed: boolean;
  limiter: LimiterSettings;
}

export interface ProcessingState {
  /** keyed by track id; a track with no entry has no chain at all */
  tracks: Record<string, TrackProcessing>;
  master: MasterProcessing;
}

// --- the limits, which are where the scope line lives -----------------------

export const MIN_FREQ_HZ = 20;
export const MAX_FREQ_HZ = 20000;
/** A boost past this is not a correction. Cuts may go deeper: taking something out is always corrective. */
export const MAX_BOOST_DB = 12;
export const MAX_CUT_DB = 24;
export const MIN_Q = 0.2;
export const MAX_Q = 18;
/** Gain staging, not a fader: the lane's fader is the level control and lives in mix.ts. */
export const MAX_TRIM_DB = 12;
/** An octave either way. Past that a producer wants a render, not a playback trick. */
export const MAX_TUNE_CENTS = 1200;
/** A high-pass above this stops clearing room and starts being a telephone effect. */
export const HIGHPASS_CEILING_HZ = 400;
/** A low-pass below this is the same thing from the other end. */
export const LOWPASS_FLOOR_HZ = 800;
export const MIN_CEILING_DB = -24;
export const MAX_CEILING_DB = 0;
export const MIN_RELEASE_MS = 20;
export const MAX_RELEASE_MS = 1000;

/** What each slot is called where a producer can read it. */
export const BAND_NAMES: Readonly<Record<BandId, string>> = {
  hp: "High-pass",
  ls: "Low shelf",
  lo: "Low mid",
  mid: "Mid",
  hi: "High mid",
  hs: "High shelf",
  lp: "Low-pass",
};

export const BAND_KINDS: Readonly<Record<BandId, BandKind>> = {
  hp: "highpass",
  ls: "lowshelf",
  lo: "peaking",
  mid: "peaking",
  hi: "peaking",
  hs: "highshelf",
  lp: "lowpass",
};

/** The words a producer uses for a part of the spectrum, and where it is. */
export type SpectralRegion = "lows" | "low mids" | "mids" | "high mids" | "highs" | "air";

export const REGION_HZ: Readonly<Record<SpectralRegion, number>> = {
  lows: 80,
  "low mids": 250,
  mids: 900,
  "high mids": 3000,
  highs: 7000,
  air: 12000,
};

/** Which slot a region of the spectrum belongs to. */
export const REGION_BAND: Readonly<Record<SpectralRegion, BandId>> = {
  lows: "ls",
  "low mids": "lo",
  mids: "mid",
  "high mids": "hi",
  highs: "hs",
  air: "hs",
};

/**
 * An EQ move said out loud, before anything decides which slot it lands on.
 * The parser in lib/session/commands.ts produces one of these and knows
 * nothing else about processing; complaints.ts turns it into real moves.
 */
export interface EqPhrase {
  move: "cut" | "boost" | "highpass" | "lowpass";
  /** the frequency the producer named, Hz, or null when they named a region instead */
  atHz: number | null;
  region: SpectralRegion | null;
  /** how much, dB, or null for the default step */
  db: number | null;
}

export function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}
