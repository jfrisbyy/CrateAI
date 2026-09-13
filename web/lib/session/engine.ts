// The session transport: one clock, tracks on a shared bus, regions scheduled
// ahead of the playhead.
//
// The engine holds the state and runs the lookahead; `planWindow` decides what
// sounds and a `TransportBackend` makes it sound. Both of those are injected,
// so this class runs whole in node against a fake backend and a hand-stepped
// ticker — which is how the loop wrap, the A/B swap and the late decode are
// tested without a browser.
//
// What the engine guarantees:
//
//  - The playhead is derived from the clock, so it cannot drift from the audio.
//  - A piece is started once. Ticks may overlap, repeat or arrive late.
//  - Changing the mix never restarts anything. Mute, solo and gain move gain
//    nodes; the sources keep running, so unmuting lands on the beat.
//  - Changing a lane's material stops that lane and nothing else, then the new
//    material joins in progress at the right point in the bar. That is the
//    rack's A/B, and it is why auditioning does not interrupt the session.
//  - A source that is still decoding is not an error. Its region is reported as
//    waiting, and the moment the samples land the region joins mid-way.

import { mixOf } from "./mix";
import { planWindow } from "./schedule";
import { clampToLoop, positionAt } from "./time";
import {
  LOOKAHEAD_S,
  TICK_MS,
  type ScheduledPlay,
  type SessionRegion,
  type SessionTrack,
  type SourceId,
  type Ticker,
  type TransportBackend,
  type TransportLoop,
  type TransportState,
} from "./types";

/** Start this far ahead of "now" so the first pieces are scheduled, not chased. */
export const START_LEAD_S = 0.03;
/** Keys older than this are dropped; they can never come round again. */
const KEY_TTL_S = 2;

export interface EngineOptions {
  backend: TransportBackend;
  ticker?: Ticker;
  lookaheadS?: number;
  /** master bus gain, linear */
  masterGain?: number;
}

export interface EngineSnapshot {
  tracks: SessionTrack[];
  regions: SessionRegion[];
  transport: TransportState;
  masterGain: number;
  /** sources a region needs and has not got; the UI shows these lanes as loading */
  waiting: SourceId[];
}

export function intervalTicker(ms = TICK_MS): Ticker {
  let handle: ReturnType<typeof setInterval> | null = null;
  return {
    start(fn) {
      if (handle !== null) clearInterval(handle);
      handle = setInterval(fn, ms);
    },
    stop() {
      if (handle !== null) clearInterval(handle);
      handle = null;
    },
  };
}

export class SessionEngine {
  private readonly backend: TransportBackend;
  private readonly ticker: Ticker;
  private readonly lookaheadS: number;

  private tracks: SessionTrack[] = [];
  private regions: SessionRegion[] = [];
  private transport: TransportState;
  private master: number;
  /** key -> clock time the piece finishes, for pruning */
  private scheduled = new Map<string, number>();
  private waiting: SourceId[] = [];
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private running = false;

  constructor(options: EngineOptions) {
    this.backend = options.backend;
    this.ticker = options.ticker ?? intervalTicker();
    this.lookaheadS = options.lookaheadS ?? LOOKAHEAD_S;
    this.master = options.masterGain ?? 1;
    this.transport = { playing: false, anchorS: 0, anchorWall: this.backend.now(), loop: null };
    this.backend.setMasterGain(this.master);
  }

  // --- reading ------------------------------------------------------------

  /** The playhead, in session seconds, right now. */
  position(): number {
    return positionAt(this.transport, this.backend.now());
  }

  get isPlaying(): boolean {
    return this.transport.playing;
  }

  get loop(): TransportLoop | null {
    return this.transport.loop;
  }

  snapshot(): EngineSnapshot {
    return { tracks: this.tracks, regions: this.regions, transport: this.transport, masterGain: this.master, waiting: this.waiting };
  }

  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Every source the session needs held in memory: what the decode cache pins. */
  sources(): SourceId[] {
    return [...new Set(this.regions.map((r) => r.sourceId))];
  }

