import crypto from "node:crypto";
import Database from "better-sqlite3";

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

// ─── SQLite default ─────────────────────────────────────────────────

export interface SqliteKeyStorageOptions {
  dbPath: string;
  /** Override the table name (default: "api_keys"). */
  tableName?: string;
}

/**
 * Default ApiKeyStorageAdapter backed by better-sqlite3. Used by the Station
 * server when no `keyStorage` is configured. For Postgres / MySQL / Redis,
 * implement `ApiKeyStorageAdapter` and pass it to `KeyStore` directly.
 */
export class SqliteKeyStorage implements ApiKeyStorageAdapter {
  private db: Database.Database;
  private table: string;

  constructor(options: SqliteKeyStorageOptions) {
    const tableName = options.tableName ?? "api_keys";
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`Invalid table name "${tableName}"`);
    }
    this.table = tableName;
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

  touch(id: string, lastUsedIso: string): void {
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

export class KeyStore {
  private storage: ApiKeyStorageAdapter;

  /**
   * Pass an `ApiKeyStorageAdapter` for any backend. The string overload is
   * retained for backwards compatibility — it constructs a SqliteKeyStorage
   * at the given path.
   */
  constructor(storageOrDbPath: ApiKeyStorageAdapter | string) {
    if (typeof storageOrDbPath === "string") {
      this.storage = new SqliteKeyStorage({ dbPath: storageOrDbPath });
    } else {
      this.storage = storageOrDbPath;
    }
  }

  /** Generate a new API key. Returns the full key (only shown once) and the stored record. */
  async create(name: string, scopes: string[] = ["trigger", "read"]): Promise<{ key: string; record: ApiKey }> {
    const id = crypto.randomUUID();
    const rawKey = `sk_live_${crypto.randomBytes(16).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
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
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const record = await this.storage.findByHash(keyHash);
    if (!record) return null;
    if (record.revoked) return null;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;

    // Touch is best-effort — don't block verification on the write.
    Promise.resolve(this.storage.touch(record.id, new Date().toISOString())).catch(() => {});

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
