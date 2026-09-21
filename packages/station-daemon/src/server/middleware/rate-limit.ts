import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { isIP } from "node:net";

export interface RateLimitOptions {
  /** Exact ingress addresses trusted to append X-Forwarded-For; untrusted clients cannot override their socket IP. */
  trustedProxies?: readonly string[];
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

const normalizeIP = (value: string) => value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value.toLowerCase();
export function validateTrustedProxies(addresses: readonly string[] = []): ReadonlySet<string> {
  if (!Array.isArray(addresses) || addresses.length > 256 || addresses.some(value => typeof value !== "string" || !isIP(value))) throw new Error("trustedProxies must contain at most 256 exact ingress IP addresses.");
  return new Set(addresses.map(normalizeIP));
}
export function clientAddress(c: Context, trusted: ReadonlySet<string>): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming;
  const raw = incoming?.socket?.remoteAddress;
  if (!raw || !isIP(raw)) return "anonymous";
  const peer = normalizeIP(raw);
  if (!trusted.has(peer)) return peer;
  const forwarded = c.req.header("x-forwarded-for");
  if (!forwarded || forwarded.length > 2048) return peer;
  const chain = forwarded.split(",").map(value => value.trim());
  if (chain.length > 32 || chain.some(value => !isIP(value))) return peer;
  // Walk from the actual peer towards the client. Never accept an attacker-added
  // leftmost value past the first untrusted hop.
  for (const value of chain.reverse()) {
    const address = normalizeIP(value);
    if (!trusted.has(address)) return address;
  }
  return peer;
}

export function rateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 100;
  const trusted = validateTrustedProxies(options.trustedProxies);
  const keyFn = options.keyFn ?? ((c: Context) => {
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    return apiKeyId ? `key:${apiKeyId}` : `ip:${clientAddress(c, trusted)}`;
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
