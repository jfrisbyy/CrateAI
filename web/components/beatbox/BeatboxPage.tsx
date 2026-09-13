"use client";

// /beatbox (BUILD_PACKET section 15): enrollment, then transcription, with
// the per-user profile's state at the top. Lives in the center pane so the
// library (for a file's grid) and the chat stay in reach.

import { useCallback, useEffect, useState } from "react";
import { btnQuiet } from "@/components/ui";
import { beatboxApi, MIN_ACCURACY } from "@/lib/api/beatbox";
import { errorMessage } from "@/lib/api/client";
import { fmtPercent } from "@/lib/format";
import type { BeatboxProfileRow } from "@/lib/types/db";
import { Enrollment } from "./Enrollment";
import { Transcription } from "./Transcription";

export function BeatboxPage() {
  const [profile, setProfile] = useState<BeatboxProfileRow | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await beatboxApi.profile();
      setProfile(res.profile);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <header className="px-4 pt-3 pb-2 border-b border-rule">
        <h1 className="text-md font-semibold">Beatbox to MIDI</h1>
        <p className="mt-1 text-xs text-chalk-dim max-w-[720px]">
          Teach it your kick, snare and hat once; then beatbox a pattern and get MIDI with your timing. The model is yours alone: vocal percussion varies
          too much across people for a general one.
        </p>
        <div className="mt-1.5 text-xs flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
          {profile === undefined && !error && <span className="text-chalk-dim">loading your profile</span>}
          {profile === null && <span className="text-chalk-dim">No profile yet: enroll below.</span>}
          {profile && (
            <>
              <span>
                <span className="text-chalk-dim">classes </span>
                <span className="font-mono">{profile.classes.join(", ")}</span>
              </span>
              <span>
                <span className="text-chalk-dim">examples </span>
                <span className="font-mono">{profile.sample_count}</span>
              </span>
              <span>
                <span className="text-chalk-dim">cross-validated </span>
                <span className="font-mono">{fmtPercent(profile.cv_accuracy)}</span>
              </span>
              <span className="font-mono">{profile.enabled ? "enabled" : `disabled: under ${fmtPercent(MIN_ACCURACY)}, record more`}</span>
              <span>
                <span className="text-chalk-dim">trained </span>
                <span className="font-mono">{new Date(profile.trained_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              </span>
            </>
          )}
          {error && (
            <span>
              Could not load the profile: {error}{" "}
              <button type="button" className={btnQuiet} onClick={() => void load()}>
                Retry
              </button>
            </span>
          )}
        </div>
      </header>
      <Enrollment profile={profile ?? null} onTrained={() => void load()} />
      <Transcription profile={profile ?? null} />
    </div>
  );
}
