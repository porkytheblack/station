import { resolve } from "node:path";
import { assertDigest, canonicalJson, digestBytes, manifestDigest, MAX_BLOB_BYTES, MAX_MANIFEST_BYTES, NAME_PATTERN, validateManifest, validateArtifactBytes } from "./manifest.js";
import { fail, type Digest, type ImageManifest, type ImageRecord } from "./types.js";
import type { RegistryCollection, RegistryStorage } from "./storage.js";
import { FileRegistryBlobAdapter, FileRegistryMetadataAdapter } from "./storage-file.js";
export interface RegistryOptions { maxBlobBytes?: number; maxTotalBytes?: number }
export interface ImageRegistryOptions extends RegistryOptions { storage: RegistryStorage }
/** Shared registry policy. Storage adapters never decide image validity or execute artifacts. */
export class ImageRegistry {
  readonly identity: string;
  readonly maxBlobBytes: number;
  readonly maxTotalBytes: number;
  private readonly storage: RegistryStorage;
  constructor(options: ImageRegistryOptions) {
    this.storage = { ...options.storage };
    this.identity = options.storage.id;
    if (typeof this.identity !== "string" || !this.identity.length || this.identity.length > 1024 || /[\r\n\0]/.test(this.identity)) fail("invalid_storage", "Registry storage requires a stable non-secret namespace identity");
    this.maxBlobBytes = options.maxBlobBytes ?? MAX_BLOB_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBlobBytes) || this.maxBlobBytes < 1 || this.maxBlobBytes > MAX_BLOB_BYTES || !Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < this.maxBlobBytes) fail("invalid_limits", "Invalid registry byte limits");
  }
  private async readMetadata(collection: RegistryCollection, key: string, limit: number): Promise<Buffer> {
    const bytes = await this.storage.metadata.read(collection, key, limit);
    if (bytes === null) fail("not_found", "Registry entry not found");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > limit) fail("corrupt_registry", "Registry adapter returned an invalid or oversized record");
    return Buffer.from(bytes);
  }
  private async immutable(collection: "manifests" | "versions", key: string, bytes: Buffer) {
    if (!await this.storage.metadata.create(collection, key, bytes)) {
      const existing = await this.readMetadata(collection, key, bytes.byteLength + 1);
      if (!existing.equals(bytes)) fail("immutable_conflict", "An immutable registry record already exists with different content");
    }
  }
  async putBlob(bytes: Uint8Array, expectedDigest?: Digest): Promise<{ digest: Digest; size: number }> {
    // Own the bytes across awaits so callers cannot change what gets stored after hashing.
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > this.maxBlobBytes) fail("blob_too_large", "Blob size is outside registry limits");
    const snapshot = Buffer.from(bytes);
    const digest = digestBytes(snapshot);
    if (expectedDigest !== undefined) { assertDigest(expectedDigest); if (digest !== expectedDigest) fail("digest_mismatch", "Blob digest mismatch"); }
    if (!await this.storage.blobs.create(digest, snapshot, this.maxTotalBytes)) {
      const existing = await this.getBlob(digest);
      if (!existing.equals(snapshot)) fail("digest_mismatch", "Existing blob content mismatch");
    }
    return { digest, size: snapshot.byteLength };
  }
  async getBlob(digest: Digest): Promise<Buffer> {
    assertDigest(digest);
    const bytes = await this.storage.blobs.read(digest, this.maxBlobBytes);
    if (bytes === null) fail("not_found", "Registry blob not found");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxBlobBytes) fail("corrupt_registry", "Registry adapter returned an invalid or oversized blob");
    if (digestBytes(bytes) !== digest) fail("digest_mismatch", "Stored blob digest mismatch");
    return Buffer.from(bytes);
  }
  async getManifest(digest: Digest): Promise<ImageRecord> {
    assertDigest(digest);
    const bytes = await this.readMetadata("manifests", digest.slice(7), MAX_MANIFEST_BYTES);
    let manifest: unknown;
    try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("corrupt_registry", "Malformed stored manifest"); }
    validateManifest(manifest);
    if (manifestDigest(manifest) !== digest) fail("digest_mismatch", "Stored manifest digest mismatch");
    // Writing a content-addressed manifest precedes the immutable version commit.
    // A failed/conflicting publish must not become executable via its orphan digest.
    let committed: { name: string; version: string; digest: Digest };
    try { committed = JSON.parse((await this.readMetadata("versions", digestBytes(`${manifest.name}@${manifest.version}`).slice(7), 4096)).toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) fail("corrupt_registry", "Malformed immutable version pointer"); throw error; }
    if (!committed || committed.name !== manifest.name || committed.version !== manifest.version || committed.digest !== digest) fail("not_found", "Image manifest has no matching committed version");
    return { digest, manifest };
  }
  /** Verify the dependency closure before committing an immutable version. */
  async publish(manifest: ImageManifest): Promise<ImageRecord> {
    validateManifest(manifest);
    const snapshot = JSON.parse(canonicalJson(manifest)) as ImageManifest;
    for (const artifact of snapshot.artifacts) validateArtifactBytes(artifact, await this.getBlob(artifact.digest));
    await this.validateDependencies(snapshot);
    const digest = manifestDigest(snapshot);
    await this.immutable("manifests", digest.slice(7), Buffer.from(canonicalJson(snapshot)));
    await this.immutable("versions", digestBytes(`${snapshot.name}@${snapshot.version}`).slice(7), Buffer.from(canonicalJson({ name: snapshot.name, version: snapshot.version, digest })));
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
      const key = digestBytes(reference).slice(7);
      let bytes: Buffer;
      try { bytes = await this.readMetadata("versions", key, 4096); }
      catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "not_found") throw error; bytes = await this.readMetadata("tags", key, 4096); }
      let pointer: { name: string; version?: string; tag?: string; digest: Digest };
      try { pointer = JSON.parse(bytes.toString("utf8")); } catch { fail("corrupt_registry", "Invalid image pointer"); }
      if (!pointer || pointer.name !== name || (pointer.version ?? pointer.tag) !== selector) fail("corrupt_registry", "Image pointer identity mismatch");
      record = await this.getManifest(pointer.digest);
      if (pointer.version !== undefined && record.manifest.version !== pointer.version) fail("corrupt_registry", "Image version does not match its pointer");
    }
    if (record.manifest.name !== name) fail("invalid_reference", "Image name does not match digest");
    return record;
  }
  async setTag(name: string, tag: string, digest: Digest): Promise<void> {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(tag)) fail("invalid_tag", "Tags start with a letter and contain at most 64 characters");
    const record = await this.getManifest(digest);
    if (record.manifest.name !== name) fail("invalid_reference", "Tag name does not match image");
    await this.storage.metadata.writeTag(digestBytes(`${name}@${tag}`).slice(7), Buffer.from(canonicalJson({ name, tag, digest })));
  }
  async list(): Promise<ImageRecord[]> {
    const files = await this.storage.metadata.listVersions(10000);
    if (files.length > 10000) fail("registry_limit", "Registry listing exceeds 10000 versions");
    const records: ImageRecord[] = [];
    for (const file of files) {
      if (!/^[0-9a-f]{64}$/.test(file)) fail("corrupt_registry", "Unexpected version entry");
      let pointer: { name: string; version: string; digest: Digest };
      try { pointer = JSON.parse((await this.readMetadata("versions", file, 4096)).toString("utf8")); } catch { fail("corrupt_registry", "Invalid version pointer"); }
      if (!pointer || typeof pointer.name !== "string" || typeof pointer.version !== "string" || digestBytes(`${pointer.name}@${pointer.version}`).slice(7) !== file) fail("corrupt_registry", "Version key identity mismatch");
      records.push(await this.resolve(`${pointer.name}@${pointer.version}`));
    }
    return records.sort((a, b) => `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`));
  }
}

/** Filesystem convenience wrapper; existing on-disk registries keep their layout. */
export class FileImageRegistry extends ImageRegistry {
  readonly root: string;
  constructor(root: string, options: RegistryOptions = {}) {
    const directory = resolve(root);
    super({ ...options, storage: { id: `file:${directory}`, metadata: new FileRegistryMetadataAdapter(directory), blobs: new FileRegistryBlobAdapter(directory) } });
    this.root = directory;
  }
}
