// Structured logs for server routes: one JSON line per event with a request
// id, so Vercel's log drain (or any collector) can filter and join them.
// Never log audio paths with user ids together with anything a third party
// could use; keep payloads to ids, kinds, durations and error messages.

import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  msg: string;
  request_id?: string;
  route?: string;
  user_id?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function log(event: LogEvent): void {
  if (ORDER[event.level] < ORDER[MIN_LEVEL]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), ...event });
  if (event.level === "error") console.error(line);
  else if (event.level === "warn") console.warn(line);
  else console.log(line);
}

export function requestId(req?: Request): string {
  return req?.headers.get("x-request-id") ?? randomUUID();
}

/** Time a handler and log one line with its outcome. */
export async function timed<T>(route: string, req: Request | undefined, fn: (id: string) => Promise<T>): Promise<T> {
  const id = requestId(req);
  const start = performance.now();
  try {
    const out = await fn(id);
    log({ level: "info", msg: "ok", route, request_id: id, duration_ms: Math.round(performance.now() - start) });
    return out;
  } catch (err) {
    log({ level: "error", msg: err instanceof Error ? err.message : String(err), route, request_id: id,
          duration_ms: Math.round(performance.now() - start) });
    throw err;
  }
}
