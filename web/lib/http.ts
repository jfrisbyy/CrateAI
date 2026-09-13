// Route-handler helpers: JSON responses, typed errors, body validation, and
// the "who is calling" check every route starts with.

import type { PostgrestError, User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { EnvError } from "@/lib/env";
import { createClient, type ServerSupabase } from "@/lib/supabase/server";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function errorResponse(status: number, message: string, details?: unknown): NextResponse {
  return NextResponse.json({ error: message, details: details ?? null }, { status });
}

/** Wrap a handler so thrown HttpErrors become JSON and anything else a 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message, err.details);
    if (err instanceof EnvError) return errorResponse(503, err.message);
    const message = err instanceof Error ? err.message : "unexpected error";
    console.error("[api]", err);
    return errorResponse(500, message);
  }
}

export async function requireUser(): Promise<{ supabase: ServerSupabase; user: User }> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new HttpError(401, "Sign in to continue.");
  return { supabase, user };
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "Invalid request body.", parsed.error.issues);
  }
  return parsed.data;
}

/** Map a PostgREST error to an HTTP status: unique violations are 409, RLS denials 403. */
export function dbError(error: PostgrestError, context: string): HttpError {
  if (error.code === "23505") return new HttpError(409, `${context}: already exists.`, error.message);
  if (error.code === "42501") return new HttpError(403, `${context}: not allowed.`, error.message);
  if (error.code === "23514") return new HttpError(400, `${context}: value not allowed.`, error.message);
  if (error.code === "PGRST116") return new HttpError(404, `${context}: not found.`);
  return new HttpError(500, `${context}: ${error.message}`, error.code);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(id: string | undefined, what = "id"): string {
  if (!id || !UUID_RE.test(id)) throw new HttpError(400, `Invalid ${what}.`);
  return id;
}
