// What a sentence does.
//
// The direction document's rule for Surface 3 is that neither half of the
// interface is the real one: everything the panels do by mouse can be said in
// a sentence, and whatever the sentence does shows up on the control the mouse
// would have used. `lib/session/commands.ts` is the parser; this is the half
// that moves the control, and it is deliberately one function so there is
// exactly one place where a sentence can change the session.
//
// It touches nothing itself. Every effect goes through the same `SessionState`
// the buttons use and the same pure arrangement functions the drags use, so
// there is no second code path by which a sentence can change the song. What
// comes back is one line in the words the control uses, which the chat echoes;
// `ok: false` means the command named something that is not there, and the
// line says so rather than guessing.

import type { RackRequest } from "@/components/rack/rackEvents";
import {
  deleteRegion,
  duplicateRegion,
  regionById,
  removeTrack as removeTrackFrom,
  splitRegion,
  trimTail,
  type Arrangement,
} from "@/lib/session/arrangement";
import { ALL_TRACKS, describeCommand, resolveRegionTarget, resolveTarget, type SessionCommand } from "@/lib/session/commands";
import { candidateAt, stepCandidate, type Rack } from "@/lib/session/rack";
import { barToSeconds, loopForBars, secondsPerBar } from "@/lib/session/time";
import type { CommandResult } from "./sessionCommands";
import type { SessionState } from "./SessionProvider";

/** Everything a command can reach that is not the session itself. */
export interface CommandEnv {
  session: SessionState;
  /** the rack on the panel, for "next", "play the third one", "keep it" */
  rack: Rack | null;
  /** the file the route has open, when there is one; a rack of its own needs it */
  openFileId: string | null;
  /** put the song on the panel */
  showSong: () => void;
  /** the panel's own history */
  panel: (action: "close" | "back") => void;
  openRack: (request: RackRequest) => void;
  zoom: (direction: "in" | "out" | "fit") => void;
}

