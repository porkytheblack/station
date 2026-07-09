import crypto from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsed: string | null;
  expiresAt: string | null;
  revoked: boolean;
}

export type ApiKeyPublic = Omit<ApiKey, "keyHash">;

/**
 * Pluggable storage backend for API keys. Implementations only persist and
 * query records — hashing, key generation, and verification logic live in
 * the KeyStore. May be sync or async; the KeyStore awaits all results.
 */
export interface ApiKeyStorageAdapter {
  insert(record: ApiKey): Promise<void> | void;
  findByHash(keyHash: string): Promise<ApiKey | null> | ApiKey | null;
  list(): Promise<ApiKeyPublic[]> | ApiKeyPublic[];
  touch(id: string, lastUsedIso: string): Promise<void> | void;
  revoke(id: string): Promise<boolean> | boolean;
  close?(): Promise<void> | void;
}

// ─── JSON file default ──────────────────────────────────────────────

export interface FileKeyStorageOptions {
  filePath: string;
}

/**
 * Default ApiKeyStorageAdapter backed by a JSON file. Used by the Station
 * server when no `keyStorage` is configured. Has no native dependencies —
 * works on any Node 18+ install without compiling bindings.
 *
 * Crash-safety: writes go through a fsync'd tmp-file + rename, with a
 * second fsync on the parent directory so the rename itself survives
 * power loss. The keys file is created with `0o600` and the parent dir
 * with `0o700` so a default umask doesn't expose key metadata.
 *
 * Single-process only: do not point two `createStation` instances at
 * the same file or last-rename-wins will silently clobber writes. For
 * multi-process or high-volume deployments, implement
 * `ApiKeyStorageAdapter` against Postgres / MySQL / Redis.
 */
export class FileKeyStorage implements ApiKeyStorageAdapter {
  private filePath: string;
  private records = new Map<string, ApiKey>();

  constructor(options: FileKeyStorageOptions) {
    this.filePath = options.filePath;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as ApiKey[];
      if (Array.isArray(data)) {
        for (const r of data) this.records.set(r.id, r);
      }
    } catch {
      // Corrupt or unreadable file — start fresh rather than throwing.
    }
  }

  private flush(): void {
    const tmp = `${this.filePath}.tmp`;
    const body = JSON.stringify(Array.from(this.records.values()), null, 2);
    // Write tmp file with fsync so its bytes are durable before rename.
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    // fsync the parent directory so the rename's directory entry survives
    // a crash. Best-effort: opening a directory for fsync isn't supported
    // on every platform (notably Windows), so swallow errors.
    try {
      const dirFd = openSync(dirname(this.filePath), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Platform doesn't support directory fsync; rename + tmp fsync
      // already give us most of the durability we can offer.
    }
  }

  insert(record: ApiKey): void {
    this.records.set(record.id, { ...record });
    this.flush();
  }

  findByHash(keyHash: string): ApiKey | null {
    for (const r of this.records.values()) {
      if (r.keyHash === keyHash) return { ...r };
    }
    return null;
  }

  list(): ApiKeyPublic[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => {
        const { keyHash: _h, ...rest } = r;
        return rest;
      });
  }

  touch(id: string, lastUsedIso: string): void {
    const r = this.records.get(id);
    if (!r) return;
    const prev = r.lastUsed ? Date.parse(r.lastUsed) : 0;
    r.lastUsed = lastUsedIso;
    // lastUsed is advisory. flush() rewrites and fsyncs the whole file
    // synchronously — doing that on every authenticated request stalls the
    // event loop, so only persist when the value moves by at least a minute.
    // Reads stay fresh because list() serves from memory.
    if (Date.parse(lastUsedIso) - prev >= 60_000) {
      this.flush();
    }
  }

  revoke(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    r.revoked = true;
    this.flush();
    return true;
  }
}

// ─── SQLite (optional) ──────────────────────────────────────────────

export interface SqliteKeyStorageOptions {
  dbPath: string;
  /** Override the table name (default: "api_keys"). */
  tableName?: string;
}

// Loaded lazily from `better-sqlite3` so the package isn't required at
// install time. Users who don't construct SqliteKeyStorage never pay for it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BetterSqlite3Module = any;
let cachedBetterSqlite3: BetterSqlite3Module | null = null;

