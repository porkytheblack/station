import { randomUUID } from "node:crypto";
import { assertDigest, digestBytes } from "./manifest.js";
import { fail, ImageError, type Digest } from "./types.js";
import type { ImageRegistry } from "./registry.js";

export interface ImageUploadChunk { offset: number; size: number; digest: Digest }
export interface ImageUploadRecord {
  format: "station.upload/v1"; id: string; registryId: string; digest: Digest; size: number;
  offset: number; createdAt: number; expiresAt: number; state: "open" | "committed";
  chunks: ImageUploadChunk[];
}
export type ImageUploadStatus = Omit<ImageUploadRecord, "registryId" | "chunks" | "format">;
/** Every callback is exclusive across ALL clients of one staging namespace. */
export interface ImageUploadTransaction {
  list(limit: number): Promise<ImageUploadRecord[]>;
  read(id: string): Promise<ImageUploadRecord | null>;
  write(record: ImageUploadRecord): Promise<void>;
  readChunk(id: string, offset: number, maxBytes: number): Promise<Uint8Array | null>;
  /** Immutable create. Identical retries are accepted; conflicting bytes must fail. */
  putChunk(id: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** Remove chunks before metadata; interrupted removal must retain its reservation. */
  remove(id: string): Promise<void>;
}
export interface ImageUploadStorage {
  /** Serialize the callback, release on failure; durable writes must precede resolution. */
  transaction<T>(operation: (tx: ImageUploadTransaction) => Promise<T>): Promise<T>;
}
export interface ImageUploadOptions {
  registry: ImageRegistry; storage: ImageUploadStorage; maxChunkBytes?: number;
  maxUploads?: number; maxStagedBytes?: number; ttlMs?: number; now?: () => number;
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function assertUploadId(id: string): void { if (typeof id !== "string" || !idPattern.test(id)) fail("invalid_upload", "Invalid upload identifier"); }
/** Bounded, resumable admission independent of the final registry's metadata/blob adapters. */
export class ImageUploadManager {
  readonly registryIdentity: string;
  readonly maxChunkBytes: number;
  readonly maxUploads: number;
  readonly maxStagedBytes: number;
  readonly ttlMs: number;
  private readonly registry: ImageRegistry;
  private readonly storage: ImageUploadStorage;
  private readonly now: () => number;
  constructor(options: ImageUploadOptions) {
    this.registryIdentity = options.registry.identity;
    this.registry = options.registry; this.storage = options.storage; this.now = options.now ?? Date.now;
    this.maxChunkBytes = options.maxChunkBytes ?? 1024 * 1024;
    this.maxUploads = options.maxUploads ?? 64;
    this.maxStagedBytes = options.maxStagedBytes ?? 512 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    if (!Number.isSafeInteger(this.maxChunkBytes) || this.maxChunkBytes < 1 || this.maxChunkBytes > 8 * 1024 * 1024 || !Number.isSafeInteger(this.maxUploads) || this.maxUploads < 1 || this.maxUploads > 1024 || !Number.isSafeInteger(this.maxStagedBytes) || this.maxStagedBytes < 1 || this.maxStagedBytes > 8 * 1024 ** 3 || !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1000 || this.ttlMs > 86_400_000) fail("invalid_limits", "Invalid resumable upload limits");
  }
  private validate(record: ImageUploadRecord): ImageUploadRecord {
    assertUploadId(record?.id); assertDigest(record.digest);
    if (record.format !== "station.upload/v1" || record.registryId !== this.registry.identity || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > this.registry.maxBlobBytes || !Number.isSafeInteger(record.offset) || record.offset < 0 || record.offset > record.size || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt || record.expiresAt - record.createdAt > 86_400_000 || !["open", "committed"].includes(record.state) || !Array.isArray(record.chunks) || record.chunks.length > 4096) fail("corrupt_upload", "Invalid upload metadata or namespace binding");
    let offset = 0;
    for (const chunk of record.chunks) {
      assertDigest(chunk.digest);
      if (chunk.offset !== offset || !Number.isSafeInteger(chunk.size) || chunk.size < 1 || chunk.size > 8 * 1024 * 1024) fail("corrupt_upload", "Invalid upload chunk metadata");
      offset += chunk.size;
    }
    if (offset !== record.offset || (record.state === "committed" && offset !== record.size)) fail("corrupt_upload", "Invalid upload offset");
    return record;
  }
  private status(record: ImageUploadRecord): ImageUploadStatus {
    const { format: _format, registryId: _registryId, chunks: _chunks, ...status } = record; return status;
  }
  private async read(tx: ImageUploadTransaction, id: string) {
    assertUploadId(id); const record = await tx.read(id);
    if (!record) fail("not_found", "Upload not found"); this.validate(record);
    if (record.id !== id) fail("corrupt_upload", "Upload identifier mismatch");
    if (record.expiresAt <= this.now()) fail("upload_expired", "Upload has expired");
    return record;
  }
  async create(digest: Digest, size: number): Promise<ImageUploadStatus> {
    assertDigest(digest);
    if (!Number.isSafeInteger(size) || size < 1 || size > this.registry.maxBlobBytes || size > this.maxStagedBytes) fail("blob_too_large", "Upload size exceeds limits");
    return this.storage.transaction(async tx => {
      const records = await tx.list(1024); let reserved = 0, count = 0;
      for (const record of records) {
        this.validate(record);
        if (record.expiresAt <= this.now()) { await tx.remove(record.id); continue; }
        reserved += record.size; count++;
      }
      if (count >= this.maxUploads || reserved + size > this.maxStagedBytes) fail("upload_quota", "Upload staging reservation quota exceeded");
      const createdAt = this.now();
      const record: ImageUploadRecord = { format: "station.upload/v1", id: randomUUID(), registryId: this.registry.identity, digest, size, offset: 0, createdAt, expiresAt: createdAt + this.ttlMs, state: "open", chunks: [] };
      await tx.write(record); return this.status(record);
    });
  }
  async get(id: string): Promise<ImageUploadStatus> { return this.storage.transaction(async tx => this.status(await this.read(tx, id))); }
  async append(id: string, offset: number, bytes: Uint8Array, expectedDigest: Digest): Promise<ImageUploadStatus> {
    assertDigest(expectedDigest);
    if (!Number.isSafeInteger(offset) || offset < 0) fail("invalid_offset", "Upload offset must be a nonnegative integer");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > this.maxChunkBytes) fail("chunk_too_large", "Chunk size exceeds limits");
    const snapshot = Buffer.from(bytes);
    if (digestBytes(snapshot) !== expectedDigest) fail("digest_mismatch", "Chunk digest mismatch");
    return this.storage.transaction(async tx => {
      const record = await this.read(tx, id);
      const previous = record.chunks.find(chunk => chunk.offset === offset);
      if (previous && previous.size === snapshot.length && previous.digest === expectedDigest) return this.status(record);
      if (record.state !== "open" || offset !== record.offset) fail("upload_conflict", "Upload offset or state conflicts; read upload status before retrying");
      if (offset + snapshot.length > record.size || record.chunks.length >= 4096) fail("chunk_too_large", "Chunk exceeds declared upload size or chunk-count limit");
      await tx.putChunk(id, offset, snapshot);
      record.chunks.push({ offset, size: snapshot.length, digest: expectedDigest }); record.offset += snapshot.length;
      await tx.write(record); return this.status(record);
    });
  }
  async commit(id: string): Promise<ImageUploadStatus> {
    return this.storage.transaction(async tx => {
      const record = await this.read(tx, id);
      if (record.offset !== record.size) fail("upload_incomplete", "Upload is incomplete");
      // A lost response or crash after final blob creation can safely finish the metadata commit.
      let existing: Buffer | undefined;
      try { existing = await this.registry.getBlob(record.digest); }
      catch (error) { if (!(error instanceof ImageError && error.code === "not_found")) throw error; }
      if (existing) { if (existing.length !== record.size) fail("digest_mismatch", "Committed blob size mismatch"); }
      else {
        const bytes = Buffer.alloc(record.size);
        for (const chunk of record.chunks) {
          const part = await tx.readChunk(id, chunk.offset, chunk.size);
          if (!part || part.byteLength !== chunk.size || digestBytes(part) !== chunk.digest) fail("digest_mismatch", "Staged chunk is missing or corrupt");
          bytes.set(part, chunk.offset);
        }
        await this.registry.putBlob(bytes, record.digest);
      }
      record.state = "committed"; await tx.write(record); return this.status(record);
    });
  }
  /** Cancellation removes staging only. A committed immutable registry blob remains available. */
  async cancel(id: string): Promise<void> {
    assertUploadId(id); await this.storage.transaction(async tx => { const record = await tx.read(id); if (record) { this.validate(record); await tx.remove(id); } });
  }
  async sweep(): Promise<number> {
    return this.storage.transaction(async tx => { let removed = 0; for (const record of await tx.list(1024)) { this.validate(record); if (record.expiresAt <= this.now()) { await tx.remove(record.id); removed++; } } return removed; });
  }
}
