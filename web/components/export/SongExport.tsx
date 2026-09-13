"use client";

// The whole export surface as one tag, so mounting it in the shell is a single
// line in a file this seam does not own:
//
//   <SongExport arrangement={{ tracks: session.tracks, regions: session.regions }}
//               name={songName} bpm={session.tempo?.bpm ?? null}
//               beatsPerBar={session.tempo?.beatsPerBar ?? 4}
//               masterGain={session.masterGain}
//               keyOf={(id) => vitalsOf(library.file(id)?.report ?? null)?.key ?? null} />
//
// `keyOf` and `nameOf` are optional: without them the export simply has no key
// token in its filenames and the readme says the key was not measured, which is
// the truth rather than a guess.

import { ExportPanel } from "./ExportPanel";
import { useExport } from "./useExport";
import type { ArrangementLike, ExportOptions } from "@/lib/export/song";

export interface SongExportProps extends Omit<ExportOptions, "format" | "bitDepth" | "includeMuted"> {
  arrangement: ArrangementLike;
}

export function SongExport({ arrangement, ...options }: SongExportProps) {
  const exporter = useExport(arrangement, options);
  return (
    <ExportPanel
      request={exporter.request}
      status={exporter.status}
      progress={exporter.progress}
      error={exporter.error}
      result={exporter.result}
      downloadHref={exporter.downloadHref}
      onFormat={exporter.setFormat}
      onBitDepth={exporter.setBitDepth}
      onIncludeMuted={exporter.setIncludeMuted}
      onExport={exporter.start}
    />
  );
}
