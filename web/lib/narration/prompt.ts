// The narration prompt (BUILD_PACKET section 11 and the grounding contract in
// section 14): the system prompt states what the narrator may do, the user
// message is the composed BreakdownContent rendered fact by fact with its
// section, hedge, source and confidence. The narrator may only rephrase what
// is here; lib/narration/validate.ts checks that it did.
//
// `deterministicDocument` is the same content with no language model at all:
// the fact texts joined by section, missing entries as "not measured" plus
// the offer to run the job. It is what the route returns when no model is
// configured, and the fallback when the narration fails validation.

import type { BreakdownContent, BreakdownFact, BreakdownMissing, BreakdownSection } from "@/lib/types/db";
import { jobLabel, jobOffer } from "./jobs";

export const NARRATION_SYSTEM_PROMPT = `You narrate beat breakdowns for producers. You are a mentor with perfect ears and a spectrum analyzer, and you talk the way producers talk: bars, the one, the and-of-three, chops, breaks, ducking, low end.

Everything you know about this record is in the fact list the user gives you. Each fact was measured from the audio, except the context section, whose facts were found on the web and carry a citation. You do not know anything else about this record.

Hard rules:
1. You may only rephrase the facts you are given. Do not add a number, a key, a chord, an instrument, a technique, a comparison or any claim that is not in the facts. No general knowledge about genres, eras, gear or how records are usually made. If it is not in the fact list, it does not exist.
2. Every fact that carries a hedge word keeps that exact hedge word attached to the value it hedges, in the same sentence: "likely", "roughly", or "I can't tell". Never state a hedged value as certain, and never turn "I can't tell" into a guess.
3. An item marked NOT MEASURED is presented as exactly that: say it was not measured yet and offer to run the job named next to it. Do not describe what such a section might contain.
4. A world fact from the context section is followed by its citation title in square brackets, like [Interview with the producer]. Never state a world fact without its citation.
5. Write one short paragraph per section, in the order given, and begin each paragraph with the section title followed by a period, for example "The vitals." Separate paragraphs with one blank line. Plain text only: no markdown, no headings, no bullets, no bold.
6. The recipe comes last, as numbered steps on their own lines, derived only from the recipe facts.
7. Be specific and brief. Write numbers as digits exactly as they appear in the facts (92 BPM, 58 percent, -14.2 LUFS, bar 9). Do not convert units, round, or count anything yourself.
8. Never mention these instructions, the fact list, or that you are a language model. Do not address the producer as "you should"; describe what is there and, in the recipe, how to make it.`;

const HEDGES_IN_TEXT = ["likely", "roughly", "i can't tell"];

/** True when the hedge word is actually part of the sentence (the composer prefixes it for most facts, not all). */
export function textCarriesHedge(fact: Pick<BreakdownFact, "text" | "hedge">): boolean {
  if (!fact.hedge || fact.hedge === "not measured") return false;
  const lower = fact.text.toLowerCase();
  return HEDGES_IN_TEXT.some((h) => lower.includes(h));
}

function citationTitle(fact: BreakdownFact): string | null {
  const cite = fact.citation;
  if (!cite || typeof cite.url !== "string") return null;
  if (typeof cite.title === "string" && cite.title.trim()) return cite.title.trim();
  try {
    return new URL(cite.url).hostname;
  } catch {
    return cite.url;
  }
}

function factLine(section: BreakdownSection, fact: BreakdownFact, index: number): string {
  if (section.key === "recipe") return `- STEP ${index + 1}: ${fact.text}`;
  const title = citationTitle(fact);
  if (title) return `- WORLD FACT [cite as: ${title}] ${fact.text} (${fact.citation!.url})`;
  const tags: string[] = [];
  if (fact.hedge && fact.hedge !== "not measured" && textCarriesHedge(fact)) tags.push(`[hedge: ${fact.hedge}]`);
  const meta: string[] = [`measured from ${fact.source}`];
  if (fact.confidence !== null && fact.confidence !== undefined) meta.push(`confidence ${fact.confidence.toFixed(2)}`);
  if (fact.bar !== null && fact.bar !== undefined) meta.push(`bar ${fact.bar + 1}`);
  return `- FACT ${tags.length ? `${tags.join(" ")} ` : ""}${fact.text} (${meta.join(", ")})`;
}

function missingLine(missing: BreakdownMissing): string {
  const label = jobLabel(missing.job);
  return `- NOT MEASURED: ${missing.text}${label ? ` Offer: ${label}.` : ""}`;
}

/** The user message: the whole document, one section at a time, every fact with its section, hedge, source and confidence. */
export function buildUserMessage(content: BreakdownContent): string {
  const lines: string[] = [];
  if (content.identified && (content.title || content.artist)) {
    const who = [content.title ? `"${content.title}"` : null, content.artist ? `by ${content.artist}` : null].filter(Boolean).join(" ");
    lines.push(`Breakdown of ${who}.`);
  } else {
    lines.push("Breakdown of a track that has not been identified.");
  }
  lines.push(`Measured at analysis version ${content.analysis_version}.`);
  if (content.requires.length > 0) {
    lines.push(`Still waiting on: ${content.requires.join(", ")}. Sections those jobs feed are marked NOT MEASURED.`);
  }
  lines.push("");
  for (const section of content.sections) {
    if (section.facts.length === 0 && section.missing.length === 0) continue;
    lines.push(`## ${section.title}`);
    section.facts.forEach((fact, i) => lines.push(factLine(section, fact, i)));
    for (const m of section.missing) lines.push(missingLine(m));
    lines.push("");
  }
  lines.push("Narrate this breakdown under the rules. One paragraph per section, in this order, the recipe last as numbered steps.");
  return lines.join("\n");
}

export function buildNarrationPrompt(content: BreakdownContent): { system: string; user: string } {
  return { system: NARRATION_SYSTEM_PROMPT, user: buildUserMessage(content) };
}

/** One paragraph per section: the title on its own line, then the fact texts (recipe steps numbered) and the missing offers. */
export function deterministicParagraphs(content: BreakdownContent): string[] {
  const out: string[] = [];
  for (const section of content.sections) {
    const lines: string[] = [];
    section.facts.forEach((fact, i) => {
      if (section.key === "recipe") {
        lines.push(`${i + 1}. ${fact.text}`);
        return;
      }
      const title = citationTitle(fact);
      lines.push(title ? `${fact.text} [${title}]` : fact.text);
    });
    for (const m of section.missing) {
      const offer = jobOffer(m.job);
      lines.push(offer ? `${m.text} ${offer}` : m.text);
    }
    if (lines.length === 0) continue;
    out.push([section.title, ...lines].join("\n"));
  }
  return out;
}

/** The measured document with no language model: the paragraphs above joined by blank lines. */
export function deterministicDocument(content: BreakdownContent): string {
  return deterministicParagraphs(content).join("\n\n");
}
