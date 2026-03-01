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

export function rateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 100;
  const keyFn = options.keyFn ?? ((c: Context) => {
    return (c.get("apiKeyId") as string) ?? c.req.header("x-forwarded-for") ?? "anonymous";
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
