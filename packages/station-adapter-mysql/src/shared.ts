/** Validate table name to prevent SQL injection (alphanumeric + underscores only). */
export function validateTableName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name "${name}". Only alphanumeric characters and underscores are allowed.`);
  }
  return name;
}

/**
 * MySQL error codes we treat as "already exists" — the operation is then a
 * successful no-op. Anything else surfaces. Reference:
 *   ER_DUP_KEYNAME (1061)  — index with this name already exists
 *   ER_DUP_FIELDNAME (1060) — column with this name already exists
 *   ER_TABLE_EXISTS_ERROR (1050) — table already exists
 */
const ALREADY_EXISTS_CODES = new Set([1050, 1060, 1061]);

interface MysqlError {
  errno?: number;
  code?: string;
  message?: string;
}

/**
 * Run an idempotent DDL statement. MySQL doesn't accept `CREATE INDEX IF NOT
 * EXISTS` until very recent versions; this helper accepts the duplicate-name
 * error and treats it as a no-op, propagating anything else (permission
 * errors, network, syntax) so real failures are still visible.
 */
export async function runIdempotentDdl(
  exec: (sql: string) => Promise<unknown>,
  sql: string,
): Promise<void> {
  try {
    await exec(sql);
  } catch (err) {
    const e = err as MysqlError;
    if (e?.errno !== undefined && ALREADY_EXISTS_CODES.has(e.errno)) return;
    if (e?.code === "ER_DUP_KEYNAME" || e?.code === "ER_DUP_FIELDNAME" || e?.code === "ER_TABLE_EXISTS_ERROR") return;
    throw err;
  }
}

/**
 * Convert a Date to a MySQL DATETIME string ("YYYY-MM-DD HH:MM:SS.mmm", UTC)
 * for storage, or pass through null/undefined as null. Stock MySQL rejects
 * ISO strings with a trailing "Z" in strict mode, so the suffix is dropped.
 */
export function dateToStr(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, -1).replace("T", " ");
  if (value === undefined || value === null) return null;
  return String(value);
}

/**
 * Convert a mysql2 date value to a JS Date, or return undefined.
 * mysql2 returns Date objects for DATETIME columns, but may also return
 * strings depending on configuration, so we handle both.
 */
export function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return undefined;
}

/** Create forward and reverse column mappers from a camelCase-to-snake_case mapping. */
export function createColumnMapper(mappings: Record<string, string>) {
  const reverse = Object.fromEntries(
    Object.entries(mappings).map(([k, v]) => [v, k]),
  );
  return {
    toColumn: (key: string): string => mappings[key] ?? key,
    toField: (col: string): string => reverse[col] ?? col,
  };
}

/** Map a raw MySQL row to a typed object, converting date fields and nulls. */
export function rowToObject<T>(
  row: Record<string, unknown>,
  toField: (col: string) => string,
  dateFields: Set<string>,
): T {
  const obj: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    const field = toField(col);
    if (dateFields.has(field)) {
      obj[field] = value != null ? toDate(value) : undefined;
    } else {
      // Convert SQL NULL to undefined for optional fields
      obj[field] = value === null ? undefined : value;
    }
  }
  return obj as unknown as T;
}
