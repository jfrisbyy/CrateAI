// What each of the 16 pads plays. Chops first, by chop index; when the file
// has no chops, its stems: the newest model's stems in STEM_ORDER
// (drums, bass, vocals, other, guitar, piano, instrumental), then older
// models the same way. Pads past the material stay empty.

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

export function bindPads(chops: readonly ChopWithFile[], stems: readonly StemWithFile[]): PadBindings {
  const out: Array<PadBinding | null> = Array.from({ length: PAD_COUNT }, () => null);
  const playable = chops.filter((c) => c.chop_file_id !== null).sort((a, b) => a.index - b.index);
  if (playable.length > 0) {
    playable.slice(0, PAD_COUNT).forEach((c, i) => {
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
      if (i >= PAD_COUNT) return out;
      out[i] = { pad: i + 1, source: "stem", file_id: s.stem_file_id, label: s.stem, detail: s.model, chop_id: null };
      i++;
    }
  }
  return out;
}
