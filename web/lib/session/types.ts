// The session's data model: a transport clock, tracks as gain nodes on a
// shared bus, and regions of decoded audio laid on a timeline.
//
// Everything in this folder is framework-free and, apart from webAudio.ts,
// free of Web Audio too: the scheduling is pure functions over a clock, so it
// runs and is asserted in node. The browser only supplies a clock, gain nodes
// and buffer sources (TransportBackend below).
//
// Times: session seconds are positions on the session timeline; wall seconds
// are the backend clock's own monotonic time (AudioContext.currentTime in the
// browser, a number a test controls in node). Suffix `S` for session seconds,
// `Wall` for clock seconds. Gains are linear, never dB.

/** A region's audio, addressed by id; the decode cache turns one into samples. */
export type SourceId = string;

export interface TransportLoop {
  /** session seconds; the locators */
  startS: number;
  endS: number;
}

/**
 * Where the playhead is and how it moves. The position is not stored: it is
 * derived from the anchor and the clock, so the playhead can never drift away
 * from the audio (`time.ts` `positionAt`).
 */
export interface TransportState {
  playing: boolean;
  /** session seconds at `anchorWall` */
  anchorS: number;
  /** backend clock seconds the anchor was taken at */
  anchorWall: number;
  /** locators, or null when the transport runs straight through */
  loop: TransportLoop | null;
}

export const STOPPED: TransportState = { playing: false, anchorS: 0, anchorWall: 0, loop: null };

/** One lane on the bus. Regions belong to a track; the track owns the gain node. */
export interface SessionTrack {
  id: string;
  name: string;
  /** linear, 1 is unity */
  gain: number;
  muted: boolean;
  soloed: boolean;
  /** the library file this lane came from, when it came from one */
  fileId: string | null;
  /** what made this track: a committed candidate, an audition, an upload */
  origin: TrackOrigin;
  /** a line the UI can show without a round trip: "Masquerade, drums, bars 9-16" */
  provenance: string | null;
  /** the audition lane is replaced in place when the producer A/Bs the rack */
  ephemeral?: boolean;
}

export type TrackOrigin = "candidate" | "audition" | "file" | "render";

/** A piece of one source placed on the timeline. */
export interface SessionRegion {
  id: string;
  trackId: string;
  sourceId: SourceId;
  /** session seconds the region starts at */
  startS: number;
  /** how long it sounds, session seconds */
  durationS: number;
  /** seconds into the source the region starts — the downbeat, not the file's zero */
  offsetS: number;
  /** linear region trim on top of the track gain */
  gain: number;
  /**
   * Playback rate. 1 is the recording's own speed. Anything else resamples:
   * the pitch moves with the tempo, the way a sampler or a turntable does, and
   * the way a producer fitting a break expects. Real time-stretching (pitch
   * held) is a render on the compute side, not a playback trick — see the
   * handoff. Optional; absent means 1.
   */
  rate?: number;
}

/**
 * One `AudioBufferSourceNode` worth of work: what to play, when on the clock,
 * from where in the source, and for how long. `planWindow` produces these and
 * a backend turns each into exactly one node.
 */
export interface ScheduledPlay {
  /** `${regionId}|${pass}`: one piece of one region on one pass of the loop */
  key: string;
  regionId: string;
  trackId: string;
  sourceId: SourceId;
  /** backend clock seconds to start at */
  whenWall: number;
  /** seconds into the source buffer */
  offsetS: number;
  /** seconds of audio to play */
  durationS: number;
  /** session second the piece starts on — the playhead position at `whenWall` */
  sessionStartS: number;
  /** how many times the loop has wrapped; 0 is the first pass */
  pass: number;
  /** region gain (the track's gain lives on the track's node, not here) */
  gain: number;
  /** playback rate; 1 unless the region is resampled to fit */
  rate: number;
  /**
   * True when the piece does not start at the region's own start: a seek into
   * the middle, a loop that wraps inside the region, or a track whose audio
   * finished decoding after the region was already under the playhead.
   */
  joined: boolean;
}

/** The browser half. One implementation (webAudio.ts) and one fake per test. */
export interface TransportBackend {
  /** monotonic clock seconds; the audio hardware's, not the wall clock's */
  now(): number;
  /** resume a context suspended until a gesture; safe to call repeatedly */
  resume(): void | Promise<void>;
  /** a lane exists (and its gain node with it) before any region plays on it */
  ensureTrack(trackId: string): void;
  removeTrack(trackId: string): void;
  setTrackGain(trackId: string, gain: number): void;
  setMasterGain(gain: number): void;
  /** are this source's samples in memory right now? */
  isReady(sourceId: SourceId): boolean;
  /** start one piece; false when it could not sound, and the engine retries */
  start(play: ScheduledPlay): boolean;
  /** silence everything now (a stop, a seek, a pause) */
  stopAll(): void;
  /** silence one lane now, leaving the rest playing (the A/B swap) */
  stopTrack(trackId: string): void;
}

/** What drives the lookahead. Injected so a test steps it by hand. */
export interface Ticker {
  start(fn: () => void): void;
  stop(): void;
}

/** Schedule this far past the playhead on every tick. */
export const LOOKAHEAD_S = 0.25;
/** How often the lookahead runs. A quarter of the lookahead: three chances to land each piece. */
export const TICK_MS = 60;
/** Pieces shorter than this are not worth a node. */
export const MIN_PIECE_S = 1e-4;
/** A loop shorter than this is treated as no loop at all: it would spin the planner. */
export const MIN_LOOP_S = 0.02;
/** Slack when comparing times that arithmetic should have made equal. */
export const EPS = 1e-9;
