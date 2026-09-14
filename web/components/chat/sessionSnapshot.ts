// The open session, packed for the chat request.
//
// The chat runs on the server and the session runs here, so a turn carries the
// session with it (lib/chat/surfaces.ts). This is the packing, kept as a pure
// function over plain values rather than over the providers themselves, so it
// is asserted in node without a browser.
//
// Two rules it follows:
//
//   Only the controls. Names, gains, locators, the snap division, what is
//   selected, what each chain reads. Every *measured* value — a record's
//   tempo, key or bandwidth — is deliberately left out and read on the server
//   from the report row instead, so the chat can never state a musical fact
//   that came from the browser rather than from the analysis.
//
//   The audition lane is not the song. `session.arrangement` already holds it
//   out (docs/HANDOFF_timeline.md section 1), which is what makes the export
//   render the song rather than whatever happens to be auditioning.

import { describeProcessing, processingFor } from "@/lib/processing/chain";
import { describeLimiter } from "@/lib/processing/master";
import type { ProcessingState } from "@/lib/processing/types";
import type { SessionSnapshot, SnapshotRack } from "@/lib/chat/surfaces";
import type { RackCandidate } from "@/lib/session/rack";
import type { SnapUnit } from "@/lib/session/snap";
import type { SessionTempo } from "@/lib/session/time";
import type { SessionRegion, SessionTrack, TransportLoop } from "@/lib/session/types";

export interface SnapshotInput {
  /** the song without the audition lane: `SessionState.arrangement` */
  tracks: readonly SessionTrack[];
  regions: readonly SessionRegion[];
  tempo: SessionTempo | null;
  playing: boolean;
  positionS: number;
  loop: TransportLoop | null;
  masterGain: number;
  snap: SnapUnit;
  selectedRegionId: string | null;
  undoLabel: string | null;
  redoLabel: string | null;
  processing: ProcessingState;
  focusTrackId: string | null;
  /** the candidate sounding under the session, when one is */
  auditioning: RackCandidate | null;
  openFileId: string | null;
  songName: string | null;
}

/**
 * The rack the chat can see.
 *
 * `components/rack/**` is another seam's ground and the chat pane cannot read
 * the panel's row list, so what the chat knows is what the session knows: the
 * candidate that is sounding. `listed: false` says exactly that, and the
 * server then leaves "play the third one" and "next" for the rack itself to
 * answer rather than refusing a row it cannot see. The day the rack's rows are
 * reachable from here, this becomes the whole list and `listed` becomes true.
 */
function rackOf(auditioning: RackCandidate | null): SnapshotRack | null {
  if (!auditioning) return null;
  return {
    title: "on the panel",
    listed: false,
    rows: [{ index: auditioning.rank, title: auditioning.title, reason: auditioning.reason, confidence: auditioning.confidence }],
    auditioning: auditioning.rank,
  };
}

export function buildSessionSnapshot(input: SnapshotInput): SessionSnapshot {
  const chains = input.tracks
    .map((track) => ({ trackId: track.id, line: describeProcessing(processingFor(input.processing, track.id)) }))
    .filter((c) => c.line !== "nothing on it");
  return {
    arrangement: { tracks: [...input.tracks], regions: [...input.regions] },
    tempo: input.tempo,
    playing: input.playing,
    positionS: Math.max(0, input.positionS),
    loop: input.loop ? { startS: input.loop.startS, endS: input.loop.endS } : null,
    masterGain: input.masterGain,
    snap: input.snap,
    selectedRegionId: input.selectedRegionId,
    undoLabel: input.undoLabel,
    redoLabel: input.redoLabel,
    chains,
    master: `limiter ${describeLimiter(input.processing.master.limiter)}${input.processing.master.bypassed ? ", bus bypassed" : ""}`,
    focusTrackId: input.focusTrackId,
    rack: rackOf(input.auditioning),
    openFileId: input.openFileId,
    // The instrument lives on a file's chops surface. Being on a file route is
    // necessary, not sufficient — a step that reaches nothing is answered by
    // the timeout in directive.ts rather than by a guess here.
    keyboardOpen: input.openFileId !== null,
    songName: input.songName,
  };
}
