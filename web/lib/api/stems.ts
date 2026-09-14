// Stems API (browser side) and the response shapes its routes return.
// Same fetch conventions as lib/api/client.ts; `apiFetch` is shared by the
// chops and midi modules until client.ts exports its own `call`.

import { ApiError } from "./client";
import type { JobResponse } from "./types";
import { effective } from "@/lib/report/effective";
import type { FileKind, FileRow, FileStatus, StemRow } from "@/lib/types/db";
import type { AnalysisReport, Mode } from "@/lib/types/report";
import {
  STEM_MODELS,
  STEM_SPLITS,
  TIER_CONFIDENCE,
  TIER_NOTE,
  type SeparationTier,
  type StemModelId,
  type StemSplit,
} from "@/lib/types/stemModels";

export { ALL_STEMS, DEFAULT_STEMS, STEM_MODELS, STEM_SPLITS, TIER_CONFIDENCE, TIER_NOTE, TIERS } from "@/lib/types/stemModels";

export type { SeparationTier, StemModelId, StemModelSpec, StemSplit } from "@/lib/types/stemModels";

export function modelSpec(model: string) {
  return STEM_MODELS.find((m) => m.id === baseModelOf(model));
}

/**
 * The seven quality columns as the worker would write them for `model`.
 *
 * Used by the seeds and the demo so a row they invent cannot claim a tier the
 * registry does not give that model — the drift this whole pass is about, in
 * miniature.
 */
export function stemQualityColumns(model: string): Pick<StemRow, "model_family" | "model_tier" | "model_sdr" | "model_sdr_basis" | "is_stand_in" | "quality_confidence" | "quality_note"> {
  const standIn = isStandInModel(model);
  const spec = modelSpec(model);
  const tier: SeparationTier = standIn ? "stand_in" : (spec?.tier ?? "weak");
  return {
    model_family: spec?.family ?? null,
    model_tier: tier,
    model_sdr: standIn ? null : (spec?.sdr ?? null),
    model_sdr_basis: standIn ? "not a separation model" : (spec?.sdrBasis ?? null),
    is_stand_in: standIn,
    quality_confidence: TIER_CONFIDENCE[tier],
    quality_note: TIER_NOTE[tier],
  };
}

/**
 * What a producer asks for: a split, not a model.
 *
 * Separation is the one irreversible step. A weak separator threw away 17.6 dB
 * of 8-20 kHz energy on a real upload that a reference one preserved exactly,
 * and no EQ downstream puts it back — the producer just hears "muddy". The
 * registry in analysis/lockedgroove/stems/separate.py is ordered by quality for
 * that reason, and the worker picks the best separator *installed in its image*
 * that makes the stems being asked for. Only the worker knows what is
 * installed, so the choice belongs there and not here.
 *
 * This file used to name three models by hand and default to one of them by
 * string, which meant the ordering never ran and the producer was asked to
 * choose between identifiers they cannot evaluate. Now the catalogue is
 * generated (scripts/gen_stem_models.py) and the request says what it wants.
 */
export function splitFor(stems: readonly string[]): StemSplit | undefined {
  return STEM_SPLITS.find((s) => splitKey(s.stems) === splitKey(stems));
}

export const DEFAULT_SPLIT: StemSplit = STEM_SPLITS.find((s) => s.isDefault) ?? STEM_SPLITS[0]!;

/**
 * One split, one key, whatever order the stems arrived in.
 *
 * Both sides de-duplicate in-flight separations with this: asking twice for the
 * same split collides, asking for a different one does not. It used to be the
 * model id, which stopped working the moment the model became the worker's
 * choice rather than the client's.
 */
export function splitKey(stems: readonly string[]): string {
  return [...new Set(stems)].sort().join("+");
}

