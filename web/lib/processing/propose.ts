// The AI seam.
//
// PRODUCT_DIRECTION: "The differentiator is that the AI drives these tools.
// 'This trumpet sounds awful, clean it up' should produce a real, visible,
// editable EQ curve — not a black box, and not a menu the user has to learn."
//
// So this file is the contract, not the caller. It says:
//
//   what a model is told (`ProcessingBrief` — the track, what was measured
//   about its source, and exactly what the controls read right now),
//   what it is allowed to answer with (`PROPOSE_PROCESSING_TOOL` — a strict
//   schema whose fields are the controls themselves, in the units on the
//   controls), and
//   what happens to that answer (`parseProposal` validates it, and
//   `applyProposal` in moves.ts clamps it and reports every difference).
//
// It never calls an API. `requestProposal` takes the call as an argument, so
// the whole seam is asserted in node against a fake that answers well, badly,
// out of range, and not at all. Wiring the real one is one entry in
// `lib/chat/tools.ts` and one handler; both are outside this seam.
//
// The grounding rule (principle 2) is enforced by the shape: the only facts in
// the brief are ones something measured, each with the measurement named, and
// the schema gives the model nowhere to return a fact — only moves and the
// reason for each. A proposal is a judgement about what to do, never a claim
// about what the audio is.

import { z } from "zod";
import { describeProcessing } from "./chain";
import { formatHz } from "./eq";
import { applyProposal, type AppliedProposal, type ProcessingProposal, type ProposalGuards } from "./moves";
import { BAND_IDS, BAND_NAMES, HIGHPASS_CEILING_HZ, LOWPASS_FLOOR_HZ, MAX_BOOST_DB, MAX_CUT_DB, MAX_FREQ_HZ, MAX_TRIM_DB, MAX_TUNE_CENTS, MIN_FREQ_HZ, type TrackProcessing } from "./types";

/** One measured number, with what measured it — the shape the rest of the product uses. */
export interface Measured {
  value: number | null;
  confidence: number | null;
  method: string | null;
}

/**
 * What a model is given. Small on purpose: a payload a model can answer well is
 * one where every field is either the producer's own words, a measurement with
 * its method, or the current position of a control it is about to move.
 */
export interface ProcessingBrief {
  /** the producer's words, verbatim and unedited */
  complaint: string;
  track: {
    id: string;
    name: string;
    /** "Masquerade, drums, bars 9-16" — the line the lane already shows */
    provenance: string | null;
    /** "drums", "vocals", "other" when this is a separated stem */
    stem: string | null;
    /** which separator made it; everything downstream inherits that choice */
    separationModel: string | null;
    /** the record this came out of */
    sourceName: string | null;
    /** the resampling already in play to fit the session; 1 when none */
    rate: number;
  };
  /**
   * Where the source's real bandwidth ends. The direction document is explicit
   * that this matters: an upload with a 13.5 kHz ceiling has no air to lift,
   * and a model that does not know that will cheerfully propose a 16 kHz shelf.
   */
  bandwidth: Measured | null;
  /** the session's tempo, when it has one */
  tempoBpm: number | null;
  /** what the controls read right now, so a second ask builds on the first */
  current: TrackProcessing;
  /** what the controls will not do, stated rather than discovered */
  limits: {
    maxBoostDb: number;
    maxCutDb: number;
    minFrequencyHz: number;
    maxFrequencyHz: number;
    highpassCeilingHz: number;
    lowpassFloorHz: number;
    maxTrimDb: number;
    maxTuneCents: number;
  };
}

export const BRIEF_LIMITS: ProcessingBrief["limits"] = {
  maxBoostDb: MAX_BOOST_DB,
  maxCutDb: MAX_CUT_DB,
  minFrequencyHz: MIN_FREQ_HZ,
  maxFrequencyHz: MAX_FREQ_HZ,
  highpassCeilingHz: HIGHPASS_CEILING_HZ,
  lowpassFloorHz: LOWPASS_FLOOR_HZ,
  maxTrimDb: MAX_TRIM_DB,
  maxTuneCents: MAX_TUNE_CENTS,
};

export interface BriefInput {
  complaint: string;
  track: ProcessingBrief["track"];
  current: TrackProcessing;
  bandwidth?: Measured | null;
  tempoBpm?: number | null;
}

export function buildBrief(input: BriefInput): ProcessingBrief {
  return {
    complaint: input.complaint.trim(),
    track: input.track,
    bandwidth: input.bandwidth ?? null,
    tempoBpm: input.tempoBpm ?? null,
    current: input.current,
    limits: BRIEF_LIMITS,
  };
}

