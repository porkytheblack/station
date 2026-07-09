import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { EnvVar, EnvVarPatch } from "../types.js";
import type { EnvStorageAdapter } from "./index.js";

export interface FileEnvStorageOptions {
  filePath: string;
}

interface StoredEnvVar extends Omit<EnvVar, "createdAt" | "updatedAt"> {
  createdAt: string;
  updatedAt: string;
}

/**
 * Default EnvStorageAdapter backed by a JSON file. Used by the Station server
 * when no `envStorage` is configured. No native dependencies — works on any
 * Node 18+ install.
 *
 * Crash-safety: writes go through a fsync'd tmp-file + rename, with a second
 * fsync on the parent directory so the rename itself survives power loss.
 * The file is created with `0o600` and the parent dir with `0o700` — env
 * values are typically secrets.
 *
 * Single-process only: do not point two Station instances at the same file
 * or last-rename-wins will silently clobber writes. For multi-process
 * deployments use a `station-adapter-*` `/env` adapter (Postgres, MySQL,
 * SQLite, Redis) instead.
 */
export class FileEnvStorage implements EnvStorageAdapter {
  private filePath: string;
  private vars = new Map<string, EnvVar>();

  constructor(options: FileEnvStorageOptions) {
    this.filePath = options.filePath;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as StoredEnvVar[];
      if (Array.isArray(data)) {
        for (const r of data) {
          this.vars.set(r.id, {
            ...r,
            targets: Array.isArray(r.targets) ? r.targets : [],
            createdAt: new Date(r.createdAt),
            updatedAt: new Date(r.updatedAt),
          });
        }
      }
    } catch {
      // Corrupt or unreadable file — start fresh rather than throwing.
    }
  }

  private flush(): void {
    const tmp = `${this.filePath}.tmp`;
    const serialized: StoredEnvVar[] = Array.from(this.vars.values()).map((v) => ({
      ...v,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }));
    const body = JSON.stringify(serialized, null, 2);
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    // fsync the parent directory so the rename's directory entry survives a
    // crash. Best-effort: directory fsync isn't supported on every platform.
    try {
      const dirFd = openSync(dirname(this.filePath), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Platform doesn't support directory fsync.
    }
  }

  async add(envVar: EnvVar): Promise<void> {
    if (this.vars.has(envVar.id)) {
      throw new Error(`Env var with id "${envVar.id}" already exists`);
    }
    this.vars.set(envVar.id, cloneVar(envVar));
    this.flush();
  }

  async get(id: string): Promise<EnvVar | null> {
    const v = this.vars.get(id);
    return v ? cloneVar(v) : null;
  }

  async list(): Promise<EnvVar[]> {
    return Array.from(this.vars.values()).map(cloneVar);
  }

  async update(id: string, patch: EnvVarPatch): Promise<void> {
    const existing = this.vars.get(id);
    if (!existing) return;
    const cleaned: Partial<EnvVar> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (cleaned as Record<string, unknown>)[key] = value;
    }
    this.vars.set(id, cloneVar({ ...existing, ...cleaned, updatedAt: new Date() }));
    this.flush();
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.vars.delete(id);
    if (deleted) this.flush();
    return deleted;
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    return true;
  }
}

function cloneVar(v: EnvVar): EnvVar {
  return { ...v, targets: v.targets.map((t) => ({ ...t })) };
}
