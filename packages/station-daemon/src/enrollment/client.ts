import type { EnrollmentMember } from './authority.js';

export interface EnrollmentAdmissionOptions {
  url: string; networkId: string; stationId: string; credential: string; timeoutMs?: number; renewalGraceMs?: number; now?: () => number;
}
export type EnrollmentAdmissionStatus = { state: "admitted"; member: EnrollmentMember } | { state: "denied" | "unavailable" };
/** New claims always require fresh admission; existing ownership has bounded outage grace. */
export function createEnrollmentAdmission(options: EnrollmentAdmissionOptions) {
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Enrollment authority requires an HTTPS origin (loopback HTTP only for local development)');
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 4000 || !/^stw_[a-zA-Z0-9_-]{43}$/.test(options.credential)) throw new Error('Invalid enrollment admission options');
  const grace=options.renewalGraceMs??30_000,now=options.now??Date.now;
  if(!Number.isSafeInteger(grace)||grace<0||grace>120_000)throw new Error('Invalid enrollment renewal grace');
  let lastAdmitted:number|undefined;
  let pending:Promise<EnrollmentAdmissionStatus>|undefined;
  async function request(): Promise<EnrollmentAdmissionStatus> {
    try {
      const response = await fetch(new URL('/api/v1/network/admission', url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${options.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ stationId: options.stationId, networkId: options.networkId }),
      });
      if (!response.ok) { await response.body?.cancel(); return {state:response.status>=500||[408,429].includes(response.status)?"unavailable":"denied"}; }
      // Never consume an unbounded remote response, including chunked responses.
      const reader = response.body?.getReader(); if (!reader) return {state:"unavailable"};
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 8192) { await reader.cancel(); return {state:"denied"}; } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      const member = JSON.parse(Buffer.concat(chunks).toString()).data as EnrollmentMember;
      return member?.stationId === options.stationId && member?.networkId === options.networkId && typeof member.generation === 'string' && !member.revokedAt ? {state:'admitted',member} : {state:'denied'};
    } catch { return {state:"unavailable"}; }
  }
  async function probe():Promise<EnrollmentAdmissionStatus>{
    if(!pending)pending=request().then(result=>{if(result.state==='admitted')lastAdmitted=now();else if(result.state==='denied')lastAdmitted=undefined;return result;}).finally(()=>{pending=undefined});
    return pending;
  }
  return { probe, check:async()=>{const result=await probe();return result.state==='admitted'?result.member:null;},
    canClaim:async()=>(await probe()).state==='admitted',
    canRenew:async()=>{const result=await probe();return result.state==='admitted'||result.state==='unavailable'&&lastAdmitted!==undefined&&now()-lastAdmitted<=grace&&now()>=lastAdmitted;}
  };
}
