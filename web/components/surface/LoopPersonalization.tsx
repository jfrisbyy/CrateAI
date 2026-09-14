"use client";

// What this account's own corrections did to this rack, and the switch that
// stops them doing it.
//
// A ranking that quietly changed is worse than one that did not change at all.
// The finder writes `components.personalization` on every loop it adjusted and
// `jobs.result.personalization` on the search itself; both carry the account's
// sentences (`why`) and the per-row ones (`reasons`) already written in plain
// language by lockedgroove.learn.loop_prefs. Nothing is restated here: this
// reads them out and puts them where the rack is.

import { useState } from "react";
import { btnQuiet, cx } from "@/components/ui";
import { fmtNumber } from "@/lib/format";
import type { Json } from "@/lib/types/db";

/** What the whole search did, from `jobs.result.personalization` or any adjusted row. */
export interface AccountPersonalization {
  enabled: boolean;
  neutral: boolean;
  n_corrections: number;
  strength: number;
  score_cap: number;
  why: string[];
}

/** What it did to one row, from `loops.components.personalization`. */
export interface RowPersonalization extends AccountPersonalization {
  applied: boolean;
  score_measured: number;
  delta: number;
  reasons: string[];
}

function obj(value: Json | null | undefined): Record<string, Json> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Json>) : null;
}

function num(value: Json | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sentences(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The account-level part of a `personalization` payload, wherever it was found. */
export function accountPersonalization(value: Json | null | undefined): AccountPersonalization | null {
  const p = obj(value);
  if (!p || typeof p.enabled !== "boolean") return null;
  return {
    enabled: p.enabled,
    neutral: p.neutral !== false,
    n_corrections: num(p.n_corrections),
    strength: num(p.strength),
    score_cap: num(p.score_cap),
    why: sentences(p.why),
  };
}

/** `components.personalization` off one loop row, or null when it was not adjusted. */
export function rowPersonalization(components: Json | null | undefined): RowPersonalization | null {
  const p = obj(obj(components)?.personalization);
  const account = accountPersonalization(p as Json | null);
  if (!p || !account) return null;
  return {
    ...account,
    applied: p.applied === true,
    score_measured: num(p.score_measured),
    delta: num(p.delta),
    reasons: sentences(p.reasons),
  };
}

/** `jobs.result.personalization` off the last find job. */
export function jobPersonalization(result: Json | null | undefined): AccountPersonalization | null {
  return accountPersonalization(obj(result)?.personalization);
}

/**
 * The chip on an adjusted row: how far this account's history moved it, and why.
 *
 * The measured score is the one the finder wrote and is shown beside the delta,
 * never replaced by it — a producer can always see what the measurement said.
 */
export function PersonalizationChip({ personal }: { personal: RowPersonalization }) {
  if (!personal.applied || personal.delta === 0) return null;
  const up = personal.delta > 0;
  return (
    <span
      className={cx("font-mono", up ? "text-pad" : "text-chalk-dim")}
      title={[
        `measured ${fmtNumber(personal.score_measured, 3)}, yours ${fmtNumber(personal.score_measured + personal.delta, 3)}`,
        ...personal.reasons,
      ].join("\n")}
      data-personal={up ? "up" : "down"}
    >
      yours {up ? "+" : "−"}
      {fmtNumber(Math.abs(personal.delta), 3)}
    </span>
  );
}

/**
 * The line above the rack: what the producer's corrections did to this search,
 * the sentences behind it, and the switch that turns it off.
 */
export function PersonalizationNote({
  personal,
  enabled,
  busy,
  error,
  onToggle,
}: {
  personal: AccountPersonalization;
  /** the account switch as last read; falls back to what the search itself reported */
  enabled: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (next: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const headline = !enabled
    ? "Ranked by the measurement alone: personal loop ranking is off for this account."
    : personal.neutral
      ? "Ranked by the measurement alone. Drag a loop's edges, set its bars, or export a candidate we did not put first, and the next search learns from it."
      : `Ranked partly from your own ${personal.n_corrections} loop correction${personal.n_corrections === 1 ? "" : "s"}, by at most ${fmtNumber(personal.score_cap, 2)} of score.`;

  return (
    <div className="px-4 py-2 border-b border-rule text-xs text-chalk-dim flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="max-w-[560px]">{headline}</span>
      {personal.why.length > 0 && (
        <button type="button" className={btnQuiet} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide why" : "Why"}
        </button>
      )}
      <button
        type="button"
        className={btnQuiet}
        disabled={busy}
        onClick={() => onToggle(!enabled)}
        title={enabled ? "Rank by the measurement alone from the next search on" : "Let your own corrections adjust your ranking again"}
      >
        {enabled ? "Turn off" : "Turn on"}
      </button>
      {error && <span role="alert">{error}</span>}
      {open && (
        <ul className="w-full mt-1 space-y-0.5 max-w-[640px]">
          {personal.why.map((line) => (
            <li key={line} className="pl-2 border-l border-rule">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
