// Building requests for a route handler and reading what comes back.
//
// Handlers are called directly, the way Next calls them: a Request (or
// NextRequest, for the ones that read `nextUrl`) and, for dynamic segments, a
// context whose `params` is a promise.

import { NextRequest } from "next/server";

export const BASE = "http://localhost:3000";

/** Only what a route test needs to vary; NextRequest's own init type is wider. */
export interface TestInit {
  headers?: Record<string, string>;
}

function url(path: string): string {
  return path.startsWith("http") ? path : `${BASE}${path}`;
}

/** GET (or any body-less method) as a NextRequest, so `req.nextUrl` works. */
export function get(path: string, init: TestInit = {}): NextRequest {
  return new NextRequest(url(path), { method: "GET", headers: init.headers });
}

/** POST/PATCH/PUT with a JSON body. */
export function jsonRequest(method: string, path: string, payload: unknown, init: TestInit = {}): NextRequest {
  return new NextRequest(url(path), {
    method,
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(payload),
  });
}

export function post(path: string, payload: unknown = {}, init?: TestInit): NextRequest {
  return jsonRequest("POST", path, payload, init);
}

export function patch(path: string, payload: unknown = {}, init?: TestInit): NextRequest {
  return jsonRequest("PATCH", path, payload, init);
}

export function del(path: string, init: TestInit = {}): NextRequest {
  return new NextRequest(url(path), { method: "DELETE", headers: init.headers });
}

/** A body that is not JSON at all: every route that parses one must answer 400. */
export function rawPost(path: string, raw: string, init: TestInit = {}): NextRequest {
  return new NextRequest(url(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: raw,
  });
}

/** The `ctx` argument of a dynamic route: `{ params: Promise<...> }`. */
export function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

/** `{ status, body }` in one await, for the common assertion. */
export async function call<T = Record<string, unknown>>(res: Response | Promise<Response>): Promise<{ status: number; body: T; res: Response }> {
  const settled = await res;
  return { status: settled.status, body: await body<T>(settled.clone()), res: settled };
}

/** Every line of an NDJSON stream, parsed. */
export async function ndjson<T = Record<string, unknown>>(res: Response): Promise<T[]> {
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
