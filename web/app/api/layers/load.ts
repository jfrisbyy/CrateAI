// Shared by the layer routes: one layer with its lanes and the lane files' vitals.

import type { LayerResponse } from "@/lib/api/layers";
import { dbError, HttpError } from "@/lib/http";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { LayerRow } from "@/lib/types/db";
import { laneVitals } from "./vitals";

export async function loadLayer(supabase: ServerSupabase, id: string): Promise<LayerRow> {
  const { data, error } = await supabase.from("layers").select("*").eq("id", id).maybeSingle();
  if (error) throw dbError(error, "Loading the layer");
  if (!data) throw new HttpError(404, "Layer not found.");
  return data;
}

export async function layerResponse(supabase: ServerSupabase, layer: LayerRow): Promise<LayerResponse> {
  const items = await supabase
    .from("layer_items")
    .select("*")
    .eq("layer_id", layer.id)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (items.error) throw dbError(items.error, "Loading the lanes");
  const fileIds = Array.from(new Set(items.data.map((i) => i.file_id)));
  const files = fileIds.length ? await supabase.from("files").select("*").in("id", fileIds) : { data: [], error: null };
  if (files.error) throw dbError(files.error, "Loading the lane files");
  return { layer, items: items.data, files: (files.data ?? []).map(laneVitals) };
}
