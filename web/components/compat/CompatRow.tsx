"use client";

// One match: what it is, why it fits in plain words, the numbers behind that
// line, and the two things a producer does next -- put it under this file as a
// layer lane, or open it to correct what was measured.

import { useRouter } from "next/navigation";
import { fileTitle, statusText } from "@/components/library/FileRow";
import { FilePlayButton } from "@/components/stems/FilePlayButton";
import { openFile } from "@/components/stems/navigate";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btn, btnQuiet, cx } from "@/components/ui";
import type { CompatMatch } from "@/lib/compat/matches";
import { fmtBpm, fmtPercent } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { hedgeWord } from "@/lib/report/hedge";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { Mode } from "@/lib/types/report";

/** "90 BPM", or "85 -> 170 counted double-time" when the grids meet at an octave. */
function tempoCell(match: CompatMatch): string {
  const { candidate_bpm, folded_bpm, fold } = match.tempo;
  if (candidate_bpm === null) return "—";
  if (fold === "none" || folded_bpm === null) return `${fmtBpm(candidate_bpm)}`;
  return `${fmtBpm(candidate_bpm)} → ${fmtBpm(folded_bpm)}`;
}

export function CompatRow({
  match,
  onLayer,
  layering,
  onBeforePlay,
  onError,
}: {
  match: CompatMatch;
  onLayer: () => void;
  layering: boolean;
  onBeforePlay: () => void;
  onError: (message: string) => void;
}) {
  const lib = useLibrary();
  const router = useRouter();
  const live = lib.fileById(match.file.id) ?? match.file;
  const jobs = lib.jobsForFile(match.file.id);
  const status = statusText(live, jobs);
  const name = fileTitle(live);
  const hedge = hedgeWord(match.confidence);
  const key = match.key;
  const tonic = key.candidate_tonic;
  const mode = key.candidate_mode as Mode | null;

  return (
    <li className="border-b border-rule px-4 py-1.5 grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 items-center">
      <FilePlayButton fileId={match.file.id} label={name} onStart={onBeforePlay} onError={onError} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm truncate" title={name}>
            {name}
          </span>
          {live.kind !== "original" && <span className="text-xs text-chalk-dim">{live.kind.replace("_", " ")}</span>}
          {status.failed && <span className="text-xs text-chalk">{status.text}</span>}
        </div>

        {/* the line that says why, in the words a producer would use */}
        <div className="mt-0.5 flex items-baseline gap-2 min-w-0">
          <span className="text-sm text-chalk" title={`${match.tempo.note}; ${key.note}`}>
            {match.reason}
          </span>
          <ConfidenceDot confidence={match.confidence} className="translate-y-[-1px]" />
          <span className="text-xs text-chalk-faint truncate" title={match.confidence_reason}>
            {hedge === "" ? `confidence ${match.confidence.toFixed(2)}` : `${hedge}, ${match.confidence_reason}`}
          </span>
        </div>

        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs text-chalk-dim">
          <button
            type="button"
            className="font-mono flex items-center gap-1 hover:text-chalk"
            onClick={() => openFile(router, match.file.id, "report")}
            title="Open this file's report, where the tempo can be halved, doubled or tapped"
          >
            <span className="text-chalk">{tempoCell(match)}</span>
            <ConfidenceDot confidence={match.tempo.confidence} />
          </button>
          <button
            type="button"
            className="font-mono flex items-center gap-1 hover:text-chalk"
            onClick={() => openFile(router, match.file.id, "report")}
            title="Open this file's report, where the key can be set by hand"
          >
            {tonic && mode ? (
              <>
                <span className="text-chalk">{displayKey(tonic, mode)}</span>
                <ConfidenceDot confidence={key.confidence} />
              </>
            ) : (
              <span className="text-chalk-faint">no key</span>
            )}
          </button>
          {match.tempo.ratio !== null && (
            <span className="font-mono" title={match.tempo.note}>
              &times;{match.tempo.ratio.toFixed(3)}
            </span>
          )}
          {key.semitone_shift !== 0 && (
            <span className={cx("font-mono", key.shifts_character && "text-chalk")} title={key.shifts_character ? "More than 2 semitones: this changes the character of the material" : key.note}>
              {key.semitone_shift > 0 ? "+" : ""}
              {key.semitone_shift} st{key.shifts_character ? ", changes character" : ""}
            </span>
          )}
          {match.timbre !== null && (
            <span className="font-mono" title="Cosine similarity of the two CLAP embeddings; it only breaks ties">
              {fmtPercent(match.timbre)} alike
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button type="button" className={btnQuiet} onClick={() => openFile(router, match.file.id)} title="Open this file on the surface">
          Open
        </button>
        <button
          type="button"
          className={btn}
          disabled={layering}
          onClick={onLayer}
          title="Start a layer with this file under the open one; the compute matches tempo and key and lines up the downbeats"
        >
          {layering ? "Adding" : "Layer this"}
        </button>
      </div>
    </li>
  );
}
