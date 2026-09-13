// The export surface. Everything a producer needs to know before they spend
// minutes of compute has to be on the panel, and the panel must never offer an
// export the job would then refuse.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import type { ExportJobResult, ExportSongRequest } from "@/lib/export/types";
import { ExportPanel, type ExportPanelProps } from "./ExportPanel";

const FILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function region(over: Partial<ExportSongRequest["song"]["tracks"][number]["regions"][number]> = {}) {
  return {
    id: "r1", file_id: FILE, start_s: 0, duration_s: 120, offset_s: 24.13, gain: 1, rate: 0.964,
    lineage_line: "Masquerade · drums · bars 9–16", lineage: null, source_bars: null, ...over,
  };
}

function track(over: Partial<ExportSongRequest["song"]["tracks"][number]> = {}) {
  return { id: "t1", name: "Drums", position: 0, gain: 0.8, muted: false, soloed: false, provenance: "Masquerade, drums", regions: [region()], ...over };
}

function request(over: Partial<ExportSongRequest> = {}): ExportSongRequest {
  return {
    song: {
      name: "Midnight Flip", bpm: 92, beats_per_bar: 4,
      key: { tonic: "F", mode: "minor", from_file_id: FILE, from_file_name: "Masquerade" },
      master_gain: 1, tracks: [track()],
    },
    format: "flac", bit_depth: 24, sample_rate: 44100, include_muted: false, midi_ids: [],
    ...over,
  };
}

function render(props: Partial<ExportPanelProps> = {}) {
  return renderToStaticMarkup(<ExportPanel request={request()} status="idle" {...props} />);
}

group("before the export runs", () => {
  it("says what will be in the zip and what it will be called", () => {
    const html = render();
    expect(html).toContain("Stems of this arrangement");
    expect(html).toContain("tempo map");
    expect(html).toContain("Midnight-Flip_92bpm_Fm_stems.zip");
  });

  it("shows the lanes, the length, the grid and the size before any compute is spent", () => {
    const html = render();
    expect(html).toContain("92 BPM, 4/4");
    expect(html).toContain("2:00.0");
    expect(html).toContain("about ");
    expect(html).toContain("MB");
  });

  it("attributes the key to the record it was measured on rather than claiming the song", () => {
    expect(render()).toContain("measured on Masquerade");
  });

  it("says plainly when the session has no tempo instead of showing a made-up one", () => {
    const html = render({ request: request({ song: { ...request().song, bpm: null, key: null } }) });
    expect(html).toContain("no measured tempo");
    expect(html).toContain("not measured on any lane");
  });

  it("offers FLAC by default and says why either format", () => {
    const html = render();
    expect(html).toContain("FLAC");
    expect(html).toContain("WAV");
    expect(html).toContain("40% smaller");
    expect(html).toContain("older hardware");
    expect(html).toContain('data-active="true"');
  });

  it("names the lanes that will not be in the zip, and why", () => {
    const song = request().song;
    const html = render({
      request: request({ song: { ...song, tracks: [track(), track({ id: "t2", name: "Horns", position: 1, muted: true, regions: [region({ id: "r2" })] })] } }),
    });
    expect(html).toContain("Not in the zip");
    expect(html).toContain("Horns");
    expect(html).toContain("(muted)");
    expect(html).toContain("include muted lanes");
  });

  it("refuses an export the job would refuse, with the same reason and the way out", () => {
    const song = request().song;
    const tracks = Array.from({ length: 20 }, (_, i) => track({ id: `t${i}`, name: `L${i}`, position: i, regions: [region({ id: `r${i}`, duration_s: 890 })] }));
    const html = render({ request: request({ song: { ...song, tracks }, format: "wav" }) });
    expect(html).toContain("the cap is");
    expect(html).toContain("FLAC");
    expect(html).toContain("disabled=\"\"");
  });

  it("will not export an empty timeline", () => {
    const song = request().song;
    const html = render({ request: request({ song: { ...song, tracks: [] } }) });
    expect(html).toContain("nothing on the timeline");
  });
});

group("while it renders and after", () => {
  it("shows progress and will not queue a second render", () => {
    const html = render({ status: "running", progress: 0.42 });
    expect(html).toContain("Rendering");
    expect(html).toContain("42%");
    expect(html).toContain("disabled=\"\"");
  });

  it("offers the download and lists exactly what landed", () => {
    const result: ExportJobResult = {
      storage_path: "derived/u/bundles/j.zip", filename: "Midnight-Flip_92bpm_Fm_stems.zip",
      folder: "Midnight-Flip_92bpm_Fm", size_bytes: 1024, size_human: "1 KB", estimated_bytes: 1024,
      cap_bytes: 1024 ** 3, format: "flac", bit_depth: 24, sample_rate: 44100, channels: 2,
      length_s: 120, length_samples: 5_292_000, bpm: 92, beats_per_bar: 4,
      key: { tonic: "F", mode: "minor" }, tempo_map: true,
      stems: [{ position: 1, track_id: "t1", name: "Drums", file: "stems/01_Drums_92bpm_Fm.flac", peak_dbfs: -3.4, clipped: false }],
      not_exported: [], midi: [{ file: "midi/01_Drums_drums.mid", kind: "drums", midi_id: "m1" }], notes: [],
    };
    const html = render({ status: "done", result, downloadHref: "/api/export/j/download" });
    expect(html).toContain('href="/api/export/j/download"');
    expect(html).toContain("Download 1 KB");
    expect(html).toContain("README.txt");
    expect(html).toContain("tempo_map.mid");
    expect(html).toContain("stems/01_Drums_92bpm_Fm.flac");
    expect(html).toContain("midi/01_Drums_drums.mid");
  });

  it("shouts about a clipped lane instead of quietly normalising it", () => {
    const result = {
      storage_path: "p", filename: "f.zip", folder: "F", size_bytes: 1, size_human: "1 B", estimated_bytes: 1,
      cap_bytes: 1, format: "flac", bit_depth: 24, sample_rate: 44100, channels: 2, length_s: 1,
      length_samples: 1, bpm: 92, beats_per_bar: 4, key: null, tempo_map: false,
      stems: [{ position: 1, track_id: "t1", name: "Drums", file: "stems/01_Drums.flac", peak_dbfs: 1.3, clipped: true }],
      not_exported: [], midi: [], notes: ["Drums peaks at +1.3 dBFS and is clipped in this file."],
    } as ExportJobResult;
    const html = render({ status: "done", result, downloadHref: "/x" });
    expect(html).toContain("clipped");
    expect(html).toContain("+1.3 dBFS");
  });

  it("shows the reason a render failed", () => {
    expect(render({ status: "failed", error: "this export would be about 5.70 GB; the cap is 1.00 GB." })).toContain("5.70 GB");
  });
});
