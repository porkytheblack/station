import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

interface RateLimitOptions {
  /** Time window in ms. Default: 60_000 (1 minute). */
  windowMs?: number;
  /** Max requests per window. Default: 100. */
  max?: number;
  /** Function to derive the rate limit key from request. Default: API key ID or IP. */
  keyFn?: (c: Context) => string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

/** Upper bound on tracked buckets so unique keys can't grow the map unbounded. */
const MAX_BUCKETS = 10_000;

export function rateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 100;
  const keyFn = options.keyFn ?? ((c: Context) => {
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    if (apiKeyId) return apiKeyId;
    // Key on the socket's address, NOT x-forwarded-for: that header is
    // client-controlled, so keying on it lets an attacker mint a fresh
    // bucket per request and bypass the limit entirely.
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming;
    return incoming?.socket?.remoteAddress ?? "anonymous";
  });

  const buckets = new Map<string, BucketEntry>();

  // Cleanup old entries periodically
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now > entry.resetAt) buckets.delete(key);
    }
  }, windowMs * 2);
  cleanup.unref();

  return createMiddleware(async (c, next) => {
    const key = keyFn(c);
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry || now > entry.resetAt) {
      if (!entry && buckets.size >= MAX_BUCKETS) {
        // Evict expired entries first; if everything is live, drop the oldest.
        for (const [k, e] of buckets) {
          if (now > e.resetAt) buckets.delete(k);
        }
        if (buckets.size >= MAX_BUCKETS) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count++;

    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      return c.json(
        { error: "rate_limited", message: "Too many requests. Try again later." },
        429,
      );
    }

    return next();
  });
}
