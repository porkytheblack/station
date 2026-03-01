/** Validate table name to prevent SQL injection (alphanumeric + underscores only). */
export function validateTableName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name "${name}". Only alphanumeric characters and underscores are allowed.`);
  }
  return name;
}

/** Convert a Date to an ISO string for storage, or pass through null/undefined as null. */
export function dateToStr(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
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
