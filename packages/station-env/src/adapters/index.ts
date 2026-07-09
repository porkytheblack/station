import type { EnvVar, EnvVarPatch } from "../types.js";

/**
 * Pluggable storage backend for runtime env vars. Implement against any
 * database; built-ins cover memory (tests) and a JSON file (single-process
 * default). Durable adapters ship from the `station-adapter-*` packages'
 * `/env` subpath.
 */
export interface EnvStorageAdapter {
  add(envVar: EnvVar): Promise<void>;
  get(id: string): Promise<EnvVar | null>;
  list(): Promise<EnvVar[]>;
  update(id: string, patch: EnvVarPatch): Promise<void>;
  delete(id: string): Promise<boolean>;
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

export { MemoryEnvStorage } from "./memory.js";
export { FileEnvStorage, type FileEnvStorageOptions } from "./file.js";
