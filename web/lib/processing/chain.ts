// A track's chain, and every edit to it as a pure function.
//
// The same shape the arrangement uses (lib/session/arrangement.ts): an edit
// takes a chain and returns a new one, or returns the one it was given when
// nothing changed. That identity is meaningful — the provider uses it to
// decide whether the graph needs touching at all, and a drag that ended where
// it started does not ramp a parameter for nothing.
//
// Nothing here knows about Web Audio or React, and nothing here decides what a
// complaint means: that is complaints.ts and propose.ts, which both come back
// through these same functions. There is no second way to change a chain.

import { formatDb, formatHz } from "./eq";
import {
  BAND_IDS,
  BAND_KINDS,
  BAND_NAMES,
  clamp,
  HIGHPASS_CEILING_HZ,
  LOWPASS_FLOOR_HZ,
  MAX_BOOST_DB,
  MAX_CEILING_DB,
  MAX_CUT_DB,
  MAX_FREQ_HZ,
  MAX_Q,
  MAX_RELEASE_MS,
  MAX_TRIM_DB,
  MAX_TUNE_CENTS,
  MIN_CEILING_DB,
  MIN_FREQ_HZ,
  MIN_Q,
  MIN_RELEASE_MS,
  type BandId,
  type EqBand,
  type MasterProcessing,
  type ProcessingState,
  type TrackProcessing,
} from "./types";

/**
 * Where each slot sits before anyone touches it. Chosen as the places a
 * producer reaches for first on separated material: 80 Hz for the rumble a
 * separator leaves behind, 250 Hz for mud, 3 kHz for the honk of a horn that
 * has been through a model, 8 kHz for the air that separation took away.
 * All disabled: an EQ that does something before you ask is a worse EQ.
 */
const DEFAULT_BAND: Readonly<Record<BandId, { frequency: number; q: number }>> = {
  hp: { frequency: 80, q: 0.707 },
  ls: { frequency: 120, q: 0.707 },
  lo: { frequency: 250, q: 1.1 },
  mid: { frequency: 900, q: 1.1 },
  hi: { frequency: 3000, q: 1.1 },
  hs: { frequency: 8000, q: 0.707 },
  lp: { frequency: 12000, q: 0.707 },
};

export function defaultBands(): EqBand[] {
  return BAND_IDS.map((id) => ({
    id,
    kind: BAND_KINDS[id],
    frequency: DEFAULT_BAND[id].frequency,
    gainDb: 0,
    q: DEFAULT_BAND[id].q,
    enabled: false,
  }));
}

export function defaultProcessing(): TrackProcessing {
  // Bypassed to start with, and that is not timidity: an untouched track has to
  // be bit-identical to no processing at all, and the only way to promise that
  // is for the dry path to be the one that is sounding.
  return { bypassed: true, trimDb: 0, tuneCents: 0, bands: defaultBands() };
}

export function defaultMaster(): MasterProcessing {
  return { bypassed: true, limiter: { enabled: false, ceilingDb: -1, releaseMs: 120 } };
}

export function defaultState(): ProcessingState {
  return { tracks: {}, master: defaultMaster() };
}

/** The chain on a track, or the default one when it has never been touched. */
export function processingFor(state: ProcessingState, trackId: string): TrackProcessing {
  return state.tracks[trackId] ?? defaultProcessing();
}

export function hasProcessing(state: ProcessingState, trackId: string): boolean {
  return state.tracks[trackId] !== undefined;
}

export function bandOf(processing: TrackProcessing, id: BandId): EqBand {
  const found = processing.bands.find((b) => b.id === id);
  if (found) return found;
  const fallback = DEFAULT_BAND[id];
  return { id, kind: BAND_KINDS[id], frequency: fallback.frequency, gainDb: 0, q: fallback.q, enabled: false };
}

// --- clamping, which is where the scope line is enforced ---------------------

