import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const stateDir = process.env.STATION_DATA_DIR ?? `${root}.station/hermes`;
export async function sandbox(body) {
  const response = await fetch(`${process.env.STATION_API_URL ?? 'http://127.0.0.1:5800'}/api/v1/stations/hermes-worker/execution/sandbox`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readFileSync(`${stateDir}/api-key`, 'utf8').trim()}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Station request failed (${response.status}): ${JSON.stringify(result)}`);
  return result.data;
}
export async function command(id, command, timeoutMs = 60000) {
  let run = await sandbox({ method: 'exec', id, command, timeoutMs });
  while (run.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 500));
    run = await sandbox({ method: 'command', id, runId: run.id });
  }
  return run;
}
