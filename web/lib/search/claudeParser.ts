// The Claude half of the hybrid parser (BUILD_PACKET section 12): structured
// output against the same shape the rules produce. It runs only when the
// rules left free text behind and an API key is present; when the model's
// output does not parse (parsed_output null) or the call fails, the rules'
// result stands on its own. The client is injected so tests use a fake.

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { QUERY_PARSER_MAX_TOKENS, QUERY_PARSER_MODEL } from "@/lib/anthropic/models";
import { PITCH_CLASSES } from "@/lib/music/keys";
import { FILE_KINDS } from "@/lib/types/db";
import type { ParsedQuery } from "./parse";
import { TAG_VOCABULARY } from "./vocabulary";

export const QuerySchema = z.object({
  text_query: z.string().nullable(),
  bpm_min: z.number().nullable(),
  bpm_max: z.number().nullable(),
  key: z.object({ tonic: z.enum(PITCH_CLASSES), mode: z.enum(["major", "minor"]) }).nullable(),
  kind: z.enum(FILE_KINDS).nullable(),
  tags: z.array(z.string()),
  has_drums: z.boolean().nullable(),
  is_loop_based: z.boolean().nullable(),
  similar_to_current: z.boolean(),
});

export type StructuredQuery = z.infer<typeof QuerySchema>;

export const PARSER_SYSTEM = [
  "You turn a producer's library search into filters. Fill only what the query says; leave a field null when it is not said.",
  "tonic uses the sharp spelling: C, C#, D, D#, E, F, F#, G, G#, A, A#, B (Bb is A#, Eb is D#, Ab is G#, Db is C#, Gb is F#).",
  "Tempo: \"around N\" or \"about N\" is N-5 to N+5; \"N bpm\" or a bare tempo number is N-2 to N+2; \"slow\" alone is 60-85, \"fast\" alone is 120-180; a range \"a-b\" is a to b.",
  "kind: original, stem, chop, loop_render (a rendered loop), layer_render (a layer render), revoice_render (a re-voiced part), only when the query names one; otherwise null.",
  "has_drums: false for \"no drums\", \"drumless\", \"without drums\"; true for \"with drums\", \"drums only\"; otherwise null.",
  "is_loop_based: true when the producer asks for a loop or loop-based material; otherwise null.",
  "similar_to_current: true when the query says \"like this\", \"similar to this\", \"more like this\" about the open file.",
  `tags: lowercase producer terms that describe the sound, taken from this vocabulary when they appear or are clearly meant: ${TAG_VOCABULARY.join(", ")}. Keep the producer's own word too when it is not in the vocabulary (for example \"horns\").`,
  "text_query: the descriptive words that remain for a sound search (texture, instrument, mood, era), in the producer's words and order, without the filters and without filler like \"something\", \"find me\", \"in\", \"with\"; null when nothing descriptive remains.",
  "Never invent a filter the query does not state.",
].join("\n");

/** The one method the parser needs from the Anthropic client, so a test can fake it. */
export interface ParseClient {
  parse(params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: "user"; content: string }>;
    output_config: { format: ReturnType<typeof zodOutputFormat<typeof QuerySchema>> };
  }): Promise<{ parsed_output: unknown }>;
}

export async function parseWithClaude(query: string, client: ParseClient, model = QUERY_PARSER_MODEL): Promise<StructuredQuery | null> {
  try {
    const res = await client.parse({
      model,
      max_tokens: QUERY_PARSER_MAX_TOKENS,
      system: PARSER_SYSTEM,
      messages: [{ role: "user", content: query }],
      output_config: { format: zodOutputFormat(QuerySchema) },
    });
    if (res.parsed_output === null || res.parsed_output === undefined) return null;
    const checked = QuerySchema.safeParse(res.parsed_output);
    return checked.success ? checked.data : null;
  } catch {
    return null;
  }
}

/** The rules' fields win where they are set; Claude fills the rest and adds tags. */
export function mergeParsed(rules: ParsedQuery, claude: StructuredQuery | null): ParsedQuery {
  if (!claude) return rules;
  const tags = [...rules.tags];
  for (const t of claude.tags) {
    const clean = t.toLowerCase().trim();
    if (clean && !tags.includes(clean)) tags.push(clean);
  }
  const bpmFromClaude = rules.bpm_min === null && claude.bpm_min !== null && claude.bpm_max !== null && claude.bpm_min <= claude.bpm_max;
  return {
    text_query: claude.text_query?.trim() ? claude.text_query.trim() : rules.text_query,
    bpm_min: bpmFromClaude ? claude.bpm_min : rules.bpm_min,
    bpm_max: bpmFromClaude ? claude.bpm_max : rules.bpm_max,
    tonic: rules.tonic ?? claude.key?.tonic ?? null,
    mode: rules.mode ?? claude.key?.mode ?? null,
    kind: rules.kind ?? claude.kind ?? null,
    tags,
    has_drums: rules.has_drums ?? claude.has_drums ?? null,
    is_loop_based: rules.is_loop_based ?? claude.is_loop_based ?? null,
    similar: rules.similar || claude.similar_to_current,
    similar_to_file_id: rules.similar_to_file_id,
    parser: "rules+claude",
  };
}
