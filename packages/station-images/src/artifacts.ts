import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fail, ImageError, PROCESS_PROTOCOL, type Digest } from './types.js';
import { assertDigest } from './manifest.js';
import { isRecord } from './schema.js';

export interface ArtifactPermissions { read?: boolean; write?: boolean }
export interface InvocationArtifactReference { reference: string; size: number; digest: Digest; expiresAt: string }
interface StoredArtifact extends InvocationArtifactReference { invocationId: string }
export interface ArtifactScopeOptions {
  invocationId: string;
  permissions: ArtifactPermissions;
  /** References explicitly authorized by the supervisor, NEVER copied automatically from untrusted input. */
  readReferences?: readonly string[];
  maxBytes?: number; maxArtifacts?: number; maxChunkBytes?: number; ttlMs?: number;
}
export interface InvocationArtifactScope {
  readonly permissions: Readonly<ArtifactPermissions>;
  readonly references: readonly InvocationArtifactReference[];
  readonly maxChunkBytes: number;
  handle(frame: unknown): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
const REF = /^station-artifact:([a-f0-9]{64})$/;
function id(reference: string): string { const match = typeof reference === 'string' && REF.exec(reference); if (!match) fail('artifact_denied', 'Invalid artifact reference'); return match[1]; }
function integer(v: unknown, max: number, min = 0): v is number { return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max; }
async function hashFile(path: string): Promise<Digest> {
  const hash = createHash('sha256'), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const part of file.createReadStream({ autoClose: false })) hash.update(part); }
  finally { await file.close(); }
  return `sha256:${hash.digest('hex')}`;
}

