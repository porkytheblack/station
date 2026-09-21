import { constants } from "node:fs";
import { link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertDigest, canonicalJson, digestBytes, manifestDigest, MAX_BLOB_BYTES, MAX_MANIFEST_BYTES, NAME_PATTERN, validateManifest, validateArtifactBytes } from "./manifest.js";
import { fail, type Digest, type ImageManifest, type ImageRecord } from "./types.js";
export interface RegistryOptions { maxBlobBytes?: number; maxTotalBytes?: number }
/** An operator-owned directory for ONE tenant registry. Authorization belongs to the API boundary. */
export class FileImageRegistry {
  readonly root: string;
  readonly maxBlobBytes: number;
  readonly maxTotalBytes: number;
  constructor(root: string, options: RegistryOptions = {}) {
    this.root = resolve(root);
    this.maxBlobBytes = options.maxBlobBytes ?? MAX_BLOB_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes < 1 || this.maxBlobBytes > MAX_BLOB_BYTES || !Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < this.maxBlobBytes) fail("invalid_limits", "Invalid registry byte limits");
  }
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const directory of ["blobs", "manifests", "versions", "tags", "tmp"]) await mkdir(join(this.root, directory), { recursive: true, mode: 0o700 });
  }
  private path(directory: string, digest: Digest): string { assertDigest(digest); return join(this.root, directory, digest.slice(7)); }
  private async immutable(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = join(this.root, "tmp", randomUUID());
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readBounded(path, bytes.byteLength + 1);
      if (!existing.equals(Buffer.from(bytes))) fail("immutable_conflict", "An immutable registry record already exists with different content");
    } finally { await unlink(temporary).catch(() => {}); }
  }
  private async readBounded(path: string, limit: number): Promise<Buffer> {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("not_found", "Registry entry not found"); throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit) fail("corrupt_registry", "Registry entry is not a bounded regular file");
      const bytes = await handle.readFile();
      if (bytes.byteLength > limit) fail("corrupt_registry", "Registry entry exceeds bounds");
      return bytes;
    } finally { await handle.close(); }
  }
  /** Bytes are already bounded by API upload policy. This method never executes uploaded bytes. */
  async putBlob(bytes: Uint8Array, expectedDigest?: Digest): Promise<{ digest: Digest; size: number }> {
    if (bytes.byteLength < 1 || bytes.byteLength > this.maxBlobBytes) fail("blob_too_large", "Blob size is outside registry limits");
    const digest = digestBytes(bytes);
    if (expectedDigest !== undefined) { assertDigest(expectedDigest); if (digest !== expectedDigest) fail("digest_mismatch", "Blob digest mismatch"); }
    await this.initialize();
    // Serialize upload admission across controller instances. Released in finally on normal completion.
    // A crash can leave this lock: fail closed until an operator removes it, never guess ownership.
    let lock;
    try { lock = await open(join(this.root, "upload.lock"), "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("registry_busy", "Registry upload is busy; retry later (stale locks require operator recovery)"); throw error; }
    try {
      let used = 0;
      for (const file of await readdir(join(this.root, "blobs"))) {
        if (!/^[0-9a-f]{64}$/.test(file)) fail("corrupt_registry", "Unexpected registry blob entry");
        const fileHandle = await open(join(this.root, "blobs", file), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const stat = await fileHandle.stat(); if (!stat.isFile()) fail("corrupt_registry", "Invalid blob file"); used += stat.size; } finally { await fileHandle.close(); }
      }
      let exists = false;
      try { const old = await this.getBlob(digest); exists = true; if (!old.equals(Buffer.from(bytes))) fail("digest_mismatch", "Existing blob content mismatch"); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "not_found") throw error; }
      if (!exists && used + bytes.byteLength > this.maxTotalBytes) fail("registry_quota", "Registry blob quota exceeded");
      await this.immutable(this.path("blobs", digest), bytes);
      return { digest, size: bytes.byteLength };
    } finally { await lock.close(); await unlink(join(this.root, "upload.lock")); }
  }
  async getBlob(digest: Digest): Promise<Buffer> {
    const bytes = await this.readBounded(this.path("blobs", digest), this.maxBlobBytes);
    if (digestBytes(bytes) !== digest) fail("digest_mismatch", "Stored blob digest mismatch");
    return bytes;
  }
  async getManifest(digest: Digest): Promise<ImageRecord> {
    const bytes = await this.readBounded(this.path("manifests", digest), MAX_MANIFEST_BYTES);
    let manifest: unknown;
    try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("corrupt_registry", "Malformed stored manifest"); }
    validateManifest(manifest);
    if (manifestDigest(manifest) !== digest) fail("digest_mismatch", "Stored manifest digest mismatch");
    // Writing a content-addressed manifest precedes the immutable version commit.
    // A failed/conflicting publish must not become executable via its orphan digest.
    let committed: { name: string; version: string; digest: Digest };
    try { committed = JSON.parse((await this.readBounded(this.path("versions", digestBytes(`${manifest.name}@${manifest.version}`)), 4096)).toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) fail("corrupt_registry", "Malformed immutable version pointer"); throw error; }
    if (committed.name !== manifest.name || committed.version !== manifest.version || committed.digest !== digest) fail("not_found", "Image manifest has no matching committed version");
    return { digest, manifest };
  }
  /** Verify the dependency closure before committing an immutable version. */
  async publish(manifest: ImageManifest): Promise<ImageRecord> {
    validateManifest(manifest);
    const snapshot = JSON.parse(canonicalJson(manifest)) as ImageManifest;
    for (const artifact of snapshot.artifacts) validateArtifactBytes(artifact, await this.getBlob(artifact.digest));
    await this.validateDependencies(snapshot);
    const digest = manifestDigest(snapshot);
    await this.initialize();
    await this.immutable(this.path("manifests", digest), Buffer.from(canonicalJson(snapshot)));
    await this.immutable(this.path("versions", digestBytes(`${snapshot.name}@${snapshot.version}`)), Buffer.from(canonicalJson({ name: snapshot.name, version: snapshot.version, digest })));
    return { digest, manifest: snapshot };
  }
  async validateDependencies(manifest: ImageManifest): Promise<ImageRecord[]> {
    const seen = new Set<string>();
    const records: ImageRecord[] = [];
    const walk = async (current: ImageManifest): Promise<void> => {
      for (const dependency of Object.values(current.dependencies ?? {})) {
        const record = await this.resolve(dependency.image);
        const exp = record.manifest.exports.find(e => e.name === dependency.export);
        if (!exp || exp.kind !== dependency.kind) fail("invalid_dependency", "Dependency export missing or kind mismatch");
        if (!seen.has(record.digest)) {
          if (seen.size >= 128) fail("dependency_limit", "Dependency closure exceeds 128 images");
          seen.add(record.digest); records.push(record);
          await walk(record.manifest);
        }
      }
    };
    await walk(manifest);
    return records;
  }
  async resolve(reference: string): Promise<ImageRecord> {
    if (typeof reference !== "string" || reference.length > 400) fail("invalid_reference", "Invalid image reference");
    if (reference.startsWith("sha256:")) { assertDigest(reference); return this.getManifest(reference); }
    const separator = reference.lastIndexOf("@");
    if (separator < 1) fail("invalid_reference", "Use name@version, name@tag or name@sha256:digest");
    const name = reference.slice(0, separator), selector = reference.slice(separator + 1);
    if (!NAME_PATTERN.test(name) || !selector) fail("invalid_reference", "Invalid image reference");
    let record: ImageRecord;
    if (selector.startsWith("sha256:")) { assertDigest(selector); record = await this.getManifest(selector); }
    else {
      const key = digestBytes(reference);
      let bytes: Buffer;
      try { bytes = await this.readBounded(this.path("versions", key), 4096); }
      catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "not_found") throw error; bytes = await this.readBounded(this.path("tags", key), 4096); }
      let pointer: { name: string; version?: string; tag?: string; digest: Digest };
      try { pointer = JSON.parse(bytes.toString("utf8")); } catch { fail("corrupt_registry", "Invalid image pointer"); }
      if (pointer.name !== name || (pointer.version ?? pointer.tag) !== selector) fail("corrupt_registry", "Image pointer identity mismatch");
      record = await this.getManifest(pointer.digest);
    }
    if (record.manifest.name !== name) fail("invalid_reference", "Image name does not match digest");
    return record;
  }
  async setTag(name: string, tag: string, digest: Digest): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(tag)) fail("invalid_tag", "Tags start with a letter and contain at most 64 characters");
    const record = await this.getManifest(digest);
    if (record.manifest.name !== name) fail("invalid_reference", "Tag name does not match image");
    await this.initialize();
    const temporary = join(this.root, "tmp", randomUUID());
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(canonicalJson({ name, tag, digest })); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, this.path("tags", digestBytes(`${name}@${tag}`))); } finally { await unlink(temporary).catch(() => {}); }
  }
  async list(): Promise<ImageRecord[]> {
    await this.initialize();
    const files = await readdir(join(this.root, "versions"));
    if (files.length > 10000) fail("registry_limit", "Registry listing exceeds 10000 versions");
    const records: ImageRecord[] = [];
    for (const file of files) {
      if (!/^[0-9a-f]{64}$/.test(file)) fail("corrupt_registry", "Unexpected version entry");
      let pointer: { name: string; version: string; digest: Digest };
      try { pointer = JSON.parse((await this.readBounded(join(this.root, "versions", file), 4096)).toString("utf8")); } catch { fail("corrupt_registry", "Invalid version pointer"); }
      records.push(await this.resolve(`${pointer.name}@${pointer.version}`));
    }
    return records.sort((a, b) => `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`));
  }
}
