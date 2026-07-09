import type { EnvStorageAdapter } from "./adapters/index.js";
import {
  type EnvTarget,
  type EnvVar,
  type EnvVarPublic,
  MAX_ENV_VALUE_LENGTH,
  validateEnvKey,
  validateEnvTargets,
} from "./types.js";

export interface EnvStoreOptions {
  /**
   * How long a resolved variable listing may be served from cache. Runners
   * resolve env on every dispatch, so this bounds adapter query volume; edits
   * made through the same store invalidate immediately, edits made by another
   * process become visible within the TTL. @default 1000
   */
  cacheTtlMs?: number;
}

export interface CreateEnvVarInput {
  key: string;
  value: string;
  secret?: boolean;
  targets?: EnvTarget[];
  createdBy?: string;
}

export interface UpdateEnvVarInput {
  value?: string;
  secret?: boolean;
  targets?: EnvTarget[];
}

/** Thrown for invalid keys/values/targets and for conflicting definitions. */
export class EnvValidationError extends Error {
  readonly code = "ENV_VALIDATION_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/**
 * Validation, secret masking, and resolution over an {@link EnvStorageAdapter}.
 *
 * Resolution model (Vercel-like): a variable with no targets is **global** and
 * applies to every signal and beacon; a variable with targets applies only to
 * those, and overrides a global variable with the same key. Two variables may
 * share a key only if their scopes can never both apply to one target (so
 * resolution stays deterministic).
 *
 * `EnvStore` structurally satisfies the `EnvProvider` interface that
 * `SignalRunner` / `BeaconRunner` accept, so it can be passed to them directly.
 */
export class EnvStore {
  private adapter: EnvStorageAdapter;
  private cacheTtlMs: number;
  private cache: { vars: EnvVar[]; at: number } | null = null;

  constructor(adapter: EnvStorageAdapter, options: EnvStoreOptions = {}) {
    this.adapter = adapter;
    this.cacheTtlMs = options.cacheTtlMs ?? 1000;
  }

  async create(input: CreateEnvVarInput): Promise<EnvVar> {
    const keyError = validateEnvKey(input.key);
    if (keyError) throw new EnvValidationError(keyError);
    this.validateValue(input.value);
    const targetsError = validateEnvTargets(input.targets);
    if (targetsError) throw new EnvValidationError(targetsError);

    const targets = normalizeTargets(input.targets ?? []);
    const existing = await this.adapter.list();
    for (const other of existing) {
      if (other.key === input.key && scopesOverlap(targets, other.targets)) {
        throw new EnvValidationError(
          `"${input.key}" is already defined for ${describeScope(other.targets)} — edit that variable or scope this one to different targets`,
        );
      }
    }

    const now = new Date();
    const envVar: EnvVar = {
      id: this.adapter.generateId(),
      key: input.key,
      value: input.value,
      secret: input.secret ?? false,
      targets,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
    };
    await this.adapter.add(envVar);
    this.invalidate();
    return envVar;
  }

  async update(id: string, input: UpdateEnvVarInput): Promise<EnvVar | null> {
    const existing = await this.adapter.get(id);
    if (!existing) return null;

    if (input.value !== undefined) this.validateValue(input.value);
    let targets: EnvTarget[] | undefined;
    if (input.targets !== undefined) {
      const targetsError = validateEnvTargets(input.targets);
      if (targetsError) throw new EnvValidationError(targetsError);
      targets = normalizeTargets(input.targets);
      const all = await this.adapter.list();
      for (const other of all) {
        if (other.id !== id && other.key === existing.key && scopesOverlap(targets, other.targets)) {
          throw new EnvValidationError(
            `"${existing.key}" is already defined for ${describeScope(other.targets)} — the new targets would make resolution ambiguous`,
          );
        }
      }
    }

    await this.adapter.update(id, {
      value: input.value,
      // Once a value is marked secret it stays secret: downgrading would
      // reveal a value that was written under write-only expectations.
      secret: input.secret === true ? true : undefined,
      targets,
    });
    this.invalidate();
    return this.adapter.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.adapter.delete(id);
    if (deleted) this.invalidate();
    return deleted;
  }

  async get(id: string): Promise<EnvVar | null> {
    return this.adapter.get(id);
  }

  async list(): Promise<EnvVar[]> {
    return this.adapter.list();
  }

  /** All variables with secret values redacted — safe to serialize to clients. */
  async listPublic(): Promise<EnvVarPublic[]> {
    const vars = await this.adapter.list();
    return vars
      .sort((a, b) => a.key.localeCompare(b.key) || a.createdAt.getTime() - b.createdAt.getTime())
      .map(toPublic);
  }

  async getPublic(id: string): Promise<EnvVarPublic | null> {
    const v = await this.adapter.get(id);
    return v ? toPublic(v) : null;
  }

  /**
   * The environment map to inject into a run of `target`: global variables
   * first, then variables scoped to the target (which win on key collisions).
   */
  async resolveFor(target: EnvTarget): Promise<Record<string, string>> {
    const vars = await this.listCached();
    const resolved: Record<string, string> = {};
    for (const v of vars) {
      if (v.targets.length === 0) resolved[v.key] = v.value;
    }
    for (const v of vars) {
      if (v.targets.some((t) => t.kind === target.kind && t.name === target.name)) {
        resolved[v.key] = v.value;
      }
    }
    return resolved;
  }

  /** Drop the read cache — the next resolve/list re-queries the adapter. */
  invalidate(): void {
    this.cache = null;
  }

  async ping(): Promise<boolean> {
    return this.adapter.ping();
  }

  async close(): Promise<void> {
    await this.adapter.close?.();
  }

  private async listCached(): Promise<EnvVar[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.cacheTtlMs) {
      return this.cache.vars;
    }
    const vars = await this.adapter.list();
    this.cache = { vars, at: now };
    return vars;
  }

  private validateValue(value: unknown): void {
    if (typeof value !== "string") {
      throw new EnvValidationError("value must be a string");
    }
    if (value.length > MAX_ENV_VALUE_LENGTH) {
      throw new EnvValidationError(`value must be at most ${MAX_ENV_VALUE_LENGTH} characters`);
    }
  }
}

export function toPublic(v: EnvVar): EnvVarPublic {
  return {
    id: v.id,
    key: v.key,
    value: v.secret ? null : v.value,
    secret: v.secret,
    targets: v.targets.map((t) => ({ ...t })),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    createdBy: v.createdBy,
  };
}

/** Dedupe targets (kind+name) preserving order. */
function normalizeTargets(targets: EnvTarget[]): EnvTarget[] {
  const seen = new Set<string>();
  const out: EnvTarget[] = [];
  for (const t of targets) {
    const key = `${t.kind} ${t.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: t.kind, name: t.name });
  }
  return out;
}

/**
 * Two scopes overlap when some target could receive both variables: both
 * global, or they share a (kind, name). A global + a scoped variable do NOT
 * overlap — the scoped one intentionally overrides the global.
 */
function scopesOverlap(a: EnvTarget[], b: EnvTarget[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0 || b.length === 0) return false;
  const bKeys = new Set(b.map((t) => `${t.kind} ${t.name}`));
  return a.some((t) => bKeys.has(`${t.kind} ${t.name}`));
}

function describeScope(targets: EnvTarget[]): string {
  if (targets.length === 0) return "all targets (global)";
  return targets.map((t) => `${t.kind} "${t.name}"`).join(", ");
}
