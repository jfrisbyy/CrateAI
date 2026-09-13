// The panel's history.
//
// Direction document, Surface 3: "One surface at a time, with history. The
// panel shows the object under discussion. Going back to an earlier one is a
// click, not a re-run." So the panel is a browser-shaped stack — pushing a new
// surface truncates anything ahead of the cursor, back and forward move the
// cursor, and nothing is ever re-fetched to get there. A pure reducer, so the
// rules are asserted rather than discovered by clicking.

/**
 * file:    a record's working surface, from /f/[fileId]
 * page:    another route that renders into the panel (the account, the beatbox kit)
 * rack:    a list of candidates you can play
 * session: the lanes currently in the session
 *
 * `file` and `page` are both route content, so the panel renders the route's
 * children for either; the rest are the shell's own.
 */
export type SurfaceKind = "file" | "page" | "rack" | "session";

/** Does this surface show what the router rendered? */
export function isRoute(entry: SurfaceEntry | null): boolean {
  return entry !== null && (entry.kind === "file" || entry.kind === "page");
}

export interface SurfaceEntry {
  kind: SurfaceKind;
  /** unique within a kind: a file id, a rack id, or "session" */
  id: string;
  title: string;
  /** a one-line note under the title, when there is one worth showing */
  note?: string | null;
}

export interface StackState {
  entries: SurfaceEntry[];
  /** which entry the panel is showing; -1 when there has never been one */
  index: number;
  open: boolean;
}

export const EMPTY_STACK: StackState = { entries: [], index: -1, open: false };

/** More than this and the history is a filing cabinet, not a back button. */
export const MAX_ENTRIES = 24;

export function sameSurface(a: SurfaceEntry | null, b: SurfaceEntry | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.id === b.id;
}

export function currentSurface(state: StackState): SurfaceEntry | null {
  return state.entries[state.index] ?? null;
}

/**
 * Show a surface. Pushing the one already on screen only refreshes its title,
 * so re-rendering a route does not fill the history with the same entry;
 * pushing anything else truncates the forward history the way a browser does.
 */
export function pushSurface(state: StackState, entry: SurfaceEntry): StackState {
  const current = currentSurface(state);
  if (sameSurface(current, entry)) {
    if (current!.title === entry.title && (current!.note ?? null) === (entry.note ?? null)) return state.open ? state : { ...state, open: true };
    const entries = state.entries.slice();
    entries[state.index] = entry;
    return { entries, index: state.index, open: true };
  }
  const kept = state.entries.slice(0, state.index + 1);
  const entries = [...kept, entry].slice(-MAX_ENTRIES);
  return { entries, index: entries.length - 1, open: true };
}

export function canGoBack(state: StackState): boolean {
  return state.index > 0;
}

export function canGoForward(state: StackState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

export function goBack(state: StackState): StackState {
  if (!canGoBack(state)) return state;
  return { ...state, index: state.index - 1, open: true };
}

export function goForward(state: StackState): StackState {
  if (!canGoForward(state)) return state;
  return { ...state, index: state.index + 1, open: true };
}

/** Jump straight to an entry in the history list. */
export function goTo(state: StackState, index: number): StackState {
  if (index < 0 || index >= state.entries.length) return state;
  return { ...state, index, open: true };
}

/** Dismiss the panel. The history stays, so re-opening lands where it was. */
export function closePanel(state: StackState): StackState {
  return state.open ? { ...state, open: false } : state;
}

export function openPanel(state: StackState): StackState {
  if (state.index < 0) return state;
  return state.open ? state : { ...state, open: true };
}

/** Drop one surface (a file that was deleted, a rack that was cleared). */
export function removeSurface(state: StackState, kind: SurfaceKind, id: string): StackState {
  const keep = state.entries.filter((e) => !(e.kind === kind && e.id === id));
  if (keep.length === state.entries.length) return state;
  const current = currentSurface(state);
  const nextIndex = current && !(current.kind === kind && current.id === id) ? keep.findIndex((e) => sameSurface(e, current)) : keep.length - 1;
  return { entries: keep, index: Math.min(nextIndex, keep.length - 1), open: keep.length > 0 && state.open };
}

// --- the divider -------------------------------------------------------------

/** The chat never gets narrower than this fraction, and neither does the panel. */
export const MIN_SPLIT = 0.28;
export const MAX_SPLIT = 0.74;
/** Where the divider sits the first time a panel opens. */
export const DEFAULT_SPLIT = 0.56;

/** The panel's share of the flexible area, clamped so neither side can be squeezed out. */
export function clampSplit(split: number): number {
  if (!Number.isFinite(split)) return DEFAULT_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split));
}

/** The divider's new split from a pointer position over the flexible area. */
export function splitFromPointer(pointerX: number, areaLeft: number, areaWidth: number): number {
  if (areaWidth <= 0) return DEFAULT_SPLIT;
  return clampSplit((areaLeft + areaWidth - pointerX) / areaWidth);
}
