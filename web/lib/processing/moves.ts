// A proposal: a set of moves against the same controls the mouse moves, and
// the arithmetic that applies them.
//
// This is the middle of the AI seam. Whatever decides — the narrow command
// line in complaints.ts, or a model through propose.ts — produces one of these
// and nothing else, and it comes back through `setBand` / `setTrim` /
// `setTune` like any drag. There is no path by which a sentence changes a
// chain without moving the control the producer can see and correct, which is
// the requirement in PRODUCT_DIRECTION:
//
//   "This trumpet sounds awful, clean it up" should produce a real, visible,
//   editable EQ curve — not a black box, and not a menu the user has to learn.
//
// Two things this file refuses to do quietly:
//
//   It never applies a move bigger than the limits in types.ts. It clamps and
//   says so in a note, so an over-eager answer becomes a visible, smaller move
//   rather than a silent one.
//
//   It never boosts above the source's measured bandwidth. A record that stops
//   at 13.5 kHz has nothing at 16 kHz to lift, and a shelf up there lifts the
//   noise floor of a lossy file. The measurement comes from the report
//   (Spectral.bandwidth); when nothing measured it, nothing is assumed.

import { hedgeWord } from "@/lib/report/hedge";
import { bandOf, clampFrequency, clampGainDb, clampQ, clampTrimDb, clampTuneCents, defaultProcessing, setBand, setBypass, setTrim, setTune } from "./chain";
import { formatDb, formatHz } from "./eq";
import { describeTune } from "./tune";
import { BAND_IDS, BAND_NAMES, type BandId, type TrackProcessing } from "./types";

export type ProcessingMove =
  | { op: "band"; band: BandId; frequency?: number; gainDb?: number; q?: number; enabled?: boolean; why: string }
  | { op: "trim"; db: number; why: string }
  | { op: "tune"; cents: number; why: string }
  | { op: "bypass"; on: boolean; why: string }
  | { op: "reset"; why: string };

export interface ProcessingProposal {
  /** what to do, in the order it should be read */
  moves: ProcessingMove[];
  /** one line in the product's voice, already hedged for `confidence` */
  summary: string;
  /** null means nothing measured this; the hedge word comes from lib/report/hedge.ts */
  confidence: number | null;
  /** what was not done, and why. Never empty for a refusal. */
  notes: string[];
}

export const EMPTY_PROPOSAL: ProcessingProposal = { moves: [], summary: "", confidence: null, notes: [] };

export interface ProposalGuards {
  /** the top of the source's real bandwidth, Hz, as measured. Null when nothing measured it. */
  sourceCeilingHz?: number | null;
}

export interface AppliedMove {
  move: ProcessingMove;
  /** what the control now reads, in the words the control uses */
  line: string;
  /** why this was smaller or different from what was asked for; null when it was not */
  note: string | null;
}

export interface AppliedProposal {
  processing: TrackProcessing;
  applied: AppliedMove[];
  /** everything that was clamped, refused or skipped, in one list */
  notes: string[];
  /** true when nothing at all changed */
  empty: boolean;
}

/**
 * Run a proposal over a chain. Pure: hand it the chain the producer is looking
 * at and it returns the next one plus an account of every difference between
 * what was asked for and what was done.
 */