/** "drums, bass, vocals and other" — the split in a sentence, never an id. */
export function describeStems(stems: readonly string[]): string {
  const named = [...stems];
  if (named.length <= 1) return named[0] ?? "nothing";
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

/**
 * What the worker decided, read off a finished `stems` job's result.
 *
 * `resolve_model` says which separator ran and why in one sentence, and flags a
 * downgrade — a better model exists for this split but is not installed in the
 * image. None of it reached the producer: the tab showed a job status and
 * nothing else, so "the best separator installed runs" was a promise with no
 * receipt. The sentence is worded in Python, beside the decision it describes.
 */
export interface SeparationOutcome {
  model: string;
  tier: SeparationTier | null;
  /** why this separator and not another, in one sentence */
  reason: string | null;
  /** true when something better exists for this split but is not installed here */
  downgraded: boolean;
}

export function separationOutcomeOf(result: unknown): SeparationOutcome | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const r = result as { model?: unknown; model_reason?: unknown; downgraded?: unknown; quality?: unknown };
  if (typeof r.model !== "string") return null;
  const quality = typeof r.quality === "object" && r.quality !== null && !Array.isArray(r.quality)
    ? (r.quality as { model_tier?: unknown })
    : {};
  return {
    model: r.model,
    tier: typeof quality.model_tier === "string" ? (quality.model_tier as SeparationTier) : null,
    reason: typeof r.model_reason === "string" ? r.model_reason : null,
    downgraded: r.downgraded === true,
  };
}

/**
 * What a queued `stems` job asked for.
 *
 * One definition, shared by the route (which de-duplicates in-flight jobs with
 * it) and the tab (which labels them with it), so the two cannot disagree about
 * what "the same separation" means. A job queued before this route stopped
 * taking a bare model still reads correctly: it carries `model` and no `stems`.
 */
export interface StemsAsk {
  stems: readonly string[] | null;
  model: string | null;
}

export function stemsAskOf(params: unknown): StemsAsk {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return { stems: null, model: null };
  const p = params as { model?: unknown; stems?: unknown };
  return {
    stems: Array.isArray(p.stems) ? p.stems.filter((x): x is string => typeof x === "string") : null,
    model: typeof p.model === "string" ? p.model : null,
  };
}

/**
 * What makes two separations "the same" for the purpose of refusing a duplicate.
 *
 * A named model keys on the model, so asking for the reference separator by name
 * while the default split runs is allowed; anything else keys on the split. It
 * used to key on the model alone, which stopped meaning anything the moment the
 * model became the worker's choice rather than the client's.
 */
export function stemsAskKey(ask: StemsAsk): string | null {
  if (ask.model) return `model:${ask.model}`;
  if (ask.stems && ask.stems.length > 0) return `split:${splitKey(ask.stems)}`;
  return null;
}

/** How a job is named in the tab: what was asked for, never which net ran. */
export function describeAsk(ask: StemsAsk): string {
  if (ask.stems && ask.stems.length > 0) return describeStems(ask.stems);
  if (ask.model) return ask.model;
  return "stems";
}

/**
 * What actually ran, read off the row.
 *
 * A null tier means the row predates the quality columns. The migration is
 * explicit that this reads as unknown rather than as fine, so it is shown with
 * the same weight as `weak`: something we cannot vouch for.
 */
export interface StemQuality {
  tier: SeparationTier;
  /** false when the tier came from a null column rather than from the worker */
  measured: boolean;
  sdr: number | null;
  sdrBasis: string | null;
  note: string;
  confidence: number;
  isStandIn: boolean;
  /** true when a producer should be told before they build on this stem */
  untrusted: boolean;
}

const TRUSTED_TIERS: readonly SeparationTier[] = ["reference", "strong"];

