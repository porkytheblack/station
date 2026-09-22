import { constants } from "node:fs";
import { link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertDigest } from "./manifest.js";
import { fail, type Digest } from "./types.js";
import type { RegistryBlobAdapter, RegistryCollection, RegistryMetadataAdapter } from "./storage.js";

async function readBounded(path: string, limit: number): Promise<Uint8Array | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail("corrupt_registry", "Registry entry is not a bounded regular file");
    // Allocate only the permitted size, even if the file changes after stat().
    const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > stat.size || size > limit) fail("corrupt_registry", "Registry entry changed or exceeds bounds");
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}
class FileStorage {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  protected path(collection: RegistryCollection | "blobs", key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail("invalid_digest", "Invalid registry storage key");
    return join(this.root, collection, key);
  }
  protected async initialize(collection: RegistryCollection | "blobs") {
    await mkdir(join(this.root, collection), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, "tmp"), { recursive: true, mode: 0o700 });
  }
  protected async write(collection: RegistryCollection | "blobs", key: string, bytes: Uint8Array, replace = false): Promise<boolean> {
    const destination = this.path(collection, key);
    await this.initialize(collection);
    const temporary = join(this.root, "tmp", randomUUID());
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      try { if (replace) await rename(temporary, destination); else await link(temporary, destination); }
      catch (error) { if (!replace && (error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      return true;
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
/** Retains the existing FileImageRegistry metadata layout. */
export class FileRegistryMetadataAdapter extends FileStorage implements RegistryMetadataAdapter {
  async read(collection: RegistryCollection, key: string, maxBytes: number) { return readBounded(this.path(collection, key), maxBytes); }
  async create(collection: "manifests" | "versions", key: string, bytes: Uint8Array) { return this.write(collection, key, bytes); }
  async writeTag(key: string, bytes: Uint8Array) { await this.write("tags", key, bytes, true); }
  async listVersions(limit: number) {
    await this.initialize("versions");
    const keys = await readdir(join(this.root, "versions"));
    if (keys.length > limit) fail("registry_limit", "Registry listing exceeds its limit");
    return keys;
  }
}
/** One directory per registry namespace; quota admission is serialized across local processes. */
export class FileRegistryBlobAdapter extends FileStorage implements RegistryBlobAdapter {
  async read(digest: Digest, maxBytes: number) { assertDigest(digest); return readBounded(this.path("blobs", digest.slice(7)), maxBytes); }
  async create(digest: Digest, bytes: Uint8Array, maxTotalBytes: number) {
    assertDigest(digest);
    await this.initialize("blobs");
    let lock;
    try { lock = await open(join(this.root, "upload.lock"), "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("registry_busy", "Registry upload is busy; retry later (stale locks require operator recovery)"); throw error; }
    try {
      // An existing key must not bypass the service's content validation.
      if (await this.read(digest, bytes.byteLength)) return false;
      let used = 0;
      for (const key of await readdir(join(this.root, "blobs"))) {
        const handle = await open(this.path("blobs", key), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const stat = await handle.stat(); if (!stat.isFile()) fail("corrupt_registry", "Invalid blob file"); used += stat.size; } finally { await handle.close(); }
      }
      if (used + bytes.byteLength > maxTotalBytes) fail("registry_quota", "Registry blob quota exceeded");
      return await this.write("blobs", digest.slice(7), bytes);
    } finally { await lock.close(); await unlink(join(this.root, "upload.lock")); }
  }
}
