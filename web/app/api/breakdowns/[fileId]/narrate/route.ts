// POST /api/breakdowns/[fileId]/narrate { version? } — stream the mentor's narration of the
// breakdown under the grounding contract (BUILD_PACKET section 14), then save it to
// breakdowns.narration.
//
// The response is newline-delimited JSON (lib/narration/stream.ts): `paragraph` events
// carry text that has already passed lib/narration/validate.ts, `note` events say what
// was removed or why the measured document is standing in, `done` closes with what was
// saved. Nothing unvalidated is ever sent. Without ANTHROPIC_API_KEY the measured
// document streams with a note instead of an error.

import { z } from "zod";
import { createAnthropicNarrator } from "@/lib/anthropic/narrate";
import { dbError, handle, HttpError, requireUser, requireUuid } from "@/lib/http";
import { runNarration, type NarrationOutcome } from "@/lib/narration/run";
import { encodeNarrationEvent, NARRATION_CONTENT_TYPE, type NarrationWireEvent } from "@/lib/narration/stream";

const schema = z.object({
  version: z.number().int().positive().optional(),
});

async function parseOptionalBody(req: Request): Promise<z.infer<typeof schema>> {
  const text = await req.text();
  if (!text.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid request body.", parsed.error.issues);
  return parsed.data;
}

export async function POST(req: Request, ctx: { params: Promise<{ fileId: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const fileId = requireUuid((await ctx.params).fileId, "file id");
    const body = await parseOptionalBody(req);

    let query = supabase.from("breakdowns").select("*").eq("file_id", fileId);
    if (body.version !== undefined) query = query.eq("version", body.version);
    const { data: row, error } = await query.order("version", { ascending: false }).limit(1).maybeSingle();
    if (error) throw dbError(error, "Loading the breakdown");
    if (!row) throw new HttpError(404, body.version !== undefined ? `Breakdown version ${body.version} not found.` : "No breakdown yet. Run the breakdown first.");

    const narrator = createAnthropicNarrator();
    const content = row.content;
    const abort = new AbortController();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: NarrationWireEvent) => controller.enqueue(encoder.encode(encodeNarrationEvent(event)));
        try {
          const run = runNarration(narrator, content, { signal: abort.signal });
          let outcome: NarrationOutcome;
          while (true) {
            const next = await run.next();
            if (next.done) {
              outcome = next.value;
              break;
            }
            send(next.value);
          }

          // Only the model's validated text is the narration; the measured
          // document standing in for it is shown, not saved.
          let saved = false;
          if (outcome.source === "model" && outcome.text.trim().length > 0 && !abort.signal.aborted) {
            const update = await supabase.from("breakdowns").update({ narration: outcome.text }).eq("id", row.id);
            if (update.error) send({ type: "note", text: `The narration could not be saved: ${update.error.message}` });
            else saved = true;
          }
          send({
            type: "done",
            text: outcome.text,
            source: outcome.source,
            removed: outcome.removed,
            stop: outcome.stop,
            saved,
            version: row.version,
          });
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : "The narration failed." });
        } finally {
          controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": NARRATION_CONTENT_TYPE,
        "cache-control": "no-store",
        "x-breakdown-id": row.id,
        "x-breakdown-version": String(row.version),
      },
    });
  });
}