  // --- tracks -------------------------------------------------------------

  setTracks(tracks: SessionTrack[]): void {
    const gone = this.tracks.filter((t) => !tracks.some((n) => n.id === t.id));
    this.tracks = tracks;
    for (const track of gone) {
      this.backend.stopTrack(track.id);
      this.backend.removeTrack(track.id);
      this.dropKeysForTrack(track.id);
      // A lane that is gone takes its material with it, or the scheduler would
      // keep starting regions on a lane that has no fader.
      this.regions = this.regions.filter((r) => r.trackId !== track.id);
    }
    for (const track of tracks) this.backend.ensureTrack(track.id);
    this.syncMix();
    this.emit();
  }

  addTrack(track: SessionTrack, regions: SessionRegion[] = []): void {
    const without = this.tracks.filter((t) => t.id !== track.id);
    this.tracks = [...without, track];
    this.backend.ensureTrack(track.id);
    if (regions.length > 0) this.setTrackRegions(track.id, regions);
    else {
      this.syncMix();
      this.emit();
    }
  }

  removeTrack(trackId: string): void {
    this.tracks = this.tracks.filter((t) => t.id !== trackId);
    this.regions = this.regions.filter((r) => r.trackId !== trackId);
    this.backend.stopTrack(trackId);
    this.backend.removeTrack(trackId);
    this.dropKeysForTrack(trackId);
    this.syncMix();
    this.tick();
    this.emit();
  }