/** Private local artifact store. Keep this root on quota-controlled operator storage, separate per tenant. */
export class FileInvocationArtifactStore {
  readonly rootDir: string;
  private readonly maxStorageBytes: number;
  private readonly maxStoredArtifacts: number;
  constructor(options: { rootDir: string; maxStorageBytes?: number; maxStoredArtifacts?: number }) {
    this.rootDir = resolve(options.rootDir);
    this.maxStorageBytes = options.maxStorageBytes ?? 1024 ** 3;
    this.maxStoredArtifacts = options.maxStoredArtifacts ?? 1024;
    if (!integer(this.maxStorageBytes, 8 * 1024 ** 3, 1) || !integer(this.maxStoredArtifacts, 4096, 1)) fail('invalid_limits', 'Invalid artifact store quotas');
  }
  private async mutateStore<T>(operation: (entries: Record<string, { size: number; expiresAt: string }>) => Promise<T>): Promise<T> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const lockPath = join(this.rootDir, 'store.lock'); let lock;
    const deadline = Date.now() + 2000;
    for (;;) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (Date.now() >= deadline) fail('artifact_store_busy', 'Artifact store lock unavailable'); await new Promise(r => setTimeout(r, 10)); }
    }
    const indexPath = join(this.rootDir, 'store.json'), temporary = join(this.rootDir, `store-${randomBytes(16).toString('hex')}.tmp`);
    try {
      let entries: Record<string, { size: number; expiresAt: string }> = {};
      let file;
      try {
        file = await open(indexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const meta = await file.stat(); if (!meta.isFile() || meta.size > 2 * 1024 * 1024) fail('artifact_store_invalid', 'Invalid artifact quota index');
        entries = JSON.parse(await file.readFile('utf8'));
        if (!isRecord(entries) || Object.entries(entries).some(([reference, e]) => !REF.test(reference) || !isRecord(e) || !integer(e.size, 1024 ** 3) || typeof e.expiresAt !== 'string' || !Number.isFinite(Date.parse(e.expiresAt)))) fail('artifact_store_invalid', 'Invalid artifact quota reservation');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      finally { await file?.close(); }
      const result = await operation(entries);
      const output = await open(temporary, 'wx', 0o600);
      try { await output.writeFile(JSON.stringify(entries)); await output.sync(); } finally { await output.close(); }
      await rename(temporary, indexPath);
      const directory = await open(this.rootDir, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally { await rm(temporary, { force: true }); await lock.close(); await rm(lockPath); }
  }
  private async reserve(reference: string, size: number, expiresAt: string): Promise<void> {
    await this.mutateStore(async entries => {
      for (const [ref, entry] of Object.entries(entries)) if (Date.parse(entry.expiresAt) <= Date.now()) { await rm(this.location(ref), { recursive: true, force: true }); delete entries[ref]; }
      if (Object.keys(entries).length >= this.maxStoredArtifacts || Object.values(entries).reduce((n, e) => n + e.size, 0) + size > this.maxStorageBytes) fail('artifact_store_limit', 'Artifact store quota exceeded');
      entries[reference] = { size, expiresAt };
    });
  }
  private async discard(reference: string): Promise<void> {
    await this.mutateStore(async entries => { await rm(this.location(reference), { recursive: true, force: true }); delete entries[reference]; });
  }
  /** Operator cleanup of expired committed files and abandoned reservations, including after process death. */
  async reapExpired(): Promise<number> {
    return this.mutateStore(async entries => { let removed = 0; for (const [ref, entry] of Object.entries(entries)) if (Date.parse(entry.expiresAt) <= Date.now()) { await rm(this.location(ref), { recursive: true, force: true }); delete entries[ref]; removed++; } return removed; });
  }
  private location(reference: string): string { return join(this.rootDir, id(reference)); }
  async describe(reference: string): Promise<InvocationArtifactReference> {
    const directory = this.location(reference);
    try {
      const file = await open(join(directory, 'record.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let record: StoredArtifact;
      try { const meta = await file.stat(); if (!meta.isFile() || meta.size > 4096) fail('artifact_denied', 'Invalid artifact metadata'); record = JSON.parse(await file.readFile('utf8')); }
      finally { await file.close(); }
      if (record.reference !== reference || !integer(record.size, 1024 ** 3) || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()) fail('artifact_denied', 'Artifact is missing or expired');
      assertDigest(record.digest);
      return { reference: record.reference, size: record.size, digest: record.digest, expiresAt: record.expiresAt };
    } catch (error) { if (error instanceof ImageError) throw error; fail('artifact_denied', 'Artifact is missing or unavailable'); }
  }
  /** Operator-only provisioning of a per-attempt capability scope. */
  async scope(options: ArtifactScopeOptions): Promise<InvocationArtifactScope> {
    if (typeof options.invocationId !== 'string' || !options.invocationId || options.invocationId.length > 256) fail('invalid_invocation', 'Artifact invocation identity required');
    if (Object.keys(options.permissions).some(k => !['read', 'write'].includes(k)) || Object.values(options.permissions).some(v => typeof v !== 'boolean')) fail('artifact_denied', 'Invalid artifact grants');
    const permissions = Object.freeze({ ...options.permissions }), invocationId = options.invocationId;
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024, maxArtifacts = options.maxArtifacts ?? 16, maxChunkBytes = options.maxChunkBytes ?? 64 * 1024, ttlMs = options.ttlMs ?? 3600000;
    if (!integer(maxBytes, 1024 ** 3, 1) || !integer(maxArtifacts, 128, 1) || !integer(maxChunkBytes, 256 * 1024, 1) || !integer(ttlMs, 86400000, 1000)) fail('invalid_limits', 'Invalid artifact scope limits');
    const permitted = [...new Set(options.readReferences ?? [])];
    if (permitted.length > maxArtifacts || permitted.length && !permissions.read) fail('artifact_denied', 'Read references exceed scope grant');
    const references = await Promise.all(permitted.map(async r => {
      const record = await this.describe(r);
      if (await hashFile(join(this.location(r), 'data')) !== record.digest) fail('artifact_corrupt', 'Granted artifact digest changed');
      return record;
    }));
    if (references.reduce((n, r) => n + r.size, 0) > maxBytes) fail('artifact_limit', 'Granted inputs exceed invocation byte budget');
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const allowed = new Map(references.map(r => [r.reference, r]));
    const uploads = new Map<string, { directory: string; size: number; digest: Digest; offset: number; expiresAt: string }>();
    const requestIds = new Set<string>(); let closed = false, busy = false, readBytes = 0, reservedBytes = 0, created = 0;
    let active: Promise<Record<string, unknown>> | undefined;
    const operate = async (frame: unknown): Promise<Record<string, unknown>> => {
      if (closed) fail('artifact_closed', 'Invocation artifact scope is closed');
      if (!isRecord(frame) || frame.protocol !== PROCESS_PROTOCOL || frame.type !== 'artifact:request' || typeof frame.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(frame.id)) fail('invalid_protocol', 'Malformed artifact request');
      if (requestIds.has(frame.id) || requestIds.size >= 32768) fail('artifact_request_limit', 'Artifact request identity reused or request budget exceeded');
      requestIds.add(frame.id);
      const keys = frame.operation === 'create' ? ['size', 'digest'] : frame.operation === 'read' ? ['reference', 'offset', 'length'] : frame.operation === 'append' ? ['reference', 'offset', 'data'] : frame.operation === 'commit' ? ['reference'] : [];
      if (!keys.length || Object.keys(frame).some(k => !['protocol', 'type', 'id', 'operation', ...keys].includes(k))) fail('invalid_protocol', 'Unknown artifact operation or field');
      const respond = (result: unknown) => ({ protocol: PROCESS_PROTOCOL, type: 'artifact:response', id: frame.id, result });
      if (frame.operation === 'read') {
        if (!permissions.read || typeof frame.reference !== 'string' || !allowed.has(frame.reference)) fail('artifact_denied', 'Reference is outside this invocation');
        const record = await this.describe(frame.reference);
        if (!integer(frame.offset, record.size) || !integer(frame.length, maxChunkBytes, 1) || readBytes + frame.length > maxBytes) fail('artifact_limit', 'Invalid or excessive artifact read');
        const bytes = Buffer.alloc(Math.min(frame.length, record.size - frame.offset));
        const file = await open(join(this.location(frame.reference), 'data'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size !== record.size) fail('artifact_corrupt', 'Artifact size changed'); const result = await file.read(bytes, 0, bytes.length, frame.offset); if (result.bytesRead !== bytes.length) fail('artifact_corrupt', 'Artifact truncated'); }
        finally { await file.close(); }
        readBytes += bytes.length;
        return respond({ data: bytes.toString('base64'), offset: frame.offset + bytes.length, eof: frame.offset + bytes.length === record.size });
      }
      if (!permissions.write) fail('artifact_denied', 'Artifact writes are not granted');
      if (frame.operation === 'create') {
        if (!integer(frame.size, maxBytes) || reservedBytes + frame.size > maxBytes || created >= maxArtifacts) fail('artifact_limit', 'Artifact output budget exceeded');
        assertDigest(frame.digest);
        const reference = `station-artifact:${randomBytes(32).toString('hex')}`, directory = this.location(reference), expiresAt = new Date(Date.now() + ttlMs).toISOString();
        await this.reserve(reference, frame.size, expiresAt);
        try { await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, 'pending'), '', { flag: 'wx', mode: 0o600 }); }
        catch (error) { await this.discard(reference); throw error; }
        uploads.set(reference, { directory, size: frame.size, digest: frame.digest, offset: 0, expiresAt }); reservedBytes += frame.size; created++;
        return respond({ reference, offset: 0, maxChunkBytes });
      }
      if (typeof frame.reference !== 'string' || !uploads.has(frame.reference)) fail('artifact_denied', 'Upload is outside this invocation');
      const upload = uploads.get(frame.reference)!;
      if (Date.parse(upload.expiresAt) <= Date.now()) fail('artifact_denied', 'Artifact upload expired');
      if (frame.operation === 'append') {
        if (frame.offset !== upload.offset || typeof frame.data !== 'string' || frame.data.length > Math.ceil(maxChunkBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) fail('artifact_chunk', 'Invalid artifact chunk or offset');
        const bytes = Buffer.from(frame.data, 'base64');
        if (!bytes.length || bytes.length > maxChunkBytes || upload.offset + bytes.length > upload.size || bytes.toString('base64') !== frame.data) fail('artifact_limit', 'Artifact chunk exceeds declared size');
        const file = await open(join(upload.directory, 'pending'), constants.O_WRONLY | constants.O_NOFOLLOW);
        try { const metadata = await file.stat(); if (!metadata.isFile() || metadata.size !== upload.offset) fail('artifact_corrupt', 'Staged artifact changed'); let written = 0; while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, upload.offset + written); if (!result.bytesWritten) fail("artifact_io", "Artifact write made no progress"); written += result.bytesWritten; } await file.sync(); }
        finally { await file.close(); }
        upload.offset += bytes.length;
        return respond({ reference: frame.reference, offset: upload.offset });
      }
      if (upload.offset !== upload.size || await hashFile(join(upload.directory, 'pending')) !== upload.digest) fail('artifact_digest', 'Artifact is incomplete or digest mismatched');
      const record: StoredArtifact = { reference: frame.reference, invocationId, size: upload.size, digest: upload.digest, expiresAt: upload.expiresAt };
      await rename(join(upload.directory, 'pending'), join(upload.directory, 'data'));
      const metadata = await open(join(upload.directory, 'record.json'), 'wx', 0o600);
      try { await metadata.writeFile(JSON.stringify(record)); await metadata.sync(); } finally { await metadata.close(); }
      const directory = await open(upload.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
      uploads.delete(frame.reference); const publicRecord = await this.describe(frame.reference); allowed.set(frame.reference, publicRecord);
      return respond(publicRecord);
    };
    return {
      permissions, references: Object.freeze(references), maxChunkBytes,
      handle: async frame => {
        if (busy || closed) fail('artifact_busy', 'Artifact scope is busy or closed');
        busy = true; active = operate(frame);
        try { return await active; } finally { busy = false; active = undefined; }
      },
      close: async () => {
        closed = true; await active?.catch(() => {});
        for (const reference of uploads.keys()) await this.discard(reference); uploads.clear();
      },
    };
  }
}
