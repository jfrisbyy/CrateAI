"use client";

// The dock: where the chain lives on screen.
//
// Deliberately not a panel surface. The panel shows the object under
// discussion — a rack, the song, a record — and an EQ is not an object under
// discussion, it is a control you use *while* listening to one. So the chain
// sits in a strip above the transport, always one press away, never modal, and
// collapsed to a single line that says what is on the lane when it is shut.

import { btnQuiet, cx, mono } from "@/components/ui";
import { useSession } from "@/components/shell/SessionProvider";
import { activeBands, describeProcessing, hasProcessing } from "@/lib/processing/chain";
import { dbFromGain, gainFromDb } from "@/lib/session/mix";
import { AUDITION_TRACK_ID } from "@/lib/session/rack";
import { MasterStrip } from "./MasterStrip";
import { ProcessingPanel } from "./ProcessingPanel";
import { useProcessing } from "./ProcessingProvider";

export function ProcessingDock() {
  const session = useSession();
  const processing = useProcessing();

  const lanes = session.tracks.filter((track) => track.id !== AUDITION_TRACK_ID).map((track) => ({ id: track.id, name: track.name }));
  const focused = processing.focusTrackId;
  const chain = processing.processing;
  const engaged = focused !== null && hasProcessing(processing.state, focused) && !chain.bypassed && activeBands(chain).length > 0;

  if (!processing.open) {
    return (
      <div className="shrink-0 border-t border-rule h-8 px-4 flex items-center gap-3 min-w-0">
        <button
          type="button"
          className={cx(btnQuiet, engaged && "text-pad")}
          onClick={() => processing.setOpen(true)}
          title="Per-track EQ, trim and tune, and the master bus. Everything here is reachable by sentence too: “clean up the trumpet”, “cut 300 on the drums”, “a/b the horns”."
        >
          Processing
        </button>
        {focused && lanes.length > 0 && (
          <span className={cx(mono, "text-2xs truncate", engaged ? "text-chalk-dim" : "text-chalk-faint")} title={describeProcessing(chain)}>
            {lanes.find((lane) => lane.id === focused)?.name}: {describeProcessing(chain)}
          </span>
        )}
        {processing.master.limiter.enabled && !processing.master.bypassed && (
          <span className={cx(mono, "text-2xs text-chalk-faint")} title="The master limiter is on">
            limiter on
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-rule flex flex-col max-h-[54vh] min-h-0">
      <div className="shrink-0 h-8 px-4 flex items-center gap-2 border-b border-rule">
        <span className="text-sm">Processing</span>
        <span className="text-2xs text-chalk-faint hidden sm:inline">corrective only — it answers whether this fits, not how it is released</span>
        <button type="button" className={cx(btnQuiet, "ml-auto")} onClick={() => processing.setOpen(false)} title="Collapse the dock; the chain keeps running">
          Hide
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto">
        <ProcessingPanel
          lanes={lanes}
          trackId={focused}
          processing={chain}
          sampleRate={processing.sampleRate}
          selected={processing.selectedBand}
          proposal={processing.proposal}
          busy={processing.busy}
          note={processing.note}
          onPickLane={processing.focus}
          onSelect={processing.selectBand}
          onBand={(id, patch) => focused && processing.setBandOn(focused, id, patch)}
          onToggleBand={(id) => focused && processing.toggleBandOn(focused, id)}
          onTrim={(db) => focused && processing.setTrimOn(focused, db)}
          onTune={(cents) => focused && processing.setTuneOn(focused, cents)}
          onBypass={(bypassed) => focused && processing.setBypassOn(focused, bypassed)}
          onReset={() => focused && processing.resetOn(focused)}
          onRemove={() => focused && processing.removeFrom(focused)}
          onAsk={(complaint) => focused && processing.fix(focused, complaint)}
          onUndoProposal={processing.undoProposal}
        />
        <MasterStrip
          master={processing.master}
          levelDb={dbFromGain(session.masterGain)}
          reductionDb={processing.reductionDb}
          onLevel={(db) => session.setMasterGain(gainFromDb(db))}
          onLimiter={processing.setLimiterSettings}
          onBypass={processing.setMasterBypassed}
        />
      </div>
    </div>
  );
}
