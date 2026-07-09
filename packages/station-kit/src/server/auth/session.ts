import crypto from "node:crypto";

const SESSION_TTL_MS = 86_400_000; // 24 hours

export interface SessionConfig {
  username: string;
  password: string;
  sessionTtlMs?: number;
}

/**
 * Derive the HMAC signing key from the password via HKDF instead of using
 * the cleartext password as the key directly — issued cookies should not be
 * HMACs keyed with the literal admin credential. Cached because HKDF per
 * request would be wasted CPU.
 */
const secretCache = new Map<string, Buffer>();
function sessionSecret(config: SessionConfig): Buffer {
  let secret = secretCache.get(config.password);
  if (!secret) {
    secret = Buffer.from(
      crypto.hkdfSync("sha256", config.password, "station-kit", "session-token-v1", 32),
    );
    secretCache.set(config.password, secret);
  }
  return secret;
}

function sign(payload: string, config: SessionConfig): string {
  const hmac = crypto.createHmac("sha256", sessionSecret(config));
  hmac.update(payload);
  return hmac.digest("hex");
}

/**
 * Timing-safe string comparison that doesn't leak length: both inputs are
 * hashed to a fixed size before `timingSafeEqual` (which requires equal
 * lengths and would otherwise short-circuit on a length check).
 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createSessionToken(config: SessionConfig): string {
  const exp = Date.now() + (config.sessionTtlMs ?? SESSION_TTL_MS);
  const payload = `${config.username}:${exp}`;
  const signature = sign(payload, config);
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

export function verifySessionToken(token: string, config: SessionConfig): boolean {
  try {
    const decoded = Buffer.from(token, "base64url").toString();
    const parts = decoded.split(":");
    if (parts.length !== 3) return false;
    const [username, expStr, sig] = parts;
    const exp = parseInt(expStr, 10);
    if (isNaN(exp) || Date.now() > exp) return false;
    if (username !== config.username) return false;
    const expected = sign(`${username}:${expStr}`, config);
    return safeEqual(sig, expected);
  } catch {
    return false;
  }
}

export function verifyCredentials(username: string, password: string, config: SessionConfig): boolean {
  // Evaluate both comparisons unconditionally so a valid username isn't
  // distinguishable from an invalid one by response time.
  const userMatch = safeEqual(username, config.username);
  const passMatch = safeEqual(password, config.password);
  return userMatch && passMatch;
}
