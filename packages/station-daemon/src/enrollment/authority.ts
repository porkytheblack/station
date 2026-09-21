import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class EnrollmentError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 409 | 413 | 503, message = code) { super(message); }
}
export interface EnrollmentMember { stationId: string; networkId: string; generation: string; joinedAt: string; revokedAt?: string }
interface Invitation { stationId: string; expiresAt: number; hash: string }
interface StoredMember extends EnrollmentMember { credentialHash?: string }
interface State { version: 1; networkId: string; invitations: Invitation[]; members: StoredMember[] }
export interface EnrollmentAuthorityOptions { path: string; networkId: string; now?: () => number }
const identity = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function publicMember({ credentialHash: _, ...member }: StoredMember): EnrollmentMember { return member; }

/** Single-authority durable file store. Atomic single-use redemption; shared HA storage needs an equivalent transactional implementation. */
export class EnrollmentAuthority {
  readonly networkId: string;
  private readonly path: string;
  private readonly now: () => number;
  constructor(options: EnrollmentAuthorityOptions) {
    if (!identity(options.networkId)) throw new EnrollmentError('invalid_network', 400);
    this.networkId = options.networkId; this.path = resolve(options.path); this.now = options.now ?? Date.now;
  }
  private async readState(): Promise<State> {
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024) throw new EnrollmentError('enrollment_store_limit', 503);
      const bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4 * 1024 * 1024) throw new EnrollmentError('enrollment_store_limit', 503);
      const state = JSON.parse(bytes.subarray(0, bytesRead).toString()) as State;
      if (state.version !== 1 || state.networkId !== this.networkId || !Array.isArray(state.invitations) || !Array.isArray(state.members)) throw new EnrollmentError('enrollment_store_invalid', 503);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { version: 1, networkId: this.networkId, invitations: [], members: [] };
    } finally { await file?.close(); }
  }
  private async transaction<T>(work: (state: State) => T, write = true): Promise<T> {
    // Atomic replacement means readers observe either complete snapshot without
    // contending with heartbeats/revocation. Never mutate a read-only snapshot.
    if (!write) return work(await this.readState());
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock;
    const deadline = Date.now() + 1000;
    for (;;) {
      try { lock = await open(`${this.path}.lock`, 'wx', 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new EnrollmentError('enrollment_busy', 503);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    let temporary: string | undefined;
    try {
      const state = await this.readState();
      const result = work(state);
      if (write) {
        const data = JSON.stringify(state);
        if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new EnrollmentError('enrollment_store_limit', 413);
        temporary = `${this.path}.${randomUUID()}.tmp`;
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.path); temporary = undefined;
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return result;
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await lock.close(); await unlink(`${this.path}.lock`);
    }
  }
  async issue(stationId: string, ttlMs = 300_000) {
    if (!identity(stationId) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 900_000) throw new EnrollmentError('invalid_invitation', 400);
    const token = `sti_${randomBytes(32).toString('base64url')}`, expiresAt = this.now() + ttlMs;
    await this.transaction(state => {
      state.invitations = state.invitations.filter(i => i.expiresAt > this.now() && i.stationId !== stationId);
      if (state.invitations.length >= 1000 || state.members.length >= 10_000 && !state.members.some(m => m.stationId === stationId)) throw new EnrollmentError('enrollment_store_limit', 413);
      state.invitations.push({ stationId, expiresAt, hash: hash(token) });
    });
    return { token, stationId, networkId: this.networkId, expiresAt: new Date(expiresAt).toISOString() };
  }
  async join(input: { token: string; stationId: string; networkId: string }) {
    if (!identity(input.stationId) || input.networkId !== this.networkId || typeof input.token !== 'string' || input.token.length > 256) throw new EnrollmentError('invalid_enrollment', 401);
    return this.transaction(state => {
      const invitation = state.invitations.find(i => i.hash === hash(input.token) && i.stationId === input.stationId && i.expiresAt > this.now());
      if (!invitation) throw new EnrollmentError('invalid_enrollment', 401);
      const credential = `stw_${randomBytes(32).toString('base64url')}`;
      const member: StoredMember = { stationId: input.stationId, networkId: this.networkId, generation: randomUUID(), joinedAt: new Date(this.now()).toISOString(), credentialHash: hash(credential) };
      state.invitations = state.invitations.filter(i => i.stationId !== input.stationId);
      state.members = [...state.members.filter(m => m.stationId !== input.stationId), member];
      return { ...publicMember(member), credential };
    });
  }
  private verify(state: State, stationId: string, networkId: string, credential: string) {
    if (networkId !== this.networkId || !identity(stationId) || typeof credential !== 'string' || credential.length > 256) throw new EnrollmentError('admission_denied', 401);
    const member = state.members.find(m => m.stationId === stationId && !m.revokedAt && m.credentialHash === hash(credential));
    if (!member) throw new EnrollmentError('admission_denied', 401);
    return member;
  }
  async admit(stationId: string, networkId: string, credential: string) {
    return this.transaction(state => publicMember(this.verify(state, stationId, networkId, credential)), false);
  }
  async leave(stationId: string, networkId: string, credential: string) {
    return this.transaction(state => { this.verify(state, stationId, networkId, credential); this.revokeState(state, stationId); });
  }
  private revokeState(state: State, stationId: string) {
    state.invitations = state.invitations.filter(i => i.stationId !== stationId);
    const member = state.members.find(m => m.stationId === stationId);
    if (member) { member.revokedAt = new Date(this.now()).toISOString(); delete member.credentialHash; }
  }
  async revoke(stationId: string) {
    if (!identity(stationId)) throw new EnrollmentError('invalid_station', 400);
    await this.transaction(state => this.revokeState(state, stationId));
  }
  async list(): Promise<EnrollmentMember[]> { return this.transaction(state => state.members.map(publicMember), false); }
}
