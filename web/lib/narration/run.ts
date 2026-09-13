// Runs a narration under the grounding contract. Text arrives from the
// narrator as deltas; whole paragraphs are validated against the content
// before they are passed on, so nothing unmeasured is ever shown, even for a
// moment. A paragraph that fails is dropped and counted; when nothing
// survives, the model declines, or the call fails, the measured document
// takes its place and the note says so.

import type { BreakdownContent } from "@/lib/types/db";
import type { NarrateOptions, Narrator, NarratorStop } from "./narrator";
import { deterministicParagraphs } from "./prompt";
import { allowedFrom, validateNarration } from "./validate";

export type NarrationSource = "model" | "deterministic";

export type NarrationEvent =
  /** one validated paragraph, in order */
  | { type: "paragraph"; text: string }
  /** a short note for the producer about what happened */
  | { type: "note"; text: string }
  /** forget the paragraphs shown so far (the measured document follows) */
  | { type: "reset" };

export interface NarrationOutcome {
  /** the validated narration, or the measured document */
  text: string;
  source: NarrationSource;
  /** paragraphs removed because they said something that wasn't measured */
  removed: number;
  /** the validator's reasons for each removed paragraph */
  problems: string[];
  stop: NarratorStop | null;
  error: string | null;
}

export const NOTES = {
  noModel: "No narration model is configured (ANTHROPIC_API_KEY is not set), so this is the measured document itself.",
  refusal: "The model declined to narrate this record (stop reason: refusal). This is the measured document instead.",
  nothingKept:
    "Every line the narrator wrote said something that wasn't measured, so it was set aside. This is the measured document instead.",
  maxTokens: "The narration was cut off at the length limit (stop reason: max_tokens); the facts below are complete.",
  error: (message: string) => `Narration failed (${message}). This is the measured document instead.`,
  removed: (n: number) =>
    `${n === 1 ? "One line was" : `${n} lines were`} removed because ${n === 1 ? "it" : "they"} said something that wasn't measured; the facts below are complete.`,
} as const;

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").slice(0, 200);
}

export async function* runNarration(
  narrator: Narrator | null,
  content: BreakdownContent,
  options: NarrateOptions = {},
): AsyncGenerator<NarrationEvent, NarrationOutcome, undefined> {
  const fallback = async function* (note: string, stop: NarratorStop | null, error: string | null, removed: number, problems: string[]) {
    const paragraphs = deterministicParagraphs(content);
    yield { type: "reset" } as const;
    yield { type: "note", text: note } as const;
    for (const p of paragraphs) yield { type: "paragraph", text: p } as const;
    return { text: paragraphs.join("\n\n"), source: "deterministic" as const, removed, problems, stop, error };
  };

  if (!narrator) return yield* fallback(NOTES.noModel, null, null, 0, []);

  const kept: string[] = [];
  const problems: string[] = [];
  let removed = 0;
  let stop: NarratorStop | null = null;
  let error: string | null = null;

  const allowed = allowedFrom(content);
  const consider = (raw: string): NarrationEvent | null => {
    const text = raw.trim();
    if (!text) return null;
    const result = validateNarration(text, content, allowed);
    if (result.ok) {
      kept.push(text);
      return { type: "paragraph", text };
    }
    removed += 1;
    problems.push(...result.problems);
    return null;
  };

  let buffer = "";
  try {
    const it = narrator.narrate(content, options);
    while (true) {
      const next = await it.next();
      if (next.done) {
        stop = next.value;
        break;
      }
      buffer += next.value;
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const event = consider(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        if (event) yield event;
        cut = buffer.indexOf("\n\n");
      }
    }
    const last = consider(buffer);
    buffer = "";
    if (last) yield last;
  } catch (err) {
    error = errorText(err);
  }

  if (error !== null) return yield* fallback(NOTES.error(error), stop, error, removed, problems);
  if (stop === "refusal") return yield* fallback(NOTES.refusal, stop, null, removed, problems);
  if (kept.length === 0) return yield* fallback(NOTES.nothingKept, stop, null, removed, problems);

  if (removed > 0) yield { type: "note", text: NOTES.removed(removed) };
  if (stop === "max_tokens") yield { type: "note", text: NOTES.maxTokens };
  return { text: kept.join("\n\n"), source: "model", removed, problems, stop, error: null };
}
