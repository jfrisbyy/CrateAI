// POST /api/compat { file_id, limit?, stretch_tolerance?, max_semitones?,
// max_octaves?, kind?, include_keyless? } -> the caller's files that work with
// this one, ranked, each with the relationship, the stretch ratio, the semitone
// shift, and a confidence that says which measurement capped it.
//
// The database does the coarse filtering (compatible_files in
// 20260913000500_compat.sql: the octave-folded tempo window, the compatible key
// set, the caller's own ready rows only, under RLS). This route scores what
// comes back with lib/compat/theory.ts -- the same arithmetic as
// analysis/lockedgroove/analysis/compat.py -- so every number the user sees is
// produced in one place, and uses the CLAP embeddings both files already carry
// to break ties by timbre.

import { z } from "zod";
import { dbError, handle, HttpError, json, parseBody, requireUser, UUID_RE } from "@/lib/http";
import type { CompatResponse, CompatSource } from "@/lib/compat/client";
import { buildMatches, fileName, timbreSimilarity, vitalsFromFile, type EmbeddingLike } from "@/lib/compat/matches";
import { MAX_SHIFT, METHOD, USABLE_MAX } from "@/lib/compat/theory";
import { FILE_KINDS, type CompatibleFileRow, type FileRow } from "@/lib/types/db";

const schema = z.object({
  file_id: z.string().regex(UUID_RE),
  limit: z.number().int().min(1).max(100).optional(),
  stretch_tolerance: z.number().min(0).max(1).optional(),
  max_semitones: z.number().int().min(0).max(MAX_SHIFT).optional(),
  max_octaves: z.number().int().min(0).max(2).optional(),
  kind: z.enum(FILE_KINDS).nullable().optional(),
  include_keyless: z.boolean().optional(),
});

/** The coarse filter hands over more than the caller asked for, so ties can be broken before the cut. */
const COARSE_MULTIPLE = 3;
const COARSE_MAX = 100;

function sourceVitals(file: FileRow): CompatSource {
  const vitals = vitalsFromFile(file);
  return {
    file_id: file.id,
    name: fileName(file),
    bpm: vitals.bpm,
    bpm_confidence: vitals.bpm_confidence,
    tonic: vitals.tonic,
    mode: vitals.mode,
    key_confidence: vitals.key_confidence,
  };
}

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const body = await parseBody(req, schema);
    const limit = body.limit ?? 20;
    const tolerance = body.stretch_tolerance ?? USABLE_MAX;
    const maxSemitones = body.max_semitones ?? 2;
    const maxOctaves = body.max_octaves ?? 1;

    const source = await supabase.from("files").select("*").eq("id", body.file_id).maybeSingle();
    if (source.error) throw dbError(source.error, "Loading the file");
    if (!source.data) throw new HttpError(404, "File not found.");
    const sourceFile = source.data as FileRow;

    const empty = (note: string): CompatResponse => ({
      source: sourceVitals(sourceFile),
      matches: [],
      considered: 0,
      note,
      method: METHOD,
    });

    if (sourceFile.status !== "ready" || !sourceFile.report) {
      return json(empty("This file has not been analyzed yet, so there is nothing measured to match on."));
    }
    const vitals = vitalsFromFile(sourceFile);
    if (vitals.bpm === null && vitals.tonic === null) {
      return json(empty("Neither a tempo nor a key was measured on this file, so there is nothing to match on. Re-analyze it, or set the tempo by hand on the Report tab."));
    }

    const coarse = await supabase.rpc("compatible_files", {
      p_file_id: body.file_id,
      p_limit: Math.min(COARSE_MAX, limit * COARSE_MULTIPLE),
      p_stretch_tolerance: tolerance,
      p_max_semitones: maxSemitones,
      p_kind: body.kind ?? null,
      p_max_octaves: maxOctaves,
      p_include_keyless: body.include_keyless ?? true,
    });
    if (coarse.error) throw dbError(coarse.error, "Finding compatible files");
    const rows = (coarse.data ?? []) as CompatibleFileRow[];
    if (rows.length === 0) {
      return json(empty("Nothing else in the library lands in this tempo window and key family. Widen the stretch or the pitch shift, or bring in more material."));
    }

    const ids = rows.map((r) => r.file_id);
    const [files, embeddings] = await Promise.all([
      supabase.from("files").select("*").in("id", ids),
      supabase.from("embeddings").select("file_id, model, vector").in("file_id", [...ids, body.file_id]),
    ]);
    if (files.error) throw dbError(files.error, "Loading the matches");

    // an embedding is a nicety, not a requirement: a failure here costs the tie-break, not the answer
    const timbre = embeddings.error
      ? new Map<string, number>()
      : timbreSimilarity(body.file_id, (embeddings.data ?? []) as unknown as EmbeddingLike[]);

    const matches = buildMatches(sourceFile, (files.data ?? []) as FileRow[], timbre, {
      stretchTolerance: tolerance,
      maxSemitones,
      maxOctaves,
      limit,
    });

    const response: CompatResponse = {
      source: sourceVitals(sourceFile),
      matches,
      considered: rows.length,
      note:
        matches.length === 0
          ? "The database found candidates but none of them survived the exact tempo and key check. Widen the stretch tolerance."
          : timbre.size === 0 && matches.length > 1
            ? "Ranked on tempo and key only: these files have no CLAP embedding yet, so timbre could not break the ties. Run the embed job from the library."
            : null,
      method: METHOD,
    };
    return json(response);
  });
}