export function clampFrequency(id: BandId, hz: number): number {
  const base = clamp(hz, MIN_FREQ_HZ, MAX_FREQ_HZ);
  // A high-pass past 400 Hz or a low-pass under 800 Hz has stopped clearing
  // room for something else and become an effect, which is the far side of the
  // line in PRODUCT_DIRECTION. The control simply does not go there.
  if (id === "hp") return Math.min(base, HIGHPASS_CEILING_HZ);
  if (id === "lp") return Math.max(base, LOWPASS_FLOOR_HZ);
  return base;
}

export function clampGainDb(id: BandId, db: number): number {
  if (id === "hp" || id === "lp") return 0;
  return clamp(db, -MAX_CUT_DB, MAX_BOOST_DB);
}

export function clampQ(q: number): number {
  return clamp(q, MIN_Q, MAX_Q);
}

export function clampTrimDb(db: number): number {
  return clamp(db, -MAX_TRIM_DB, MAX_TRIM_DB);
}

export function clampTuneCents(cents: number): number {
  return clamp(cents, -MAX_TUNE_CENTS, MAX_TUNE_CENTS);
}

// --- the edits ---------------------------------------------------------------

export type BandPatch = Partial<Pick<EqBand, "frequency" | "gainDb" | "q" | "enabled">>;

/** Move one band. Returns the chain it was given when the numbers land where they already are. */
export function setBand(processing: TrackProcessing, id: BandId, patch: BandPatch): TrackProcessing {
  const current = bandOf(processing, id);
  const next: EqBand = {
    ...current,
    kind: BAND_KINDS[id],
    frequency: patch.frequency === undefined ? current.frequency : clampFrequency(id, patch.frequency),
    gainDb: patch.gainDb === undefined ? current.gainDb : clampGainDb(id, patch.gainDb),
    q: patch.q === undefined ? current.q : clampQ(patch.q),
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
  };
  if (sameBand(current, next)) return processing;
  const bands = BAND_IDS.map((bandId) => (bandId === id ? next : bandOf(processing, bandId)));
  return { ...processing, bands };
}

export function sameBand(a: EqBand, b: EqBand): boolean {
  return a.id === b.id && a.kind === b.kind && a.frequency === b.frequency && a.gainDb === b.gainDb && a.q === b.q && a.enabled === b.enabled;
}

export function toggleBand(processing: TrackProcessing, id: BandId): TrackProcessing {
  return setBand(processing, id, { enabled: !bandOf(processing, id).enabled });
}

export function setTrim(processing: TrackProcessing, db: number): TrackProcessing {
  const trimDb = clampTrimDb(db);
  return trimDb === processing.trimDb ? processing : { ...processing, trimDb };
}

export function setTune(processing: TrackProcessing, cents: number): TrackProcessing {
  const tuneCents = clampTuneCents(cents);
  return tuneCents === processing.tuneCents ? processing : { ...processing, tuneCents };
}

export function setBypass(processing: TrackProcessing, bypassed: boolean): TrackProcessing {
  return bypassed === processing.bypassed ? processing : { ...processing, bypassed };
}

/** Everything off, the bands back where they started. The chain is still there; it is just not doing anything. */
export function resetProcessing(): TrackProcessing {
  return defaultProcessing();
}

/** Is this chain doing nothing at all, whether or not it is bypassed? */
export function isNeutral(processing: TrackProcessing): boolean {
  if (processing.trimDb !== 0 || processing.tuneCents !== 0) return false;
  return !processing.bands.some(activeBand);
}

/** A band that would change the sound if the chain were engaged. */
export function activeBand(band: EqBand): boolean {
  if (!band.enabled) return false;
  if (band.kind === "highpass" || band.kind === "lowpass") return true;
  return band.gainDb !== 0;
}

export function activeBands(processing: TrackProcessing): EqBand[] {
  return processing.bands.filter(activeBand);
}

/** Is anything actually being heard from this chain right now? */
export function isEngaged(processing: TrackProcessing): boolean {
  return !processing.bypassed && !isNeutral(processing);
}

// --- the state ---------------------------------------------------------------

export function setTrackProcessing(state: ProcessingState, trackId: string, processing: TrackProcessing): ProcessingState {
  if (state.tracks[trackId] === processing) return state;
  return { ...state, tracks: { ...state.tracks, [trackId]: processing } };
}

