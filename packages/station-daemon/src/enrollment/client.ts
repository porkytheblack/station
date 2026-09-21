import type { EnrollmentMember } from './authority.js';

export interface EnrollmentAdmissionOptions {
  url: string; networkId: string; stationId: string; credential: string; timeoutMs?: number;
}
/** Fixed operator-owned authority; each check is fresh, bounded and fail-closed. */
export function createEnrollmentAdmission(options: EnrollmentAdmissionOptions) {
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Enrollment authority requires an HTTPS origin (loopback HTTP only for local development)');
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 || !/^stw_[a-zA-Z0-9_-]{43}$/.test(options.credential)) throw new Error('Invalid enrollment admission options');
  async function check(): Promise<EnrollmentMember | null> {
    try {
      const response = await fetch(new URL('/api/v1/network/admission', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${options.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ stationId: options.stationId, networkId: options.networkId }),
      });
      if (!response.ok) { await response.body?.cancel(); return null; }
      // Never consume an unbounded remote response, including chunked responses.
      const reader = response.body?.getReader(); if (!reader) return null;
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 8192) { await reader.cancel(); return null; } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      const member = JSON.parse(Buffer.concat(chunks).toString()).data as EnrollmentMember;
      return member?.stationId === options.stationId && member?.networkId === options.networkId && typeof member.generation === 'string' && !member.revokedAt ? member : null;
    } catch { return null; }
  }
  return { check, canClaim: async () => Boolean(await check()) };
}
