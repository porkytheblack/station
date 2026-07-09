import { randomUUID } from "node:crypto";
import type { EnvVar, EnvVarPatch } from "../types.js";
import type { EnvStorageAdapter } from "./index.js";

/** In-memory EnvStorageAdapter — for tests and throwaway setups. */
export class MemoryEnvStorage implements EnvStorageAdapter {
  private vars = new Map<string, EnvVar>();

  async add(envVar: EnvVar): Promise<void> {
    if (this.vars.has(envVar.id)) {
      throw new Error(`Env var with id "${envVar.id}" already exists`);
    }
    this.vars.set(envVar.id, cloneVar(envVar));
  }

  async get(id: string): Promise<EnvVar | null> {
    const v = this.vars.get(id);
    return v ? cloneVar(v) : null;
  }

  async list(): Promise<EnvVar[]> {
    // Return copies — mutations via update() must not be visible to callers
    // already holding a previously-listed reference.
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
    const next: EnvVar = { ...existing, ...cleaned, updatedAt: new Date() };
    this.vars.set(id, cloneVar(next));
  }

  async delete(id: string): Promise<boolean> {
    return this.vars.delete(id);
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.vars.clear();
  }
}

function cloneVar(v: EnvVar): EnvVar {
  return { ...v, targets: v.targets.map((t) => ({ ...t })) };
}
