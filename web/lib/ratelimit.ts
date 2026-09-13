// A token bucket per key, in memory. Serverless instances each keep their
// own bucket, so this bounds bursts per instance; the durable quotas live in
// lib/billing. Good enough for the public takedown form and the auth routes.

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, opts: { capacity: number; refillPerSec: number; now?: number }): boolean {
  const now = opts.now ?? Date.now();
  const b = buckets.get(key) ?? { tokens: opts.capacity, updated: now };
  const elapsed = Math.max(0, now - b.updated) / 1000;
  b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSec);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 10_000) buckets.clear();
  return true;
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : req.headers.get("x-real-ip")) ?? "unknown";
}

export function resetRateLimits(): void {
  buckets.clear();
}
