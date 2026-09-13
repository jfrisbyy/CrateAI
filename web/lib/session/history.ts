// Undo.
//
// Arrangement without undo is a trap: a producer who cannot get a region back
// after dragging it stops dragging regions, and the whole surface is then a
// picture rather than a tool. So every edit goes through here, and the shape
// is the one the panel's history already uses (`components/shell/surfaceStack`):
// a pure reducer with a cursor, asserted rather than clicked.
//
// Two details that are not obvious until they bite:
//
//   Every entry carries a label, and undo names the thing it is undoing. "Undo
//   trim" and "Undo move" are different reassurances, and a producer three
//   edits deep needs the right one.
//
//   Edits that arrive in a stream — a keyboard nudge held down, a fader
//   dragged — coalesce into one entry instead of forty. A drag on the timeline
//   never reaches here until the pointer goes up, so the stream case is only
//   the keyboard, but the keyboard is exactly where forty entries would happen.

export interface HistoryEntry<T> {
  state: T;
  /** what the edit did, in the words the control uses: "move", "trim the head" */
  label: string;
  /**
   * Edits sharing a key, one after another and inside the coalesce window,
   * become one entry. Null never coalesces.
   */
  coalesceKey: string | null;
  /** monotonic milliseconds; the caller's clock, so tests are exact */
  at: number;
}

export interface History<T> {
  past: HistoryEntry<T>[];
  present: HistoryEntry<T>;
  future: HistoryEntry<T>[];
}

/** Deeper than this and it is an archive, not an undo stack; it also bounds the memory. */
export const MAX_HISTORY = 64;

/** Two edits of the same kind closer together than this are one edit. */
export const COALESCE_MS = 700;

export function initHistory<T>(state: T, label = "opened"): History<T> {
  return { past: [], present: { state, label, coalesceKey: null, at: 0 }, future: [] };
}

export interface RecordOptions {
  /** edits sharing this key coalesce; omit for an edit that always stands alone */
  coalesceKey?: string | null;
  /** the clock, so a test can place edits exactly */
  at?: number;
  coalesceMs?: number;
}

/**
 * Put a new state on the stack. The forward history is dropped, the way a
 * browser drops the pages ahead of you when you follow a new link — an undo
 * stack that kept them would offer to redo an edit that no longer makes sense
 * on the state that is now present.
 */
export function record<T>(history: History<T>, state: T, label: string, options: RecordOptions = {}): History<T> {
  const at = options.at ?? Date.now();
  const coalesceKey = options.coalesceKey ?? null;
  const window = options.coalesceMs ?? COALESCE_MS;
  const present = history.present;
  if (coalesceKey !== null && present.coalesceKey === coalesceKey && at - present.at <= window) {
    // The run continues: replace where it got to, keep where it started from.
    return { past: history.past, present: { state, label, coalesceKey, at }, future: [] };
  }
  const past = [...history.past, present].slice(-MAX_HISTORY);
  return { past, present: { state, label, coalesceKey, at }, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

/** What "undo" would undo, for the button's title. Null when there is nothing. */
export function undoLabel<T>(history: History<T>): string | null {
  return canUndo(history) ? history.present.label : null;
}

/** What "redo" would put back. */
export function redoLabel<T>(history: History<T>): string | null {
  return history.future[history.future.length - 1]?.label ?? null;
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [...history.future, history.present] };
}

export function redo<T>(history: History<T>): History<T> {
  const next = history.future[history.future.length - 1];
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(0, -1) };
}

/** The state on screen. */
export function present<T>(history: History<T>): T {
  return history.present.state;
}

/**
 * Replace the present without making an undo step: the state changed for a
 * reason that is not an edit (the engine handed back a lane the rack
 * committed, a source finished decoding). Undoing still goes back past it.
 */
export function replacePresent<T>(history: History<T>, state: T): History<T> {
  return { ...history, present: { ...history.present, state } };
}

/** How many steps back are available; the readout under the undo button. */
export function depth<T>(history: History<T>): number {
  return history.past.length;
}
