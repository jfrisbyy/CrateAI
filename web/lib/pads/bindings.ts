// What each pad plays. Chops first, by chop index; when the file has no
// chops, its stems: the newest model's stems in STEM_ORDER (drums, bass,
// vocals, other, guitar, piano, instrumental), then older models the same
// way. Pads past the material stay empty.
//
// File order is where a kit starts, not where it ends: `applyOrder` puts the
// kit's own arrangement (kitOrder.ts, or a drag) over the top, and that is the
// only thing that decides which key gets what.

import type { ChopWithFile } from "@/lib/api/chops";
import { stemOrderIndex, type StemWithFile } from "@/lib/api/stems";
import { PAD_COUNT } from "./keymap";

export interface PadBinding {
  /** 1-based pad number */
  pad: number;
  source: "chop" | "stem";
  /** the library file the pad plays */
  file_id: string;
  label: string;
  /** chop index (0-based) or the model name */
  detail: string;
  chop_id: string | null;
}

export type PadBindings = ReadonlyArray<PadBinding | null>;

export const EMPTY_BINDINGS: PadBindings = Array.from({ length: PAD_COUNT }, () => null);

export function bindPads(chops: readonly ChopWithFile[], stems: readonly StemWithFile[], padCount: number = PAD_COUNT): PadBindings {
  const count = Math.max(0, Math.round(padCount));
  const out: Array<PadBinding | null> = Array.from({ length: count }, () => null);
  const playable = chops.filter((c) => c.chop_file_id !== null).sort((a, b) => a.index - b.index);
  if (playable.length > 0) {
    playable.slice(0, count).forEach((c, i) => {
      out[i] = {
        pad: i + 1,
        source: "chop",
        file_id: c.chop_file_id as string,
        label: c.name?.trim() || `chop ${c.index + 1}`,
        detail: String(c.index + 1),
        chop_id: c.id,
      };
    });
    return out;
  }
  const groups = new Map<string, StemWithFile[]>();
  for (const s of stems) {
    const list = groups.get(s.model);
    if (list) list.push(s);
    else groups.set(s.model, [s]);
  }
  const ordered = [...groups.entries()]
    .map(([model, rows]) => ({ model, newest: rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), ""), rows }))
    .sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0));
  let i = 0;
  for (const group of ordered) {
    const rows = [...group.rows].sort((a, b) => stemOrderIndex(a.stem) - stemOrderIndex(b.stem));
    for (const s of rows) {
      if (i >= count) return out;
      out[i] = { pad: i + 1, source: "stem", file_id: s.stem_file_id, label: s.stem, detail: s.model, chop_id: null };
      i++;
    }
  }
  return out;
}

/**
 * Lay the bindings out in the kit's order: `order[i]` is the slice index the
 * pad `i + 1` plays. A pad whose slice does not exist stays empty, and the
 * `pad` field always says where the binding really sits, so the grid, the
 * engine and the recorder read the same number.
 */
export function applyOrder(bindings: PadBindings, order: readonly number[]): PadBindings {
  return order.map((sliceIndex, i) => {
    const binding = bindings[sliceIndex];
    return binding ? { ...binding, pad: i + 1 } : null;
  });
}

/** How many pads have something on them. */
export function boundCount(bindings: PadBindings): number {
  return bindings.reduce((n, b) => (b ? n + 1 : n), 0);
}
