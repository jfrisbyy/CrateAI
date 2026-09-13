// Processing is a property of a track, so it has to survive the track.
//
// The stored shape is the in-memory shape with a version on it, in camelCase,
// matching the convention the arrangement's `lineage` column already set
// (supabase/migrations/20260913001000_song_arrangement.sql queries it with
// `lineage ->> 'fileName'`). One jsonb per lane, one per session for the bus.
//
// Reading is deliberately forgiving in one direction only: a blob that is
// missing fields, has extra fields, or carries numbers from a future version
// with wider limits loads as a valid chain with everything clamped to what the
// controls can actually do. A blob that is not an object at all loads as no
// processing rather than throwing, because a song that will not open because
// of an EQ is a worse outcome than a song that opens flat.

import { clampFrequency, clampGainDb, clampQ, clampTrimDb, clampTuneCents, defaultMaster, defaultProcessing, setLimiter } from "./chain";
import { BAND_IDS, BAND_KINDS, clamp, MAX_CEILING_DB, MAX_RELEASE_MS, MIN_CEILING_DB, MIN_RELEASE_MS, type BandId, type EqBand, type MasterProcessing, type TrackProcessing } from "./types";

export const PROCESSING_VERSION = 1;

export interface StoredBand {
  id: BandId;
  frequency: number;
  gainDb: number;
  q: number;
  enabled: boolean;
}

export interface StoredProcessing {
  version: number;
  bypassed: boolean;
  trimDb: number;
  tuneCents: number;
  bands: StoredBand[];
}

export interface StoredMaster {
  version: number;
  bypassed: boolean;
  limiter: { enabled: boolean; ceilingDb: number; releaseMs: number };
}

/** The row's jsonb. `kind` is not stored: a slot's shape is fixed by its id (types.ts BAND_KINDS). */
export function toStored(processing: TrackProcessing): StoredProcessing {
  return {
    version: PROCESSING_VERSION,
    bypassed: processing.bypassed,
    trimDb: processing.trimDb,
    tuneCents: processing.tuneCents,
    bands: processing.bands.map((band) => ({ id: band.id, frequency: band.frequency, gainDb: band.gainDb, q: band.q, enabled: band.enabled })),
  };
}

export function toStoredMaster(master: MasterProcessing): StoredMaster {
  return { version: PROCESSING_VERSION, bypassed: master.bypassed, limiter: { ...master.limiter } };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A chain from a stored blob, or null when there was nothing there. Null and
 * "a chain that does nothing" are different: the first means the lane has no
 * processing at all and no nodes are doing anything.
 */
export function fromStored(raw: unknown): TrackProcessing | null {
  const row = record(raw);
  if (!row) return null;
  const base = defaultProcessing();
  const stored = new Map<BandId, Record<string, unknown>>();
  if (Array.isArray(row.bands)) {
    for (const entry of row.bands) {
      const band = record(entry);
      if (!band) continue;
      const id = band.id;
      if (typeof id === "string" && (BAND_IDS as readonly string[]).includes(id)) stored.set(id as BandId, band);
    }
  }
  const bands: EqBand[] = base.bands.map((band) => {
    const from = stored.get(band.id);
    if (!from) return band;
    return {
      id: band.id,
      kind: BAND_KINDS[band.id],
      frequency: clampFrequency(band.id, num(from.frequency, band.frequency)),
      gainDb: clampGainDb(band.id, num(from.gainDb, 0)),
      q: clampQ(num(from.q, band.q)),
      enabled: bool(from.enabled, false),
    };
  });
  return {
    bypassed: bool(row.bypassed, true),
    trimDb: clampTrimDb(num(row.trimDb, 0)),
    tuneCents: clampTuneCents(num(row.tuneCents, 0)),
    bands,
  };
}

export function fromStoredMaster(raw: unknown): MasterProcessing {
  const row = record(raw);
  if (!row) return defaultMaster();
  const limiter = record(row.limiter) ?? {};
  const base = defaultMaster();
  const next = setLimiter(base, {
    enabled: bool(limiter.enabled, false),
    ceilingDb: clamp(num(limiter.ceilingDb, base.limiter.ceilingDb), MIN_CEILING_DB, MAX_CEILING_DB),
    releaseMs: clamp(num(limiter.releaseMs, base.limiter.releaseMs), MIN_RELEASE_MS, MAX_RELEASE_MS),
  });
  return { ...next, bypassed: next.limiter.enabled ? false : bool(row.bypassed, true) };
}
