"use client";

// The stacked lane view for one layer (BUILD_PACKET section 9): target tempo
// and key on the layer (blank = the first lane's, as the compute plans it),
// one lane per item, Render, and the render's result. Not a timeline editor:
// no automation, no clips, no arrangement.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { btn, btnPrimary, btnQuiet, cx, label, segment, segmentItem, select } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { layerIdOf, layerJobResult, layersApi, type LayerItemPatchRequest, type LayerPatchRequest, type LayerResponse } from "@/lib/api/layers";
import { fmtBpm } from "@/lib/format";
import { displayKey, displayTonic, PITCH_CLASSES } from "@/lib/music/keys";
import { GRID_SNAPS, type GridSnap } from "@/lib/pianoroll/time";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow, LayerItemRow } from "@/lib/types/db";
import { AddLanePicker } from "./AddLanePicker";
import { NameField, NumberField } from "./fields";
import { LaneRow, laneEffective } from "./LaneRow";
import { Ruler, type TimelineScale } from "./LaneTimeline";
import { predictPlan } from "./plan";
import { DownloadButton, isActive, jobText, OpenButton, PlayButton, RetryButton, useJobDone } from "./shared";

const BEATS_PER_BAR = 4;

export function LayerEditor({ layerId, currentFileId, onDeleted }: { layerId: string; currentFileId: string; onDeleted: () => void }) {
  const lib = useLibrary();
  const router = useRouter();
  const [detail, setDetail] = useState<LayerResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [snap, setSnap] = useState<GridSnap>("beat");
  const [picking, setPicking] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [rulerEl, setRulerEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await layersApi.get(layerId);
      setDetail(res);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [layerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isMine = useCallback((j: JobRow) => layerIdOf(j) === layerId, [layerId]);
  const jobs = useMemo(() => lib.jobs.filter(isMine), [lib.jobs, isMine]);
  useJobDone(lib.jobs, isMine, () => void load());
  const activeJob = jobs.find(isActive);
  const latestJob = jobs[0];
  const lastDone = jobs.find((j) => j.status === "done");
  const result = layerJobResult(lastDone);

  useEffect(() => {
    if (!rulerEl) return;
    const update = () => setWidth(rulerEl.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(rulerEl);
    return () => ro.disconnect();
  }, [rulerEl]);

  const vitalsById = useMemo(() => new Map((detail?.files ?? []).map((f) => [f.file_id, f])), [detail]);
  const plan = useMemo(() => (detail ? predictPlan(detail.layer, detail.items, vitalsById) : null), [detail, vitalsById]);
  const appliedByItem = useMemo(() => new Map((result?.applied ?? []).map((a) => [a.item_id, a])), [result]);

  const scale: TimelineScale | null = useMemo(() => {
    if (!detail || !plan) return null;
    const bpm = plan.target_bpm;
    const bar = (60 / bpm) * BEATS_PER_BAR;
    let t0 = 0;
    let t1 = bar * 4;
    detail.items.forEach((item, i) => {
      const eff = laneEffective(item, plan.items[i] ?? null);
      const dur = (vitalsById.get(item.file_id)?.duration_s ?? 0) / (eff.stretch || 1);
      t0 = Math.min(t0, eff.offset);
      t1 = Math.max(t1, eff.offset + dur);
    });
    // a little air after the longest lane, rounded up to whole bars
    t1 = Math.ceil((t1 + bar * 0.25) / bar) * bar;
    const span = Math.max(bar, t1 - t0);
    return { t0, pxPerSec: width > 0 ? width / span : 1, bpm, beatsPerBar: BEATS_PER_BAR };
  }, [detail, plan, vitalsById, width]);

  // ---- actions ----------------------------------------------------------------
  const patchLayer = async (patch: LayerPatchRequest) => {
    try {
      setDetail(await layersApi.update(layerId, patch));
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const patchItem = async (item: LayerItemRow, patch: LayerItemPatchRequest) => {
    const before = detail;
    setDetail((prev) => (prev ? { ...prev, items: prev.items.map((it) => (it.id === item.id ? { ...it, ...stripUndefined(patch) } : it)) } : prev));
    setBusyItem(item.id);
    try {
      const res = await layersApi.updateItem(layerId, item.id, patch);
      setDetail((prev) => (prev ? { ...prev, items: prev.items.map((it) => (it.id === item.id ? res.item : it)) } : prev));
      setActionError(null);
    } catch (err) {
      setDetail(before);
      setActionError(errorMessage(err));
    } finally {
      setBusyItem(null);
    }
  };

  const addLane = async (fileId: string) => {
    setPicking(false);
    try {
      await layersApi.addItem(layerId, { file_id: fileId });
      await load();
      setActionError(null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const removeLane = async (item: LayerItemRow) => {
    const before = detail;
    setDetail((prev) => (prev ? { ...prev, items: prev.items.filter((it) => it.id !== item.id) } : prev));
    try {
      await layersApi.removeItem(layerId, item.id);
    } catch (err) {
      setDetail(before);
      setActionError(errorMessage(err));
    }
  };

  const render = async () => {
    try {
      const res = await layersApi.render(layerId);
      lib.upsertJob(res.job);
      setActionError(res.dispatch && !res.dispatch.ok ? `Render queued, but ${res.dispatch.reason}.` : null);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const deleteLayer = async () => {
    if (!window.confirm("Delete this layer? A rendered file stays in the library.")) return;
    try {
      await layersApi.remove(layerId);
      onDeleted();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  if (loadError) {
    return (
      <p className="px-4 py-3 text-sm">
        Could not load the layer: {loadError}{" "}
        <button type="button" className={btnQuiet} onClick={() => void load()}>
          Retry
        </button>
      </p>
    );
  }
  if (!detail || !plan || !scale) return <p className="px-4 py-3 text-sm text-chalk-dim">Loading the layer.</p>;

  const { layer, items } = detail;
  const firstVitals = items[0] ? vitalsById.get(items[0].file_id) : undefined;
  const renderFile = layer.render_file_id ? lib.fileById(layer.render_file_id) : undefined;
  const inLayer = new Set(items.map((i) => i.file_id));
  const keyMode = layer.key?.mode ?? plan.target_key?.mode ?? "minor";

  return (
    <section aria-label={layer.name ?? "Layer"} className="flex flex-col">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <NameField value={layer.name} fallback="Untitled layer" ariaLabel="Layer name" onCommit={(name) => void patchLayer({ name })} />
        <span className="flex items-center gap-1.5">
          <span className={label}>tempo</span>
          <NumberField
            value={layer.tempo_bpm}
            min={20}
            max={400}
            step={0.1}
            digits={2}
            allowEmpty
            placeholder={`auto ${fmtBpm(plan.target_bpm)}`}
            ariaLabel="Target tempo in BPM (blank = the first lane's)"
            widthClass="w-[88px]"
            onCommit={(v) => void patchLayer({ tempo_bpm: v })}
          />
          <span className={label}>BPM</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={label}>key</span>
          <select
            className={cx(select, "h-6 text-xs font-mono")}
            value={layer.key?.tonic ?? ""}
            aria-label="Target key tonic (auto = the first tonal lane's)"
            onChange={(e) => void patchLayer({ key: e.target.value ? { tonic: e.target.value, mode: keyMode } : null })}
          >
            <option value="">auto{plan.target_key ? ` ${displayKey(plan.target_key.tonic, plan.target_key.mode)}` : ""}</option>
            {PITCH_CLASSES.map((t) => (
              <option key={t} value={t}>
                {displayTonic(t, keyMode)}
              </option>
            ))}
          </select>
          <select
            className={cx(select, "h-6 text-xs")}
            value={keyMode}
            aria-label="Target key mode"
            disabled={!layer.key}
            onChange={(e) => layer.key && void patchLayer({ key: { tonic: layer.key.tonic, mode: e.target.value === "major" ? "major" : "minor" } })}
          >
            <option value="minor">minor</option>
            <option value="major">major</option>
          </select>
        </span>
        <span className="flex items-center gap-1.5">
          <span className={label}>snap</span>
          <div className={segment} role="group" aria-label="Offset snap">
            {GRID_SNAPS.map((m) => (
              <button key={m.id} type="button" className={cx(segmentItem, "h-6")} data-active={snap === m.id} onClick={() => setSnap(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </span>
        <button type="button" className={btn} onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          Add lane
        </button>
        <button type="button" className={btnPrimary} onClick={() => void render()} disabled={items.length === 0 || isActive(activeJob)} title="Tempo-match, key-match, downbeat-align, sum, and put the render in the library">
          Render
        </button>
        {activeJob && <span className="text-xs text-chalk-dim">render {jobText(activeJob)}</span>}
        {!activeJob && latestJob?.status === "failed" && (
          <span className="text-xs flex items-center gap-2">
            render {jobText(latestJob)} <RetryButton job={latestJob} onRetried={lib.upsertJob} />
          </span>
        )}
        <button type="button" className={cx(btnQuiet, "ml-auto")} onClick={() => void deleteLayer()}>
          Delete layer
        </button>
      </div>

      {actionError && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {actionError}
          <button type="button" className={btnQuiet} onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </p>
      )}

      {(renderFile || result) && (
        <div className="px-4 py-1.5 border-b border-rule flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {renderFile ? (
            <>
              <PlayButton fileId={renderFile.id} />
              <span>
                rendered <span className="text-chalk">{renderFile.original_filename}</span>
                <span className="text-chalk-dim"> {renderFile.status === "ready" ? "" : `(${renderFile.status})`}</span>
              </span>
              <OpenButton fileId={renderFile.id} />
              <DownloadButton fileId={renderFile.id} />
            </>
          ) : (
            <span className="text-chalk-dim">the render is not in the library yet</span>
          )}
          {result?.plan && (
            <span className="font-mono text-chalk-dim" title="The plan the compute applied on the last render">
              applied {fmtBpm(result.plan.target_bpm)} BPM{result.plan.target_key ? `, ${displayKey(result.plan.target_key.tonic, result.plan.target_key.mode)}` : ", no key match"}
            </span>
          )}
        </div>
      )}

      {picking && <AddLanePicker currentFileId={currentFileId} inLayer={inLayer} onPick={(id) => void addLane(id)} onClose={() => setPicking(false)} />}

      <div className="grid grid-cols-[230px_minmax(0,1fr)] border-b border-rule">
        <div className="px-3 flex items-center text-xs text-chalk-dim border-r border-rule">
          {items.length} {items.length === 1 ? "lane" : "lanes"}
          <span className="ml-auto font-mono" title="Bars at the target tempo">
            {fmtBpm(plan.target_bpm)} BPM
          </span>
        </div>
        <div ref={setRulerEl} className="min-w-0">
          <Ruler scale={scale} width={width} />
        </div>
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">No lanes. Press Add lane and pick the material to put together: the first lane sets the tempo and key unless you type them above.</p>
      ) : (
        <ul>
          {items.map((item, i) => (
            <LaneRow
              key={item.id}
              item={item}
              vitals={vitalsById.get(item.file_id) ?? null}
              plan={plan.items[i] ?? null}
              applied={appliedByItem.get(item.id) ?? null}
              peaks={lib.fileById(item.file_id)?.peaks ?? null}
              scale={scale}
              snap={snap}
              busy={busyItem === item.id}
              onPatch={(patch) => void patchItem(item, patch)}
              onRemove={() => void removeLane(item)}
              onOpen={() => router.push(`/f/${item.file_id}`)}
            />
          ))}
        </ul>
      )}

      <p className="px-4 py-2 text-xs text-chalk-dim max-w-[720px]">
        Lanes at their defaults are auto: on Render the compute stretches each to {fmtBpm(plan.target_bpm)} BPM
        {plan.target_key ? `, shifts tonal lanes to ${displayKey(plan.target_key.tonic, plan.target_key.mode)}` : ""}, lines up first downbeats, then sums with gain, filters and a soft limiter.
        {firstVitals && !layer.tempo_bpm ? ` The target follows the first lane (${firstVitals.name}); type a tempo or key above to override it.` : ""}
      </p>
    </section>
  );
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
