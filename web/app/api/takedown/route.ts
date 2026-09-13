// POST /api/takedown — the public DMCA notice form (BUILD_PACKET section 21).
// No sign-in required; rate limited per IP; a honeypot field drops bots. The
// row is written with the service role and reviewed by the owner (see
// docs/RUNBOOK.md). Nothing is removed automatically.

import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, handle, HttpError, json, parseBody, UUID_RE } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { createAdminClient } from "@/lib/supabase/admin";

export const takedownSchema = z.object({
  claimant_name: z.string().trim().min(2).max(200),
  claimant_email: z.string().trim().email().max(320),
  claimant_address: z.string().trim().max(500).optional(),
  work_description: z.string().trim().min(10).max(4000),
  infringing_description: z.string().trim().min(10).max(4000),
  file_id: z.string().regex(UUID_RE).optional(),
  good_faith: z.literal(true),
  accuracy_sworn: z.literal(true),
  signature: z.string().trim().min(2).max(200),
  website: z.string().max(0).optional(), // honeypot: humans leave it empty
});

export async function POST(req: Request) {
  return handle(async () => {
    if (!rateLimit(`takedown:${clientIp(req)}`, { capacity: 3, refillPerSec: 1 / 600 })) {
      throw new HttpError(429, "Too many notices from this address; try again later.");
    }
    const body = await parseBody(req, takedownSchema);
    const admin = createAdminClient();
    let userId: string | null = null;
    if (body.file_id) {
      const { data } = await admin.from("files").select("user_id").eq("id", body.file_id).maybeSingle();
      userId = data?.user_id ?? null;
    }
    const { data, error } = await admin.from("takedowns").insert({
      claimant_name: body.claimant_name,
      claimant_email: body.claimant_email,
      claimant_address: body.claimant_address ?? null,
      work_description: body.work_description,
      infringing_description: body.infringing_description,
      good_faith: body.good_faith,
      accuracy_sworn: body.accuracy_sworn,
      signature: body.signature,
      file_id: body.file_id ?? null,
      user_id: userId,
      source_ip: clientIp(req),
    }).select("id, created_at").single();
    if (error) return errorResponse(500, `Could not record the notice: ${error.message}`);
    console.info("[takedown] received", data.id);
    return json({ received: true, id: data.id, created_at: data.created_at }, { status: 201 });
  });
}

export function GET() {
  return NextResponse.json({ error: "POST a notice; see /legal/dmca" }, { status: 405 });
}