export function applyProposal(processing: TrackProcessing, proposal: ProcessingProposal, guards: ProposalGuards = {}): AppliedProposal {
  let next = processing;
  const applied: AppliedMove[] = [];
  const notes = [...proposal.notes];

  for (const move of proposal.moves) {
    const before = next;
    let note: string | null = null;

    switch (move.op) {
      case "reset":
        next = defaultProcessing();
        break;
      case "bypass":
        next = setBypass(next, move.on);
        break;
      case "trim": {
        const asked = move.db;
        const db = clampTrimDb(asked);
        if (db !== asked) note = `asked for ${formatDb(asked)} of trim; the trim goes to ${formatDb(db)}.`;
        next = setTrim(next, db);
        break;
      }
      case "tune": {
        const asked = move.cents;
        const cents = clampTuneCents(asked);
        if (cents !== asked) note = `asked for ${Math.round(asked)} cents; tuning stops at an octave either way.`;
        next = setTune(next, cents);
        break;
      }
      case "band": {
        if (!BAND_IDS.includes(move.band)) {
          notes.push(`there is no band called ${String(move.band)}, so that move was skipped.`);
          continue;
        }
        const current = bandOf(next, move.band);
        let frequency = move.frequency === undefined ? current.frequency : clampFrequency(move.band, move.frequency);
        const gainDb = move.gainDb === undefined ? current.gainDb : clampGainDb(move.band, move.gainDb);
        const q = move.q === undefined ? current.q : clampQ(move.q);

        if (move.frequency !== undefined && frequency !== move.frequency) {
          note = `asked for ${formatHz(move.frequency)}; ${BAND_NAMES[move.band].toLowerCase()} stops at ${formatHz(frequency)} — past there it is an effect, not a correction.`;
        }
        if (move.gainDb !== undefined && gainDb !== move.gainDb) {
          note = `asked for ${formatDb(move.gainDb)}; this goes to ${formatDb(gainDb)}.`;
        }

        // The bandwidth rule. Boosting above what the file actually contains
        // lifts the noise floor of a lossy upload and nothing else, so the move
        // is pulled down to the ceiling and the producer is told why.
        const ceiling = guards.sourceCeilingHz ?? null;
        if (ceiling !== null && ceiling > 0 && gainDb > 0 && frequency > ceiling) {
          const pulled = clampFrequency(move.band, ceiling);
          note = `the record stops at ${formatHz(ceiling)}, so a lift at ${formatHz(frequency)} would be lifting nothing that is there; moved to ${formatHz(pulled)}.`;
          frequency = pulled;
        }

        const enabled = move.enabled === undefined ? true : move.enabled;
        next = setBand(next, move.band, { frequency, gainDb, q, enabled });
        break;
      }
    }

    if (next !== before) applied.push({ move, line: describeMove(move, next), note });
    if (note) notes.push(note);
  }

  return { processing: next, applied, notes, empty: next === processing };
}

/** What one move did, in the words the control uses. */
export function describeMove(move: ProcessingMove, processing: TrackProcessing): string {
  switch (move.op) {
    case "reset":
      return "put the chain back to nothing";
    case "bypass":
      return move.on ? "bypassed the chain" : "engaged the chain";
    case "trim":
      return `trim to ${formatDb(processing.trimDb)}`;
    case "tune":
      return `tuned ${describeTune(processing.tuneCents)}`;
    case "band": {
      const band = bandOf(processing, move.band);
      const name = BAND_NAMES[band.id];
      if (band.kind === "highpass" || band.kind === "lowpass") return `${name.toLowerCase()} at ${formatHz(band.frequency)}`;
      const direction = band.gainDb >= 0 ? "up" : "down";
      return `${formatHz(band.frequency)} ${direction} ${formatDb(Math.abs(band.gainDb))}${band.kind === "peaking" ? `, Q ${Math.round(band.q * 100) / 100}` : " on the shelf"}`;
    }
  }
}

/**
 * The proposal as one sentence, hedged by its own confidence, in the vocabulary
 * the rest of the product already uses (lib/report/hedge.ts). A proposal is a
 * judgement, not a measurement, so it never states a fact about the audio; the
 * facts it is allowed to repeat are the ones that were measured and handed to
 * it in the brief.
 */
export function summarise(proposal: ProcessingProposal, processing: TrackProcessing): string {
  if (proposal.moves.length === 0) return proposal.summary;
  const word = hedgeWord(proposal.confidence);
  const lines = proposal.moves.map((move) => describeMove(move, processing));
  const body = `${lines.join(", ")}`;
  if (word === "" || word === "not measured") return `${proposal.summary} — ${body}`;
  if (word === "I can't tell") return `${proposal.summary} — ${body}. I can't tell whether that is the right call from the measurements alone; A/B it.`;
  return `${word}: ${proposal.summary} — ${body}`;
}
