/** What kind of runnable an env var can be scoped to. */
export type EnvTargetKind = "signal" | "beacon";

/** A specific signal or beacon an env var is fed into. */
export interface EnvTarget {
  kind: EnvTargetKind;
  name: string;
}

/**
 * A runtime-managed environment variable. Variables live behind an
 * {@link import("./adapters/index.js").EnvStorageAdapter} and are injected
 * into signal/beacon child processes when they run.
 *
 * Scoping: an empty `targets` array means the variable is **global** — it is
 * injected into every signal and beacon. A non-empty list restricts injection
 * to those targets. A scoped variable overrides a global one with the same key.
 */
export interface EnvVar {
  id: string;
  /** POSIX-style name, e.g. "STRIPE_API_KEY". Must match {@link ENV_KEY_PATTERN}. */
  key: string;
  value: string;
  /** Secret values are write-only: reads through the API return `value: null`. */
  secret: boolean;
  /** Empty ⇒ global (all signals and beacons). */
  targets: EnvTarget[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

/** Patchable fields on an EnvVar — identity fields (id, key, createdAt) are immutable. */
export type EnvVarPatch = Partial<Omit<EnvVar, "id" | "key" | "createdAt">>;

/** Redacted view of an {@link EnvVar} — `value` is null when the var is secret. */
export interface EnvVarPublic {
  id: string;
  key: string;
  value: string | null;
  secret: boolean;
  targets: EnvTarget[];
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

/** Valid env var key: letter or underscore, then letters/digits/underscores. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const MAX_ENV_KEY_LENGTH = 256;
export const MAX_ENV_VALUE_LENGTH = 32_768;

/**
 * Keys that must never be settable through the store: they change how the
 * child *process* executes (loader injection, module resolution) rather than
 * what the handler code reads, so a dashboard write could escalate to
 * arbitrary code execution in every spawned run.
 */
const BLOCKED_KEYS = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

/** Station's own child-process control variables are also off limits. */
const BLOCKED_PREFIXES = ["STATION_SIGNAL_", "STATION_BEACON_", "__STATION"];

/**
 * Validate an env var key. Returns an error message, or null when the key is
 * acceptable.
 */
export function validateEnvKey(key: unknown): string | null {
  if (typeof key !== "string" || key.length === 0) {
    return "key is required";
  }
  if (key.length > MAX_ENV_KEY_LENGTH) {
    return `key must be at most ${MAX_ENV_KEY_LENGTH} characters`;
  }
  if (!ENV_KEY_PATTERN.test(key)) {
    return `key "${key}" is invalid — keys must start with a letter or underscore and contain only letters, digits, and underscores`;
  }
  const upper = key.toUpperCase();
  if (BLOCKED_KEYS.has(upper)) {
    return `key "${key}" is reserved — it changes how child processes execute and cannot be managed through the env store`;
  }
  for (const prefix of BLOCKED_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return `key "${key}" is reserved for Station internals`;
    }
  }
  return null;
}

/** Validate a target list. Returns an error message, or null when acceptable. */
export function validateEnvTargets(targets: unknown): string | null {
  if (targets === undefined) return null;
  if (!Array.isArray(targets)) return "targets must be an array";
  for (const t of targets) {
    if (!t || typeof t !== "object") return "each target must be an object";
    const { kind, name } = t as Partial<EnvTarget>;
    if (kind !== "signal" && kind !== "beacon") {
      return `target kind must be "signal" or "beacon"`;
    }
    if (typeof name !== "string" || name.length === 0) {
      return "target name is required";
    }
  }
  return null;
}

/**
 * Which required keys are satisfied by neither the resolved store variables
 * nor the host process environment.
 */
export function missingEnvKeys(
  required: readonly string[],
  resolved: Record<string, string> | undefined,
  processEnv: Record<string, string | undefined> = process.env,
): string[] {
  return required.filter(
    (key) => !(resolved && key in resolved) && processEnv[key] === undefined,
  );
}
