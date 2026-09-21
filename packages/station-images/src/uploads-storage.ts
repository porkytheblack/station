import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fail } from "./types.js";
import { assertUploadId, type ImageUploadRecord, type ImageUploadStorage, type ImageUploadTransaction } from "./uploads.js";
const MAX_RECORD = 1024 * 1024;
const copy = <T>(value: T): T => structuredClone(value);
/** Useful for tests or deliberately ephemeral staging; no crash durability. */
export class MemoryImageUploadStorage implements ImageUploadStorage {
  private records = new Map<string, ImageUploadRecord>();
  private chunks = new Map<string, Uint8Array>();
  private tail: Promise<unknown> = Promise.resolve();
  transaction<T>(operation: (tx: ImageUploadTransaction) => Promise<T>): Promise<T> {
    const work = this.tail.then(() => operation({
      list: async limit => { if (this.records.size > limit) fail("upload_quota", "Too many staged uploads"); return Array.from(this.records.values(), copy); },
      read: async id => copy(this.records.get(id) ?? null),
      write: async record => { this.records.set(record.id, copy(record)); },
      readChunk: async (id, offset, limit) => { const bytes = this.chunks.get(`${id}/${offset}`); if (bytes && bytes.length > limit) fail("corrupt_upload", "Oversized upload chunk"); return bytes ? Uint8Array.from(bytes) : null; },
      putChunk: async (id, offset, bytes) => { const key = `${id}/${offset}`, old = this.chunks.get(key); if (old && !Buffer.from(old).equals(bytes)) fail("upload_conflict", "Conflicting staged chunk"); this.chunks.set(key, Uint8Array.from(bytes)); },
      remove: async id => { for (const key of this.chunks.keys()) if (key.startsWith(`${id}/`)) this.chunks.delete(key); this.records.delete(id); },
    }));
    this.tail = work.catch(() => {}); return work;
  }
}
async function readBounded(path: string, limit: number): Promise<Buffer | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) fail("corrupt_upload", "Invalid staged file or size");
    const bytes = Buffer.alloc(info.size + 1); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== info.size) fail("corrupt_upload", "Staged file changed while reading");
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}
/** Single-host, cross-process durable staging. Stale locks deliberately require operator recovery. */
export class FileImageUploadStorage implements ImageUploadStorage {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private async directory(id: string, create = false) {
    assertUploadId(id); const path = join(this.root, id);
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) fail("corrupt_upload", "Invalid upload directory");
    return path;
  }
  private async syncDirectory(path: string) { const handle = await open(path, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
  private async atomicWrite(path: string, bytes: Uint8Array) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async transaction<T>(operation: (tx: ImageUploadTransaction) => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, "staging.lock"); let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    if (!lock) fail("registry_busy", "Upload staging is busy; stale locks require operator recovery");
    const read = async (id: string): Promise<ImageUploadRecord | null> => { const path = await this.directory(id); const bytes = await readBounded(join(path, "record.json"), MAX_RECORD); if (!bytes) return null; const record = JSON.parse(bytes.toString("utf8")); if (record?.id !== id) fail("corrupt_upload", "Stored upload identifier mismatch"); return record; };
    try {
      return await operation({
        read,
        list: async limit => {
          const records: ImageUploadRecord[] = [];
          for (const name of await readdir(this.root)) {
            if (name === "staging.lock") continue;
            assertUploadId(name);
            if (records.length >= limit) fail("upload_quota", "Too many upload records");
            const record = await read(name);
            if (!record) fail("corrupt_upload", "Upload directory lacks its reservation metadata");
            records.push(record);
          }
          return records;
        },
        write: async record => {
          const path = await this.directory(record.id, true); const bytes = Buffer.from(JSON.stringify(record));
          if (bytes.length > MAX_RECORD) fail("corrupt_upload", "Upload metadata exceeds limit");
          await this.atomicWrite(join(path, "record.json"), bytes); await this.syncDirectory(path); await this.syncDirectory(this.root);
        },
        readChunk: async (id, offset, limit) => { if (!Number.isSafeInteger(offset) || offset < 0) fail("invalid_offset", "Invalid chunk key"); return readBounded(join(await this.directory(id), `chunk-${offset}`), limit); },
        putChunk: async (id, offset, bytes) => {
          if (!Number.isSafeInteger(offset) || offset < 0) fail("invalid_offset", "Invalid chunk key");
          const directory = await this.directory(id); const path = join(directory, `chunk-${offset}`);
          const old = await readBounded(path, bytes.byteLength);
          if (old) { if (!old.equals(bytes)) fail("upload_conflict", "Conflicting staged chunk"); return; }
          await this.atomicWrite(path, bytes); await this.syncDirectory(directory);
        },
        remove: async id => {
          const directory = await this.directory(id);
          let files: string[]; try { files = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
          // Keep the byte reservation visible until all payload files have gone.
          for (const file of files) if (file !== "record.json") { const path = join(directory, file); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) fail("corrupt_upload", "Invalid upload staging file"); await unlink(path); }
          await this.syncDirectory(directory); await unlink(join(directory, "record.json")).catch(error => { if (error.code !== "ENOENT") throw error; });
          await rmdir(directory); await this.syncDirectory(this.root);
        },
      });
    } finally { await lock.close(); await unlink(lockPath); }
  }
}
