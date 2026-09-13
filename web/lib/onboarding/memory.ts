// What the first run has to remember between page loads.
//
// Five facts, and no more: whether the producer has put the first screen
// behind them, which record taught them, which one they had open last, when
// they were last here, and whether they have read the one constraint that
// decides whether this product is for them at all.
//
// It lives in `localStorage` today, which means it is per-device. The
// migration `supabase/migrations/20260913001500_onboarding_state.sql` adds the
// same columns to `profiles` so it can become per-account; it is written
// and deliberately not applied, because writing them needs a route on
// `/api/profile` that this pass does not own. The shapes match so the swap is
// mechanical: `readMemory`/`writeMemory` are the only two call sites.

export const MEMORY_KEY = "crateai:onboarding";

export interface OnboardingMemory {
  version: 1;
  /** they closed the first-run screen for good */
  dismissedAt: string | null;
  /** the first record that came back analyzed, and when */
  firstReadyFileId: string | null;
  firstReadyAt: string | null;
  /** the record they had open when they left, so the way back in is one click */
  lastFileId: string | null;
  /** the last time this device opened the workspace */
  lastSeenAt: string | null;
  /** they have been shown, at least once, that it needs their audio */
  seenConstraint: boolean;
}

export const EMPTY_MEMORY: OnboardingMemory = {
  version: 1,
  dismissedAt: null,
  firstReadyFileId: null,
  firstReadyAt: null,
  lastFileId: null,
  lastSeenAt: null,
  seenConstraint: false,
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Tolerant of anything: a missing key, half a shape, another version's JSON. */
export function parseMemory(raw: string | null | undefined): OnboardingMemory {
  if (!raw) return EMPTY_MEMORY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_MEMORY;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_MEMORY;
  const o = parsed as Record<string, unknown>;
  return {
    version: 1,
    dismissedAt: str(o.dismissedAt),
    firstReadyFileId: str(o.firstReadyFileId),
    firstReadyAt: str(o.firstReadyAt),
    lastFileId: str(o.lastFileId),
    lastSeenAt: str(o.lastSeenAt),
    seenConstraint: o.seenConstraint === true,
  };
}

export function serializeMemory(memory: OnboardingMemory): string {
  return JSON.stringify(memory);
}

/** A gap this long means a new session, so "since you were last here" is worth saying. */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export function isNewSession(memory: OnboardingMemory, now: Date = new Date()): boolean {
  if (!memory.lastSeenAt) return false; // the first ever visit is not a return
  const last = Date.parse(memory.lastSeenAt);
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last >= SESSION_GAP_MS;
}

// --- storage, guarded ------------------------------------------------------
// Private windows and blocked site data both throw. Onboarding that breaks the
// workspace would be worse than onboarding nobody remembers, so every access
// falls back to the empty memory.

export function readMemory(storage?: Storage): OnboardingMemory {
  try {
    const store = storage ?? window.localStorage;
    return parseMemory(store.getItem(MEMORY_KEY));
  } catch {
    return EMPTY_MEMORY;
  }
}

export function writeMemory(memory: OnboardingMemory, storage?: Storage): void {
  try {
    const store = storage ?? window.localStorage;
    store.setItem(MEMORY_KEY, serializeMemory(memory));
  } catch {
    // nothing to do: the session still works, it just will not be remembered
  }
}
