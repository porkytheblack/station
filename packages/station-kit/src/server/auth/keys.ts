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

export class KeyStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
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

  /** Generate a new API key. Returns the full key (only shown once) and the stored record. */
  create(name: string, scopes: string[] = ["trigger", "read"]): { key: string; record: ApiKey } {
    const id = crypto.randomUUID();
    const rawKey = `sk_live_${crypto.randomBytes(16).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const keyPrefix = rawKey.slice(0, 12);
    const createdAt = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, keyHash, keyPrefix, JSON.stringify(scopes), createdAt);

    return {
      key: rawKey,
      record: { id, name, keyHash, keyPrefix, scopes, createdAt, lastUsed: null, expiresAt: null, revoked: false },
    };
  }

  /** Verify an API key. Returns the key record if valid, null otherwise. */
  verify(rawKey: string): ApiKey | null {
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const row = this.db.prepare(`
      SELECT id, name, key_hash, key_prefix, scopes, created_at, last_used, expires_at, revoked
      FROM api_keys WHERE key_hash = ?
    `).get(keyHash) as Record<string, unknown> | undefined;

    if (!row) return null;
    if (row.revoked) return null;
    if (row.expires_at && new Date(row.expires_at as string) < new Date()) return null;

    // Update last_used
    this.db.prepare("UPDATE api_keys SET last_used = ? WHERE id = ?").run(new Date().toISOString(), row.id);

    return {
      id: row.id as string,
      name: row.name as string,
      keyHash: row.key_hash as string,
      keyPrefix: row.key_prefix as string,
      scopes: JSON.parse(row.scopes as string),
      createdAt: row.created_at as string,
      lastUsed: row.last_used as string | null,
      expiresAt: row.expires_at as string | null,
      revoked: Boolean(row.revoked),
    };
  }

  /** List all keys (without hashes). */
  list(): Omit<ApiKey, "keyHash">[] {
    const rows = this.db.prepare(`
      SELECT id, name, key_prefix, scopes, created_at, last_used, expires_at, revoked
      FROM api_keys ORDER BY created_at DESC
    `).all() as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      keyPrefix: row.key_prefix as string,
      scopes: JSON.parse(row.scopes as string),
      createdAt: row.created_at as string,
      lastUsed: row.last_used as string | null,
      expiresAt: row.expires_at as string | null,
      revoked: Boolean(row.revoked),
    }));
  }

  /** Revoke a key by ID. */
  revoke(id: string): boolean {
    const result = this.db.prepare("UPDATE api_keys SET revoked = 1 WHERE id = ?").run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
