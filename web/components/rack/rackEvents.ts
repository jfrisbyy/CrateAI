// Opening a rack from anywhere without the opener importing the rack.
//
// Same shape as the surface's existing `crateai:tab` and `crateai:select-loop`
// events: a window CustomEvent the shell listens for. The chat's command line
// and the panels both go through this, so "hear what fits this" and clicking
// the button land on exactly the same surface.

export const RACK_EVENT = "crateai:rack";

/**
 * compat: what in the crate fits this file.
 * loops:  the loops the finder found inside it.
 * search: "find me drums" — the library search, as rows you can play.
 */
export type RackRequest =
  | { source: "compat"; fileId: string }
  | { source: "loops"; fileId: string }
  | { source: "search"; query: string };

/** A stable id for the panel's history: two racks of the same ask are one entry. */
export function rackKey(request: RackRequest): string {
  return request.source === "search" ? `search:${request.query.trim().toLowerCase()}` : `${request.source}:${request.fileId}`;
}

export function openRack(request: RackRequest): void {
  window.dispatchEvent(new CustomEvent<RackRequest>(RACK_EVENT, { detail: request }));
}

export function onRackRequest(handler: (request: RackRequest) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object") return;
    const { source } = detail as { source?: unknown };
    const fileId = (detail as { fileId?: unknown }).fileId;
    const query = (detail as { query?: unknown }).query;
    if ((source === "compat" || source === "loops") && typeof fileId === "string" && fileId !== "") handler({ source, fileId });
    else if (source === "search" && typeof query === "string" && query.trim() !== "") handler({ source, query });
  };
  window.addEventListener(RACK_EVENT, listener);
  return () => window.removeEventListener(RACK_EVENT, listener);
}
