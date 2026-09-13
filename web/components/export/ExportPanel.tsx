"use client";

// The export surface: what is about to leave the app, and the two choices that
// change it.
//
// The panel's job is to make the export legible *before* it is rendered — how
// many lanes, how long, how big, which lanes are being left behind and why —
// because a four-minute multitrack render is minutes of compute and a producer
// should never press a button and find out afterwards. Everything it shows
// comes from the same pure functions the route and the job use, so the panel
// can never promise something the job then refuses.
//
// Deliberately presentational: every value is a prop or is derived from one by
// a pure function, so it renders to static markup in a test with no browser.
// The wiring lives in `useExport.ts`.

import { btn, btnPrimary, cx, label, mono, segment, segmentItem, select } from "@/components/ui";
import { estimateExport, exportZipName, formatBytes, heldBackTracks } from "@/lib/export/song";
import { EXPORT_BIT_DEPTHS, EXPORT_FORMATS, type ExportBitDepth, type ExportFormat, type ExportJobResult, type ExportSongRequest } from "@/lib/export/types";

export type ExportStatus = "idle" | "queued" | "running" | "done" | "failed";

export interface ExportPanelProps {
  request: ExportSongRequest;
  status: ExportStatus;
  /** 0..1 while compute is rendering, or null */
  progress?: number | null;
  error?: string | null;
  result?: ExportJobResult | null;
  downloadHref?: string | null;
  onFormat?: (format: ExportFormat) => void;
  onBitDepth?: (depth: ExportBitDepth) => void;
  onIncludeMuted?: (include: boolean) => void;
  onExport?: () => void;
}

function fmtTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

export function ExportPanel(props: ExportPanelProps) {
  const { request, status, error, result, downloadHref } = props;
  const estimate = estimateExport(request);
  const held = heldBackTracks(request.song.tracks, request.include_muted === true);
  const format = request.format ?? "flac";
  const bitDepth = request.bit_depth ?? 24;
  const busy = status === "queued" || status === "running";

  return (
    <div className="px-4 py-3 max-w-[620px] text-sm text-chalk">
      <p className="text-chalk-dim">
        Stems of this arrangement, a tempo map and a readme — one zip that opens in Ableton, FL, Logic or anything
        else. Every lane is rendered across the whole song, so dropping them all at zero gives you back exactly what
        you are hearing.
      </p>

      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className={label}>Lanes</dt>
        <dd className={mono}>{estimate.tracks}</dd>
        <dt className={label}>Length</dt>
        <dd className={mono}>
          {fmtTime(estimate.length_s)}
          {request.song.bpm ? ` · ${request.song.bpm} BPM, ${request.song.beats_per_bar}/4` : " · no measured tempo, so no bar grid"}
        </dd>
        <dt className={label}>Key</dt>
        <dd>
          {request.song.key
            ? `${request.song.key.tonic} ${request.song.key.mode}${request.song.key.from_file_name ? ` — measured on ${request.song.key.from_file_name}` : ""}`
            : "not measured on any lane"}
        </dd>
        <dt className={label}>Size</dt>
        <dd className={cx(mono, estimate.over_cap && "text-pad")} title="Estimated before rendering, from lanes x length x sample rate x channels x bit depth">
          about {formatBytes(estimate.bytes)}
        </dd>
        <dt className={label}>File</dt>
        <dd className={cx(mono, "truncate")}>{exportZipName(request.song)}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className={label}>Format</span>
          <div className={segment} role="group" aria-label="Export format">
            {EXPORT_FORMATS.map((option) => (
              <button
                key={option}
                type="button"
                className={segmentItem}
                data-active={format === option}
                aria-pressed={format === option}
                onClick={() => props.onFormat?.(option)}
                title={
                  option === "flac"
                    ? "Lossless, about 40% smaller than WAV, and read by every current DAW"
                    : "Lossless and universal, including older hardware; roughly twice the size of FLAC"
                }
              >
                {option.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={label}>Depth</span>
          <select
            className={select}
            value={bitDepth}
            aria-label="Bit depth"
            onChange={(e) => props.onBitDepth?.(Number(e.target.value) as ExportBitDepth)}
          >
            {EXPORT_BIT_DEPTHS.map((depth) => (
              <option key={depth} value={depth}>{depth}-bit</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-sm text-chalk-dim">
          <input
            type="checkbox"
            checked={request.include_muted === true}
            onChange={(e) => props.onIncludeMuted?.(e.target.checked)}
          />
          Include muted lanes
        </label>
      </div>

      {held.length > 0 && (
        <div className="mt-3 border border-rule rounded-sm px-3 py-2">
          <div className={label}>Not in the zip</div>
          <ul className="mt-1">
            {held.map(({ track, reason }) => (
              <li key={track.id} className="text-chalk-dim truncate" title={track.provenance ?? undefined}>
                {track.name} <span className="text-chalk-faint">({reason})</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-chalk-faint">
            You cannot hear these in the session, so they are named in the readme rather than rendered. Tick
            &ldquo;include muted lanes&rdquo; to render them anyway.
          </p>
        </div>
      )}

      {estimate.blocked && <p className="mt-3 text-pad">{estimate.blocked}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || estimate.blocked !== null}
          onClick={() => props.onExport?.()}
        >
          {busy ? "Rendering…" : "Export the song"}
        </button>
        {busy && typeof props.progress === "number" && (
          <span className={cx(mono, "text-chalk-dim")}>{Math.round(props.progress * 100)}%</span>
        )}
        {status === "done" && downloadHref && (
          <a className={btn} href={downloadHref} download>
            Download {result ? result.size_human : "the zip"}
          </a>
        )}
      </div>

      {error && <p className="mt-2 text-pad">{error}</p>}

      {status === "done" && result && (
        <div className="mt-3 border border-rule rounded-sm px-3 py-2">
          <div className={label}>In the zip</div>
          <ul className="mt-1 text-chalk-dim">
            <li className={mono}>{result.folder}/README.txt</li>
            {result.tempo_map && <li className={mono}>{result.folder}/tempo_map.mid + .txt</li>}
            {result.stems.map((stem) => (
              <li key={stem.track_id} className={cx(mono, "truncate")}>
                {result.folder}/{stem.file}
                {stem.clipped && <span className="text-pad"> — clipped, lower this lane and export again</span>}
              </li>
            ))}
            {result.midi.map((midi) => (
              <li key={midi.midi_id} className={cx(mono, "truncate")}>{result.folder}/{midi.file}</li>
            ))}
          </ul>
          {result.notes.map((note) => (
            <p key={note} className="mt-1 text-xs text-chalk-faint">{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}