/** The guard `applyProposal` needs, taken from the brief so the two cannot disagree. */
export function guardsFor(brief: ProcessingBrief): ProposalGuards {
  return { sourceCeilingHz: brief.bandwidth?.value ?? null };
}

/**
 * The brief as the few lines a model actually reads well: no nesting, every
 * number with its unit, and the measurement named wherever there is one.
 */
export function briefLines(brief: ProcessingBrief): string[] {
  const lines: string[] = [];
  lines.push(`complaint: ${brief.complaint || "(none given)"}`);
  lines.push(`track: ${brief.track.name}${brief.track.provenance ? ` — ${brief.track.provenance}` : ""}`);
  if (brief.track.stem) lines.push(`stem: ${brief.track.stem}${brief.track.separationModel ? `, separated with ${brief.track.separationModel}` : ""}`);
  if (brief.track.rate !== 1) lines.push(`playing at ${Math.round(brief.track.rate * 1000) / 1000}x, so pitch has moved with tempo`);
  const bandwidth = brief.bandwidth;
  if (bandwidth?.value != null) {
    lines.push(`source bandwidth: ${formatHz(bandwidth.value)}${bandwidth.method ? ` (${bandwidth.method})` : ""} — nothing above this is in the file, so do not lift above it`);
  } else {
    lines.push("source bandwidth: not measured — do not assume there is air to lift");
  }
  if (brief.tempoBpm) lines.push(`session tempo: ${Math.round(brief.tempoBpm * 10) / 10} BPM`);
  lines.push(`chain now: ${describeProcessing(brief.current)}`);
  lines.push(`limits: boosts to +${brief.limits.maxBoostDb} dB, cuts to -${brief.limits.maxCutDb} dB, high-pass no higher than ${brief.limits.highpassCeilingHz} Hz, low-pass no lower than ${brief.limits.lowpassFloorHz} Hz`);
  return lines;
}

// --- the tool the model answers with -----------------------------------------

const BAND_LIST = BAND_IDS.map((id) => `${id} (${BAND_NAMES[id]})`).join(", ");

/**
 * Shaped like the entries in lib/chat/tools.ts (strict, additionalProperties
 * false) so adding it to CHAT_TOOLS is one line. The description says what the
 * tool does *and* what it never does, which is the convention there.
 */
export const PROPOSE_PROCESSING_TOOL = {
  name: "propose_processing",
  description:
    "Propose corrective processing for one track in the session: EQ bands, input trim, and tuning. Every move lands on a control the producer can see and drag, and the curve is drawn from exactly these numbers — this is not a preset and not a hidden effect. Use it when the producer says something is wrong with how a part sounds (muddy, boomy, dull, harsh, thin, too loud) or asks for it to be cleaned up. Say what each move is for in `why`, in one clause, about the move and not about the audio: it must never claim a measured fact that was not given to you. Boosts are capped at +" +
    `${MAX_BOOST_DB} dB and cuts at -${MAX_CUT_DB} dB; a high-pass may not go above ${HIGHPASS_CEILING_HZ} Hz and a low-pass may not go below ${LOWPASS_FLOOR_HZ} Hz; anything past those is clamped and the producer is told. Never lift above the source's measured bandwidth — there is nothing there to lift. Prefer two or three moves that are easy to judge over a chain of small ones. This tool changes nothing on its own: the producer sees the curve and keeps or drops it.`,
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      track_id: { type: "string", description: "The track in the session the moves apply to." },
      summary: { type: "string", description: "One clause saying what this is for, in the producer's language (\"the build-up in the low mids\"). No measured claims." },
      confidence: { type: "number", description: "0 to 1: how sure this is the right move given only what you were told. The hedge word shown to the producer comes from this band." },
      moves: {
        type: "array",
        description: "The moves, in the order they should be read. Two or three is usually right.",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["band", "trim", "tune"], description: "band moves an EQ slot; trim is the input gain before the filters; tune resamples the lane (pitch and time move together, like a sampler)." },
            band: { type: "string", enum: [...BAND_IDS], description: `Which slot, for op=band: ${BAND_LIST}. hp and lp have no gain.` },
            frequency_hz: { type: "number", description: "For op=band: where the slot sits, in Hz." },
            gain_db: { type: "number", description: "For op=band on ls, lo, mid, hi, hs: how much, in dB. Negative cuts." },
            q: { type: "number", description: "For op=band on lo, mid, hi: how narrow. About 1 for a musical dip, 3 or more for a spike. Ignored by the shelves." },
            trim_db: { type: "number", description: "For op=trim: the input gain in dB." },
            tune_cents: { type: "number", description: "For op=tune: cents. 100 is a semitone. This resamples, so time moves with pitch." },
            why: { type: "string", description: "One clause about what this move does and why it is the right shape. Never a claim about the audio that was not measured and given to you." },
          },
          required: ["op", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["track_id", "summary", "confidence", "moves"],
    additionalProperties: false,
  },
} as const;