  patchTrack(trackId: string, patch: Partial<Omit<SessionTrack, "id">>): void {
    this.tracks = this.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t));
    this.syncMix();
    this.emit();
  }

  setMute(trackId: string, muted: boolean): void {
    this.patchTrack(trackId, { muted });
  }

  setSolo(trackId: string, soloed: boolean): void {
    this.patchTrack(trackId, { soloed });
  }

  setGain(trackId: string, gain: number): void {
    this.patchTrack(trackId, { gain });
  }

  setMasterGain(gain: number): void {
    this.master = gain;
    this.backend.setMasterGain(gain);
    this.emit();
  }

  /**
   * Replace one lane's material while everything else keeps playing. The lane's
   * sources are stopped, its keys dropped, and the next plan starts the new
   * regions where the playhead already is — the same bar, mid-phrase. This is
   * the rack's "try the next candidate" and the reason it is one call.
   */
  setTrackRegions(trackId: string, regions: SessionRegion[]): void {
    this.backend.stopTrack(trackId);
    this.dropKeysForTrack(trackId);
    this.regions = [...this.regions.filter((r) => r.trackId !== trackId), ...regions];
    this.backend.ensureTrack(trackId);
    this.syncMix();
    this.tick();
    this.emit();
  }

  setRegions(regions: SessionRegion[]): void {
    this.backend.stopAll();
    this.scheduled.clear();
    this.regions = regions;
    this.tick();
    this.emit();
  }

  regionsOf(trackId: string): SessionRegion[] {
    return this.regions.filter((r) => r.trackId === trackId);
  }

  // --- transport ----------------------------------------------------------

  play(): void {
    if (this.transport.playing) return;
    void this.backend.resume();
    const now = this.backend.now();
    this.transport = {
      playing: true,
      anchorS: clampToLoop(this.transport.anchorS, this.transport.loop),
      anchorWall: now + START_LEAD_S,
      loop: this.transport.loop,
    };
    this.scheduled.clear();
    this.startTicking();
    this.tick();
    this.emit();
  }

  pause(): void {
    if (!this.transport.playing) return;
    const at = this.position();
    this.transport = { ...this.transport, playing: false, anchorS: at, anchorWall: this.backend.now() };
    this.backend.stopAll();
    this.scheduled.clear();
    this.stopTicking();
    this.emit();
  }

  /** Pause and return the playhead to the loop start, or to zero when there is none. */
  stop(): void {
    const home = this.transport.loop ? this.transport.loop.startS : 0;
    this.transport = { playing: false, anchorS: home, anchorWall: this.backend.now(), loop: this.transport.loop };
    this.backend.stopAll();
    this.scheduled.clear();
    this.stopTicking();
    this.emit();
  }

  toggle(): void {
    if (this.transport.playing) this.pause();
    else this.play();
  }

  /** Move the playhead. Playing across a seek is seamless: sources restart at the new position. */
  seek(sessionS: number): void {
    const at = Math.max(0, sessionS);
    if (this.transport.playing) {
      this.backend.stopAll();
      this.scheduled.clear();
      this.transport = { ...this.transport, anchorS: at, anchorWall: this.backend.now() + START_LEAD_S };
      this.tick();
    } else {
      this.transport = { ...this.transport, anchorS: at, anchorWall: this.backend.now() };
    }
    this.emit();
  }

  /**
   * Set or clear the locators. Moving them while playing keeps the playhead
   * where it is when it is still inside the new loop, and takes it to the new
   * start when it is not — so dragging the right locator past the playhead
   * does not leave the transport stranded outside its own loop.
   */
  setLoop(loop: TransportLoop | null): void {
    const wasPlaying = this.transport.playing;
    const at = this.position();
    this.transport = { ...this.transport, loop };
    if (wasPlaying) {
      const next = clampToLoop(at, loop);
      this.backend.stopAll();
      this.scheduled.clear();
      this.transport = { ...this.transport, anchorS: next, anchorWall: this.backend.now() + START_LEAD_S };
      this.tick();
    } else {
      this.transport = { ...this.transport, anchorS: clampToLoop(at, loop) };
    }
    this.emit();
  }

  // --- the lookahead ------------------------------------------------------

  /** A decode landed: re-plan at once so the lane joins in progress, not at the next pass. */
  sourceReady(_sourceId: SourceId): void {
    if (!this.transport.playing) return;
    this.tick();
  }

  /** One pass of the lookahead. Safe to call at any time, from anywhere. */
  tick(): void {
    if (!this.transport.playing) return;
    const now = this.backend.now();
    const plan = planWindow({
      transport: this.transport,
      regions: this.regions,
      fromWall: now,
      toWall: now + this.lookaheadS,
      scheduled: new Set(this.scheduled.keys()),
      isReady: (sourceId) => this.backend.isReady(sourceId),
    });
    for (const play of plan.plays) {
      if (this.backend.start(play)) this.scheduled.set(play.key, play.whenWall + play.durationS);
    }
    this.pruneKeys(now);
    const changed = plan.waiting.length !== this.waiting.length || plan.waiting.some((s, i) => s !== this.waiting[i]);
    this.waiting = plan.waiting;
    if (changed) this.emit();
  }

  /** Stop the clock and release the lanes. The backend's own teardown is its business. */
  dispose(): void {
    this.stopTicking();
    this.backend.stopAll();
    this.scheduled.clear();
    this.listeners.clear();
  }

  // --- internals ----------------------------------------------------------

  private startTicking(): void {
    if (this.running) return;
    this.running = true;
    this.ticker.start(() => this.tick());
  }

  private stopTicking(): void {
    if (!this.running) return;
    this.running = false;
    this.ticker.stop();
  }

  private syncMix(): void {
    for (const [trackId, gain] of mixOf(this.tracks)) this.backend.setTrackGain(trackId, gain);
  }

  private dropKeysForTrack(trackId: string): void {
    const ids = new Set(this.regions.filter((r) => r.trackId === trackId).map((r) => r.id));
    for (const key of [...this.scheduled.keys()]) {
      if (ids.has(key.slice(0, key.lastIndexOf("|")))) this.scheduled.delete(key);
    }
  }

  private pruneKeys(now: number): void {
    for (const [key, endWall] of this.scheduled) {
      if (endWall < now - KEY_TTL_S) this.scheduled.delete(key);
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/** What a backend does with a piece, for the tests and for the adapter to mirror. */
export type StartResult = ReturnType<TransportBackend["start"]>;
export type { ScheduledPlay };
