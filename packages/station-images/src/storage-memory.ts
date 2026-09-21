import { fail, type Digest } from "./types.js";
import type { RegistryBlobAdapter, RegistryCollection, RegistryMetadataAdapter } from "./storage.js";

function bounded(value: Uint8Array | undefined, maxBytes: number): Uint8Array | null {
  if (!value) return null;
  if (value.byteLength > maxBytes) fail("corrupt_registry", "Stored registry value exceeds bounds");
  return value.slice();
}
/** Volatile metadata, useful for tests and embedded registries. Share the same instance between clients. */
export class MemoryRegistryMetadataAdapter implements RegistryMetadataAdapter {
  private readonly records = new Map<string, Uint8Array>();
  async read(collection: RegistryCollection, key: string, maxBytes: number) { return bounded(this.records.get(`${collection}/${key}`), maxBytes); }
  async create(collection: "manifests" | "versions", key: string, bytes: Uint8Array) {
    const id = `${collection}/${key}`;
    if (this.records.has(id)) return false;
    this.records.set(id, Uint8Array.from(bytes)); return true;
  }
  async writeTag(key: string, bytes: Uint8Array) { this.records.set(`tags/${key}`, Uint8Array.from(bytes)); }
  async listVersions(limit: number) {
    const keys = [...this.records.keys()].filter(key => key.startsWith("versions/")).map(key => key.slice(9));
    if (keys.length > limit) fail("registry_limit", "Registry listing exceeds its limit");
    return keys;
  }
}
/** Volatile blob storage with atomic admission within one shared adapter instance. */
export class MemoryRegistryBlobAdapter implements RegistryBlobAdapter {
  private readonly blobs = new Map<Digest, Uint8Array>();
  private used = 0;
  async read(digest: Digest, maxBytes: number) { return bounded(this.blobs.get(digest), maxBytes); }
  async create(digest: Digest, bytes: Uint8Array, maxTotalBytes: number) {
    if (this.blobs.has(digest)) return false;
    if (this.used + bytes.byteLength > maxTotalBytes) fail("registry_quota", "Registry blob quota exceeded");
    this.blobs.set(digest, Uint8Array.from(bytes)); this.used += bytes.byteLength; return true;
  }
}
