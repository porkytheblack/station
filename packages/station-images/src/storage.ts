import type { Digest } from "./types.js";

export type RegistryCollection = "manifests" | "versions" | "tags";

/** Operator-provided storage for one registry namespace. Keys are SHA-256 hex strings. */
export interface RegistryMetadataAdapter {
  /** Return null only for absence. Bound reads before allocating the whole response. */
  read(collection: RegistryCollection, key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Atomic create-if-absent across ALL clients; never replace an existing value. */
  create(collection: "manifests" | "versions", key: string, bytes: Uint8Array): Promise<boolean>;
  /** Atomically replace a tag; readers must never observe a partial value. */
  writeTag(key: string, bytes: Uint8Array): Promise<void>;
  /** Fail if more than limit keys exist; do not silently truncate the catalog. */
  listVersions(limit: number): Promise<string[]>;
}

export interface RegistryBlobAdapter {
  /** Return null only for absence; enforce maxBytes while reading. */
  read(digest: Digest, maxBytes: number): Promise<Uint8Array | null>;
  /**
   * Atomically create immutable bytes and admit their size against the namespace quota.
   * Concurrent writers must not oversubscribe maxTotalBytes. Existing blobs do not
   * consume quota twice. Return false for an existing key; never overwrite it.
   */
  create(digest: Digest, bytes: Uint8Array, maxTotalBytes: number): Promise<boolean>;
}

export interface RegistryStorage {
  /** Stable, non-secret identity of this metadata/blob namespace. Change it when replacing storage. */
  id: string;
  metadata: RegistryMetadataAdapter;
  blobs: RegistryBlobAdapter;
}
