// GET /api/layers?file_id= — the caller's layers that contain the file, with their items.
// POST /api/layers { name?, file_ids: [] } — a layer with one lane per file, in order, at
// the defaults (stretch 1, pitch 0, offset 0, gain 0): the compute's alignment plan fills
// those in at render time (analysis/lockedgroove/jobs/layer.py).

import type { NextRequest } from "next/server";
import { z } from "zod";
import type { LayerResponse, LayersListResponse, LayerSummary } from "@/lib/api/layers";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import type { FileRow, LayerItemRow, LayerRow } from "@/lib/types/db";
import { laneVitals } from "./vitals";

export async function GET(req: NextRequest) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const fileId = req.nextUrl.searchParams.get("file_id");
    if (!fileId || !UUID_RE.test(fileId)) throw new HttpError(400, "file_id is required.");

    const membership = await supabase.from("layer_items").select("layer_id").eq("file_id", fileId);
    if (membership.error) throw dbError(membership.error, "Listing layers");
    const ids = Array.from(new Set(membership.data.map((r) => r.layer_id)));
    if (ids.length === 0) return json({ layers: [] } satisfies LayersListResponse);

    const [layers, items] = await Promise.all([
      supabase.from("layers").select("*").in("id", ids).order("updated_at", { ascending: false }).limit(100),
      supabase.from("layer_items").select("*").in("layer_id", ids).order("position", { ascending: true }).order("created_at", { ascending: true }),
    ]);
    if (layers.error) throw dbError(layers.error, "Listing layers");
    if (items.error) throw dbError(items.error, "Listing layer items");
    const byLayer = new Map<string, LayerItemRow[]>();
    for (const it of items.data) {
      const list = byLayer.get(it.layer_id);
      if (list) list.push(it);
      else byLayer.set(it.layer_id, [it]);
    }
    const summaries: LayerSummary[] = layers.data.map((layer: LayerRow) => ({ layer, items: byLayer.get(layer.id) ?? [] }));
    return json({ layers: summaries } satisfies LayersListResponse);
  });
}

const createSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  file_ids: z.array(z.string().regex(UUID_RE)).min(1).max(16),
});

function stripExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function defaultName(files: FileRow[]): string {
  const names = files.map((f) => stripExtension(f.title?.trim() || f.original_filename));
  const joined = names.length > 1 ? names.join(" + ") : `${names[0] ?? "layer"} layer`;
  return joined.length > 80 ? `${joined.slice(0, 77)}...` : joined;
}

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, createSchema);
    const fileIds = Array.from(new Set(body.file_ids));

    const files = await supabase.from("files").select("*").in("id", fileIds);
    if (files.error) throw dbError(files.error, "Loading the files");
    const byId = new Map(files.data.map((f) => [f.id, f]));
    const missing = fileIds.filter((id) => !byId.has(id));
    if (missing.length) throw new HttpError(404, `File not found: ${missing[0]}.`);
    const ordered = fileIds.map((id) => byId.get(id) as FileRow);

    const layer = await supabase
      .from("layers")
      .insert({ user_id: user.id, name: body.name?.trim() || defaultName(ordered) })
      .select("*")
      .single();
    if (layer.error) throw dbError(layer.error, "Creating the layer");

    const items = await supabase
      .from("layer_items")
      .insert(fileIds.map((file_id, position) => ({ user_id: user.id, layer_id: layer.data.id, file_id, position })))
      .select("*")
      .order("position", { ascending: true });
    if (items.error) throw dbError(items.error, "Creating the lanes");

    const response: LayerResponse = { layer: layer.data, items: items.data, files: ordered.map(laneVitals) };
    return json(response, { status: 201 });
  });
}