export function qualityOf(row: Pick<StemRow, "model" | "model_tier" | "model_sdr" | "model_sdr_basis" | "is_stand_in" | "quality_confidence" | "quality_note">): StemQuality {
  // The two signals can contradict each other — a row whose name ends in
  // `-fake` but whose tier column says `strong`. The name wins, because the
  // worker writes it last and a stand-in is never a separation whatever a
  // column claims.
  const isStandIn = row.is_stand_in || isStandInModel(row.model);
  const measured = row.model_tier !== null;
  const tier: SeparationTier = isStandIn ? "stand_in" : (row.model_tier ?? "weak");
  return {
    tier,
    measured,
    sdr: isStandIn ? null : row.model_sdr,
    sdrBasis: isStandIn ? "not a separation model" : row.model_sdr_basis,
    note: (isStandIn ? null : row.quality_note) ?? (measured || isStandIn ? TIER_NOTE[tier] : "this stem predates the quality columns, so what produced it is unknown"),
    confidence: isStandIn ? TIER_CONFIDENCE.stand_in : (row.quality_confidence ?? TIER_CONFIDENCE[tier]),
    isStandIn,
    untrusted: !measured || isStandIn || !TRUSTED_TIERS.includes(tier),
  };
}

/** Display order of stem names inside one model's group (and on the pads). */
export const STEM_ORDER: readonly string[] = ["drums", "bass", "vocals", "other", "guitar", "piano", "instrumental"];

export function stemOrderIndex(stem: string): number {
  const i = STEM_ORDER.indexOf(stem);
  return i < 0 ? STEM_ORDER.length : i;
}

/** The development stand-in labels its rows `<model>-fake` (jobs/stems.py). */
export function isStandInModel(model: string): boolean {
  return model.endsWith("-fake");
}

export function baseModelOf(model: string): string {
  return model.replace(/-fake$/, "");
}

export interface FileVitals {
  bpm: number | null;
  bpm_confidence: number | null;
  key: { tonic: string; mode: Mode } | null;
  key_confidence: number | null;
}

/** The subset of a derived file's row the lists need (the report itself stays server-side). */
export interface DerivedFileSummary {
  id: string;
  kind: FileKind;
  status: FileStatus;
  duration_s: number | null;
  original_filename: string;
  vitals: FileVitals | null;
}

export interface StemWithFile extends StemRow {
  file: DerivedFileSummary | null;
}

export interface StemsListResponse {
  stems: StemWithFile[];
}

/**
 * Ask for a split. `model` is the escape hatch for a producer who knows exactly
 * which separator they want; `resolve_model` honours it and says in the job's
 * result if something better was available, so the choice is never silent.
 */
export interface SeparateRequest {
  stems?: readonly string[];
  model?: StemModelId;
}

/** BPM and key with their confidence, read from the effective report. */
export function vitalsOf(report: AnalysisReport | null | undefined): FileVitals | null {
  if (!report) return null;
  const eff = effective(report);
  return {
    bpm: eff.tempo?.bpm ?? null,
    bpm_confidence: eff.tempo?.confidence ?? null,
    key: eff.key ? { tonic: eff.key.tonic, mode: eff.key.mode } : null,
    key_confidence: eff.key?.confidence ?? null,
  };
}

export function summarizeFile(file: Pick<FileRow, "id" | "kind" | "status" | "duration_s" | "original_filename" | "report">): DerivedFileSummary {
  return {
    id: file.id,
    kind: file.kind,
    status: file.status,
    duration_s: file.duration_s,
    original_filename: file.original_filename,
    vitals: vitalsOf(file.report),
  };
}

/** One fetch, JSON in and out, `{ error }` bodies thrown as ApiError (lib/api/client.ts conventions). */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    credentials: "same-origin",
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const err = body as { error?: string; details?: unknown } | null;
    throw new ApiError(res.status, err?.error ?? `${res.status} ${res.statusText}`, err?.details);
  }
  return body as T;
}

export const stemsApi = {
  list: (fileId: string) => apiFetch<StemsListResponse>(`/api/files/${encodeURIComponent(fileId)}/stems`),
  separate: (fileId: string, body: SeparateRequest = {}) =>
    apiFetch<JobResponse>(`/api/files/${encodeURIComponent(fileId)}/stems`, { method: "POST", body: JSON.stringify(body) }),
};
