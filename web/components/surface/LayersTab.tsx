"use client";

// The Layers tab: the layers that contain the open file, and the stacked
// lane editor for the selected one. "The drums from this over the sample
// from that": start a layer with this file, add the other as a lane, render.

import { useCallback, useEffect, useState } from "react";
import { LayerEditor } from "@/components/layers/LayerEditor";
import { useJobDone } from "@/components/layers/shared";
import { btn, btnPrimary, btnQuiet, cx } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { layerIdOf, layersApi, type LayerSummary } from "@/lib/api/layers";
import { fmtBpm } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow } from "@/lib/types/db";
import { useSurface } from "./surfaceState";

function isLayerJob(job: JobRow): boolean {
  return layerIdOf(job) !== null;
}

export function LayersTab() {
  const { file } = useSurface();
  const lib = useLibrary();
  const [layers, setLayers] = useState<LayerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await layersApi.list(file.id);
      setLayers(res.layers);
      setError(null);
      setSelectedId((prev) => (prev && res.layers.some((l) => l.layer.id === prev) ? prev : (res.layers[0]?.layer.id ?? null)));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [file.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useJobDone(lib.jobs, isLayerJob, () => void load());

  const create = async () => {
    setCreating(true);
    try {
      const res = await layersApi.create({ file_ids: [file.id] });
      setLayers((prev) => [{ layer: res.layer, items: res.items }, ...(prev ?? [])]);
      setSelectedId(res.layer.id);
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const hasLayers = (layers?.length ?? 0) > 0;

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" className={hasLayers ? btn : btnPrimary} onClick={() => void create()} disabled={creating} title="A new layer with this file as its first lane">
          New layer with this file
        </button>
        {layers && hasLayers && (
          <span className="text-xs text-chalk-dim">
            <span className="font-mono text-chalk">{layers.length}</span> {layers.length === 1 ? "layer contains" : "layers contain"} this file
          </span>
        )}
      </div>

      {actionError && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {actionError}
          <button type="button" className={btnQuiet} onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </p>
      )}

      {layers === null && !error ? (
        <p className="px-4 py-3 text-sm text-chalk-dim">Loading layers.</p>
      ) : error ? (
        <p className="px-4 py-3 text-sm">
          Could not load layers: {error}{" "}
          <button type="button" className={btnQuiet} onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : !hasLayers ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
          No layers with this file yet. Press New layer to start one with this file as the first lane, then Add lane for the material to put over it, a drum stem from
          another record for instance. The compute matches tempo and key, lines up the downbeats, and renders into the library.
        </p>
      ) : (
        <ul className="border-b border-rule">
          {layers!.map(({ layer, items }) => {
            const selected = layer.id === selectedId;
            const render = layer.render_file_id ? lib.fileById(layer.render_file_id) : undefined;
            return (
              <li key={layer.id} className={cx("relative border-b border-rule last:border-b-0", selected && "bg-slate")}>
                {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-pad" aria-hidden />}
                <button type="button" className="w-full text-left px-4 py-1.5 grid grid-cols-[minmax(0,1fr)_64px_100px_100px_minmax(0,1fr)] items-baseline gap-x-3 hover:bg-slate" onClick={() => setSelectedId(layer.id)} aria-current={selected ? "true" : undefined}>
                  <span className="text-sm truncate">{layer.name?.trim() || "Untitled layer"}</span>
                  <span className="font-mono text-xs text-chalk-dim text-right">
                    {items.length} {items.length === 1 ? "lane" : "lanes"}
                  </span>
                  <span className="font-mono text-xs text-right">{layer.tempo_bpm ? `${fmtBpm(layer.tempo_bpm)} BPM` : <span className="text-chalk-dim">auto tempo</span>}</span>
                  <span className="font-mono text-xs text-right">{layer.key ? displayKey(layer.key.tonic, layer.key.mode) : <span className="text-chalk-dim">auto key</span>}</span>
                  <span className="text-xs text-chalk-dim truncate">{render ? `rendered: ${render.original_filename}` : layer.render_file_id ? "rendered" : "not rendered yet"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedId && (
        <LayerEditor
          key={selectedId}
          layerId={selectedId}
          currentFileId={file.id}
          onDeleted={() => {
            setLayers((prev) => (prev ?? []).filter((l) => l.layer.id !== selectedId));
            setSelectedId(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
