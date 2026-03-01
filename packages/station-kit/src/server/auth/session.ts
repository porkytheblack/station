import crypto from "node:crypto";

const SESSION_TTL_MS = 86_400_000; // 24 hours

export interface SessionConfig {
  username: string;
  password: string;
  sessionTtlMs?: number;
}

/** HMAC-sign a token. The secret is derived from the password. */
function sign(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return hmac.digest("hex");
}

export function createSessionToken(config: SessionConfig): string {
  const exp = Date.now() + (config.sessionTtlMs ?? SESSION_TTL_MS);
  const payload = `${config.username}:${exp}`;
  const signature = sign(payload, config.password);
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
    const expected = sign(`${username}:${expStr}`, config.password);
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function verifyCredentials(username: string, password: string, config: SessionConfig): boolean {
  // Use timing-safe comparison to prevent timing attacks
  const userMatch = username.length === config.username.length &&
    crypto.timingSafeEqual(Buffer.from(username), Buffer.from(config.username));
  const passMatch = password.length === config.password.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(config.password));
  return userMatch && passMatch;
}