export function editTrack(state: ProcessingState, trackId: string, edit: (processing: TrackProcessing) => TrackProcessing): ProcessingState {
  const current = processingFor(state, trackId);
  const next = edit(current);
  if (next === current && hasProcessing(state, trackId)) return state;
  return setTrackProcessing(state, trackId, next);
}

/**
 * Take the chain off entirely. Processing is never destructive — the samples
 * were never touched — so removing it is the whole undo, and a track with no
 * entry has no nodes doing anything.
 */
export function removeProcessing(state: ProcessingState, trackId: string): ProcessingState {
  if (!hasProcessing(state, trackId)) return state;
  const tracks = { ...state.tracks };
  delete tracks[trackId];
  return { ...state, tracks };
}

/** Drop chains for lanes that are no longer in the session. */
export function pruneProcessing(state: ProcessingState, trackIds: readonly string[]): ProcessingState {
  const keep = new Set(trackIds);
  const gone = Object.keys(state.tracks).filter((id) => !keep.has(id));
  if (gone.length === 0) return state;
  const tracks = { ...state.tracks };
  for (const id of gone) delete tracks[id];
  return { ...state, tracks };
}

// --- the master bus -----------------------------------------------------------

export function setMaster(state: ProcessingState, master: MasterProcessing): ProcessingState {
  return state.master === master ? state : { ...state, master };
}

export function setLimiter(master: MasterProcessing, patch: Partial<MasterProcessing["limiter"]>): MasterProcessing {
  const limiter = {
    enabled: patch.enabled ?? master.limiter.enabled,
    ceilingDb: patch.ceilingDb === undefined ? master.limiter.ceilingDb : clamp(patch.ceilingDb, MIN_CEILING_DB, MAX_CEILING_DB),
    releaseMs: patch.releaseMs === undefined ? master.limiter.releaseMs : clamp(patch.releaseMs, MIN_RELEASE_MS, MAX_RELEASE_MS),
  };
  const same = limiter.enabled === master.limiter.enabled && limiter.ceilingDb === master.limiter.ceilingDb && limiter.releaseMs === master.limiter.releaseMs;
  if (same) return master;
  // Turning the limiter on is what takes the master out of bypass; there is
  // nothing else on the bus, so a bypassed master with a limiter on would be a
  // control that lies.
  return { ...master, limiter, bypassed: limiter.enabled ? false : master.bypassed };
}

export function setMasterBypass(master: MasterProcessing, bypassed: boolean): MasterProcessing {
  return bypassed === master.bypassed ? master : { ...master, bypassed };
}

// --- saying what it is ---------------------------------------------------------

/** One band in the words a producer uses: "250 Hz -4 dB, Q 1.1", "high-pass at 80 Hz". */
export function describeBand(band: EqBand): string {
  const name = BAND_NAMES[band.id];
  if (band.kind === "highpass" || band.kind === "lowpass") return `${name.toLowerCase()} at ${formatHz(band.frequency)}`;
  return `${formatHz(band.frequency)} ${formatDb(band.gainDb)}${band.kind === "peaking" ? `, Q ${round(band.q, 2)}` : " shelf"}`;
}

/**
 * The whole chain in one line, for a lane header, an echo under the composer,
 * or a chat turn. Says "bypassed" rather than hiding it, because a chain you
 * cannot hear that reads as if you can is the worst possible readout.
 */
export function describeProcessing(processing: TrackProcessing): string {
  const parts: string[] = [];
  if (processing.trimDb !== 0) parts.push(`trim ${formatDb(processing.trimDb)}`);
  if (processing.tuneCents !== 0) parts.push(`tuned ${processing.tuneCents > 0 ? "+" : ""}${round(processing.tuneCents, 0)} cents`);
  for (const band of activeBands(processing)) parts.push(describeBand(band));
  if (parts.length === 0) return processing.bypassed ? "nothing on it" : "nothing on it";
  const line = parts.join(", ");
  return processing.bypassed ? `${line} (bypassed)` : line;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