export function applySessionCommand(command: SessionCommand, env: CommandEnv): CommandResult {
  const { session } = env;
  const say = (text: string, ok = true): CommandResult => ({ text, ok });

  switch (command.kind) {
    case "play":
      session.play();
      return say(describeCommand(command));
    case "pause":
      session.pause();
      return say(describeCommand(command));
    case "stop":
      session.stop();
      return say(describeCommand(command));
    case "loop-off":
      session.setLoop(null);
      return say(describeCommand(command));
    case "loop-seconds":
      session.setLoop({ startS: command.fromS, endS: command.toS });
      return say(describeCommand(command));
    case "loop-bars": {
      const loop = loopForBars(command.fromBar, command.toBar, session.tempo);
      if (!loop) return say("the session has no measured tempo yet, so it has no bars. Say it in seconds, or commit something with a tempo.", false);
      session.setLoop(loop);
      return say(describeCommand(command));
    }
    case "mute":
    case "solo": {
      const ids = resolveTarget(command.target, session.tracks);
      if (!ids || ids.length === 0) return say(`nothing in the session is called ${command.target === ALL_TRACKS ? "that" : command.target}.`, false);
      for (const id of ids) {
        if (command.kind === "mute") session.setMute(id, command.on);
        else session.setSolo(id, command.on);
      }
      return say(describeCommand(command));
    }
    case "gain": {
      const ids = resolveTarget(command.target, session.tracks);
      if (!ids || ids.length === 0) return say(`nothing in the session is called ${command.target}.`, false);
      for (const id of ids) session.nudgeGain(id, command.db);
      return say(describeCommand(command));
    }
    case "audition": {
      const candidate = candidateAt(env.rack, command.index);
      if (!candidate) return say(`there is no candidate ${command.index} in the rack.`, false);
      void session.audition(candidate);
      return say(`auditioning ${candidate.title}`);
    }
    case "audition-next":
    case "audition-previous": {
      const next = stepCandidate(env.rack, session.auditioning, command.kind === "audition-next" ? 1 : -1);
      if (!next) return say("that is the end of the rack.", false);
      void session.audition(next);
      return say(`auditioning ${next.title}`);
    }
    case "audition-off":
      void session.audition(null);
      return say(describeCommand(command));
    case "commit": {
      const candidate = session.auditioning;
      if (!candidate) return say("nothing is auditioning, so there is nothing to keep.", false);
      void session.commit(candidate);
      return say(`kept ${candidate.title}`);
    }
    case "rack":
      env.openRack({ source: "search", query: command.query });
      return say(describeCommand(command));
    case "rack-fits":
    case "rack-loops":
      if (!env.openFileId) return say("no file is open, so there is nothing to rack against.", false);
      env.openRack(command.kind === "rack-fits" ? { source: "compat", fileId: env.openFileId } : { source: "loops", fileId: env.openFileId });
      return say(describeCommand(command));
    case "panel":
      env.panel(command.action);
      return say(describeCommand(command));

    // --- the song ---
    // Every one of these runs the same function the mouse runs, on the same
    // grid, through the same undo stack.
    case "song":
      env.showSong();
      return say(describeCommand(command));
    case "undo":
      if (!session.canUndo) return say("there is nothing to undo yet.", false);
      session.undo();
      return say(describeCommand(command));
    case "redo":
      if (!session.canRedo) return say("there is nothing to redo.", false);
      session.redo();
      return say(describeCommand(command));
    case "snap":
      session.setSnap(command.unit);
      return say(describeCommand(command));
    case "zoom":
      env.showSong();
      env.zoom(command.direction);
      return say(describeCommand(command));
    case "move-region":
    case "trim-region":
    case "duplicate-region":
    case "split-region":
    case "delete-region": {
      const arrangement = session.arrangement;
      const found = resolveRegionTarget(command.target, arrangement.tracks, arrangement.regions, session.selectedRegionId);
      if (!found.regionId) return say(found.note ?? "there is no region to change.", false);
      const regionId = found.regionId;
      const region = regionById(arrangement, regionId);
      if (!region) return say("that region is no longer in the song.", false);
      const grid = session.grid;
      const barS = session.tempo ? secondsPerBar(session.tempo) : 0;
      let next: Arrangement = arrangement;
      if (command.kind === "move-region") {
        if (command.toBar !== null && !session.tempo) return say("the session has no measured tempo yet, so it has no bars. Say it in seconds.", false);
        const toS = command.toBar !== null && session.tempo ? barToSeconds(command.toBar, session.tempo) : (command.toS ?? region.startS);
        next = { tracks: arrangement.tracks, regions: arrangement.regions.map((r) => (r.id === regionId ? { ...r, startS: Math.max(0, toS) } : r)) };
      } else if (command.kind === "trim-region") {
        if (command.bars !== null && barS <= 0) return say("the session has no measured tempo yet, so it has no bars. Say it in seconds.", false);
        const lengthS = command.bars !== null ? command.bars * barS : (command.seconds ?? region.durationS);
        next = trimTail(arrangement, regionId, region.startS + lengthS, { grid });
      } else if (command.kind === "duplicate-region") {
        next = duplicateRegion(arrangement, regionId, { grid });
      } else if (command.kind === "split-region") {
        if (command.atBar !== null && !session.tempo) return say("the session has no measured tempo yet, so it has no bars. Split it at the playhead instead.", false);
        const atS = command.atBar !== null && session.tempo ? barToSeconds(command.atBar, session.tempo) : session.position();
        next = splitRegion(arrangement, regionId, atS, { grid });
        if (next === arrangement) return say("that cut is outside the region, so there is nothing to split.", false);
      } else {
        next = deleteRegion(arrangement, regionId);
        session.selectRegion(null);
      }
      session.edit(next, describeCommand(command));
      env.showSong();
      return say(describeCommand(command));
    }
    case "remove-track": {
      const ids = resolveTarget(command.target, session.tracks);
      if (!ids || ids.length === 0) return say(`nothing in the session is called ${command.target}.`, false);
      let next = session.arrangement;
      for (const id of ids) next = removeTrackFrom(next, id);
      session.edit(next, describeCommand(command));
      return say(describeCommand(command));
    }
  }
}