// --- validating what comes back ----------------------------------------------

const rawMove = z.object({
  op: z.enum(["band", "trim", "tune"]),
  band: z.enum(BAND_IDS as unknown as [string, ...string[]]).optional(),
  frequency_hz: z.number().finite().optional(),
  gain_db: z.number().finite().optional(),
  q: z.number().finite().optional(),
  trim_db: z.number().finite().optional(),
  tune_cents: z.number().finite().optional(),
  why: z.string().trim().min(1).max(400),
});

const rawProposal = z.object({
  track_id: z.string().trim().min(1),
  summary: z.string().trim().min(1).max(300),
  confidence: z.number().min(0).max(1).nullable(),
  moves: z.array(rawMove).min(1).max(8),
});

export interface ParsedProposal {
  trackId: string;
  proposal: ProcessingProposal;
}

export type ProposalFailure = { ok: false; reason: string };
export type ProposalSuccess = { ok: true; value: ParsedProposal };
export type ProposalResult = ProposalSuccess | ProposalFailure;

/**
 * Turn whatever came back into a proposal, or say why it could not be one.
 * Deliberately unforgiving: a malformed answer becomes a refusal the producer
 * can read, never a half-applied chain.
 */
export function parseProposal(raw: unknown): ProposalResult {
  const parsed = rawProposal.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, reason: first ? `${first.path.join(".") || "proposal"}: ${first.message}` : "the answer was not a proposal." };
  }
  const moves: ProcessingProposal["moves"] = [];
  const notes: string[] = [];
  for (const move of parsed.data.moves) {
    if (move.op === "band") {
      if (!move.band || !BAND_IDS.includes(move.band as (typeof BAND_IDS)[number])) {
        notes.push(`a move named no band, so it was skipped (${move.why}).`);
        continue;
      }
      const band = move.band as (typeof BAND_IDS)[number];
      if (move.frequency_hz === undefined && move.gain_db === undefined && move.q === undefined) {
        notes.push(`the move on ${BAND_NAMES[band].toLowerCase()} changed nothing, so it was skipped.`);
        continue;
      }
      moves.push({
        op: "band",
        band,
        ...(move.frequency_hz === undefined ? {} : { frequency: move.frequency_hz }),
        ...(move.gain_db === undefined ? {} : { gainDb: move.gain_db }),
        ...(move.q === undefined ? {} : { q: move.q }),
        enabled: true,
        why: move.why,
      });
    } else if (move.op === "trim") {
      if (move.trim_db === undefined) {
        notes.push("a trim move carried no number, so it was skipped.");
        continue;
      }
      moves.push({ op: "trim", db: move.trim_db, why: move.why });
    } else {
      if (move.tune_cents === undefined) {
        notes.push("a tune move carried no number, so it was skipped.");
        continue;
      }
      moves.push({ op: "tune", cents: move.tune_cents, why: move.why });
    }
  }
  if (moves.length === 0) return { ok: false, reason: notes[0] ?? "the answer had no usable moves in it." };
  return { ok: true, value: { trackId: parsed.data.track_id, proposal: { moves, summary: parsed.data.summary, confidence: parsed.data.confidence, notes } } };
}

/** How the caller reaches a model. Injected, always: nothing in this folder opens a connection. */
export type ProcessingOracle = (brief: ProcessingBrief) => Promise<unknown>;

export interface RequestResult {
  ok: boolean;
  /** the applied chain and the account of it, when it worked */
  result: AppliedProposal | null;
  proposal: ProcessingProposal | null;
  /** why not, in one line a producer can read */
  reason: string | null;
}

/**
 * Ask, validate, clamp, apply. The only function here that is asynchronous,
 * and it is asynchronous because the caller's `ask` is — a test hands it a
 * function that returns an object, and nothing about the seam changes.
 */
export async function requestProposal(brief: ProcessingBrief, ask: ProcessingOracle): Promise<RequestResult> {
  let raw: unknown;
  try {
    raw = await ask(brief);
  } catch (err) {
    return { ok: false, result: null, proposal: null, reason: err instanceof Error ? err.message : "the request failed." };
  }
  const parsed = parseProposal(raw);
  if (!parsed.ok) return { ok: false, result: null, proposal: null, reason: parsed.reason };
  const applied = applyProposal(brief.current, parsed.value.proposal, guardsFor(brief));
  if (applied.empty) {
    return { ok: false, result: applied, proposal: parsed.value.proposal, reason: "those moves would not change anything the chain is not already doing." };
  }
  return { ok: true, result: applied, proposal: parsed.value.proposal, reason: null };
}