function loadBetterSqlite3(): BetterSqlite3Module {
  if (cachedBetterSqlite3) return cachedBetterSqlite3;
  try {
    const requireFn = createRequire(import.meta.url);
    cachedBetterSqlite3 = requireFn("better-sqlite3");
    return cachedBetterSqlite3;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SqliteKeyStorage requires the optional 'better-sqlite3' package, ` +
        `which isn't installed. Install it with:\n` +
        `  npm install better-sqlite3\n` +
        `Or use FileKeyStorage (default) / MemoryKeyStorage instead.\n` +
        `Underlying error: ${reason}`,
    );
  }
}

/**
 * Optional ApiKeyStorageAdapter backed by better-sqlite3. Requires the
 * `better-sqlite3` package to be installed separately — Station Kit no
 * longer ships it as a hard dependency.
 *
 * Prefer `FileKeyStorage` (the default) unless you specifically need
 * sqlite features (concurrent reads from multiple processes, large
 * key catalogs, etc.).
 */
export class SqliteKeyStorage implements ApiKeyStorageAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private table: string;

  constructor(options: SqliteKeyStorageOptions) {
    const tableName = options.tableName ?? "api_keys";
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`Invalid table name "${tableName}"`);
    }
    this.table = tableName;
    const Database = loadBetterSqlite3();
    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        key_hash    TEXT NOT NULL UNIQUE,
        key_prefix  TEXT NOT NULL,
        scopes      TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        last_used   TEXT,
        expires_at  TEXT,
        revoked     INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  insert(record: ApiKey): void {
    this.db.prepare(`
      INSERT INTO ${this.table}
        (id, name, key_hash, key_prefix, scopes, created_at, last_used, expires_at, revoked)
      VALUES
        (@id, @name, @key_hash, @key_prefix, @scopes, @created_at, @last_used, @expires_at, @revoked)
    `).run({
      id: record.id,
      name: record.name,
      key_hash: record.keyHash,
      key_prefix: record.keyPrefix,
      scopes: JSON.stringify(record.scopes),
      created_at: record.createdAt,
      last_used: record.lastUsed,
      expires_at: record.expiresAt,
      revoked: record.revoked ? 1 : 0,
    });
  }

  findByHash(keyHash: string): ApiKey | null {
    const row = this.db
      .prepare(`SELECT id, name, key_hash, key_prefix, scopes, created_at, last_used, expires_at, revoked
                FROM ${this.table} WHERE key_hash = ?`)
      .get(keyHash) as Record<string, unknown> | undefined;
    return row ? rowToApiKey(row) : null;
  }

  list(): ApiKeyPublic[] {
    const rows = this.db
      .prepare(`SELECT id, name, key_prefix, scopes, created_at, last_used, expires_at, revoked
                FROM ${this.table} ORDER BY created_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      keyPrefix: row.key_prefix as string,
      scopes: JSON.parse(row.scopes as string),
      createdAt: row.created_at as string,
      lastUsed: (row.last_used as string | null) ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
      revoked: Boolean(row.revoked),
    }));
  }

  /** Last persisted lastUsed per key id, to skip per-request UPDATEs. */
  private lastTouched = new Map<string, number>();

  touch(id: string, lastUsedIso: string): void {
    // lastUsed is advisory — throttle writes to once a minute per key.
    const prev = this.lastTouched.get(id) ?? 0;
    const next = Date.parse(lastUsedIso);
    if (next - prev < 60_000) return;
    this.lastTouched.set(id, next);
    this.db.prepare(`UPDATE ${this.table} SET last_used = ? WHERE id = ?`).run(lastUsedIso, id);
  }

  revoke(id: string): boolean {
    const result = this.db.prepare(`UPDATE ${this.table} SET revoked = 1 WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToApiKey(row: Record<string, unknown>): ApiKey {
  return {
    id: row.id as string,
    name: row.name as string,
    keyHash: row.key_hash as string,
    keyPrefix: row.key_prefix as string,
    scopes: JSON.parse(row.scopes as string),
    createdAt: row.created_at as string,
    lastUsed: (row.last_used as string | null) ?? null,
    expiresAt: (row.expires_at as string | null) ?? null,
    revoked: Boolean(row.revoked),
  };
}

// ─── In-memory storage for tests / ephemeral deployments ────────────

export class MemoryKeyStorage implements ApiKeyStorageAdapter {
  private records = new Map<string, ApiKey>();

  insert(record: ApiKey): void {
    this.records.set(record.id, { ...record });
  }

  findByHash(keyHash: string): ApiKey | null {
    for (const r of this.records.values()) {
      if (r.keyHash === keyHash) return { ...r };
    }
    return null;
  }

  list(): ApiKeyPublic[] {
    return Array.from(this.records.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => {
        const { keyHash: _h, ...rest } = r;
        return rest;
      });
  }

  touch(id: string, lastUsedIso: string): void {
    const r = this.records.get(id);
    if (r) r.lastUsed = lastUsedIso;
  }

  revoke(id: string): boolean {
    const r = this.records.get(id);
    if (!r) return false;
    r.revoked = true;
    return true;
  }
}

// ─── KeyStore — owns crypto, delegates persistence ──────────────────

export interface KeyStoreOptions {
  /**
   * Server-side secret ("pepper") mixed into stored key hashes via HMAC.
   * Defense-in-depth: a leaked key file alone can't be brute-forced or
   * precomputed against without also stealing this secret. Optional — when
   * omitted, keys are hashed with plain SHA-256 (legacy behavior). Existing
   * plain-SHA-256 keys keep verifying after a pepper is added (see verify()).
   */
  pepper?: string;
}

export class KeyStore {
  private storage: ApiKeyStorageAdapter;
  private pepper?: Buffer;

  /**
   * Pass an `ApiKeyStorageAdapter` for any backend. The string overload is
   * retained for backwards compatibility — it constructs a FileKeyStorage
   * at the given path. (Previously this returned a SqliteKeyStorage; SQLite
   * is now opt-in to avoid native build dependencies.)
   */
  constructor(storageOrPath: ApiKeyStorageAdapter | string, options?: KeyStoreOptions) {
    if (typeof storageOrPath === "string") {
      const filePath = storageOrPath.endsWith(".db")
        ? storageOrPath.replace(/\.db$/, ".json")
        : storageOrPath;
      this.storage = new FileKeyStorage({ filePath });
    } else {
      this.storage = storageOrPath;
    }
    if (options?.pepper) this.pepper = Buffer.from(options.pepper, "utf8");
  }

  /** Peppered hash for new keys — HMAC-SHA256 when a pepper is set, else SHA-256. */
  private hashKey(rawKey: string): string {
    if (this.pepper) {
      return crypto.createHmac("sha256", this.pepper).update(rawKey).digest("hex");
    }
    return crypto.createHash("sha256").update(rawKey).digest("hex");
  }

  /** Unpeppered SHA-256 — used to verify keys stored before a pepper was configured. */
  private legacyHashKey(rawKey: string): string {
    return crypto.createHash("sha256").update(rawKey).digest("hex");
  }

  /** Generate a new API key. Returns the full key (only shown once) and the stored record. */
  async create(name: string, scopes: string[] = ["trigger", "read"]): Promise<{ key: string; record: ApiKey }> {
    const id = crypto.randomUUID();
    const rawKey = `sk_live_${crypto.randomBytes(16).toString("hex")}`;
    const keyHash = this.hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12);
    const createdAt = new Date().toISOString();

    const record: ApiKey = {
      id, name, keyHash, keyPrefix, scopes, createdAt,
      lastUsed: null, expiresAt: null, revoked: false,
    };
    await this.storage.insert(record);
    return { key: rawKey, record };
  }

  /** Verify an API key. Returns the key record if valid, null otherwise. */
  async verify(rawKey: string): Promise<ApiKey | null> {
    let record = await this.storage.findByHash(this.hashKey(rawKey));
    // Fall back to the unpeppered hash for keys created before the pepper was
    // configured, so enabling a pepper doesn't invalidate existing keys.
    if (!record && this.pepper) {
      record = await this.storage.findByHash(this.legacyHashKey(rawKey));
    }
    if (!record) return null;
    if (record.revoked) return null;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;

    // Touch is best-effort — don't block verification on the write. Wrap in
    // an explicit deferred so a synchronous throw from a sync `touch()` is
    // also swallowed, matching the async case.
    Promise.resolve()
      .then(() => this.storage.touch(record.id, new Date().toISOString()))
      .catch(() => {});

    return record;
  }

  /** List all keys (without hashes). */
  async list(): Promise<ApiKeyPublic[]> {
    return this.storage.list();
  }

  /** Revoke a key by ID. */
  async revoke(id: string): Promise<boolean> {
    return this.storage.revoke(id);
  }

  async close(): Promise<void> {
    if (this.storage.close) await this.storage.close();
  }
}
