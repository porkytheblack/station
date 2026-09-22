import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writePrivate } from './store.js';
const exec = promisify(execFile);
interface Owner { version: 1; pid: number; birth: string; token: string }
export const ownerTitle = (token: string) => `station-owned-${token}`;
async function birth(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
      if (!start || !/^\d+$/.test(start) || !boot.trim()) throw new Error('Invalid process identity');
      return `${boot.trim()}:${start}`;
    } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
  }
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { maxBuffer: 8192, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })).stdout.trim() || undefined; }
  catch (error) { if ((error as { code?: number; stdout?: string }).code === 1 && !(error as { stdout?: string }).stdout?.trim()) return undefined; throw error; }
}
async function markedProcessExists(token: string): Promise<boolean> {
  if (process.platform === 'linux') {
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try { if ((await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes(ownerTitle(token))) return true; }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    return false;
  }
  return (await exec('/bin/ps', ['-ax', '-o', 'command='], { maxBuffer: 16 * 1024 * 1024 })).stdout.includes(ownerTitle(token));
}
function blocked(lock: string, reason: string) {
  return new Error(`${reason} Lock: ${lock}. Inspect instance status and output.log. No PID was signalled. If owner metadata is unavailable, verify all related launchers, controllers and services have exited before manually moving this lock aside.`);
}
/** A stale lock is retired once per nonce. Keeping its nonempty tombstone prevents
 * concurrent recoverers from accidentally moving a newly acquired lock. */
export async function acquireLaunchLock(lock: string): Promise<string> {
  let identity: string | undefined;
  try { identity = await birth(process.pid); } catch { throw blocked(lock, 'Cannot inspect launcher process identity.'); }
  const owner: Owner = { version: 1, pid: process.pid, birth: identity ?? '', token: randomBytes(24).toString('hex') };
  if (!owner.birth) throw blocked(lock, 'Cannot verify the launcher process identity.');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writePrivate(join(lock, 'owner.json'), owner);
      return owner.token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let previous: Owner;
    try {
      previous = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (previous.version !== 1 || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.birth !== 'string' || !previous.birth || !/^[a-f0-9]{48}$/.test(previous.token)) throw new Error();
    } catch { throw blocked(lock, 'Lock has missing or unrecognized ownership metadata; automatic recovery is unsafe.'); }
    try {
      if (await birth(previous.pid) === previous.birth) throw blocked(lock, 'A live launcher owns this lock.');
      // Covers the handoff interval as well as a live orphan after supervisor SIGKILL.
      // The nonce is not an authentication credential. Never print process listings.
      if (await markedProcessExists(previous.token)) throw blocked(lock, 'A controller or service still owns this lock.');
    } catch (error) {
      if (error instanceof Error && error.message.includes(`Lock: ${lock}.`)) throw error;
      throw blocked(lock, 'Cannot verify that the previous owner has exited.');
    }
    try { await rename(lock, `${lock}.retired-${previous.token}`); }
    catch (error) {
      // Another recovery won. Its retained, nonempty directory prevents replacing it.
      if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw blocked(lock, 'Another launcher acquired this instance while its stale lock was being recovered.');
}
/** The controller becomes the owner once it is alive; its process marker fences the handoff. */
export async function adoptLaunchLock(lock: string, token: string): Promise<void> {
  const previous = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as Owner;
  if (previous.token !== token) throw blocked(lock, 'Launch ownership changed before controller startup.');
  const identity = await birth(process.pid);
  if (!identity) throw blocked(lock, 'Cannot verify controller process identity.');
  await writePrivate(join(lock, 'owner.json'), { version: 1, pid: process.pid, birth: identity, token });
}
