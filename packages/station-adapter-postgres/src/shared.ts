/** Validate table name to prevent SQL injection (alphanumeric + underscores only). */
export function validateTableName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name "${name}". Only alphanumeric characters and underscores are allowed.`);
  }
  return name;
}

/** Create forward and reverse column mappers from a camelCase to snake_case mapping. */
export function createColumnMapper(mappings: Record<string, string>) {
  const reverse = Object.fromEntries(
    Object.entries(mappings).map(([k, v]) => [v, k]),
  );
  return {
    toColumn: (key: string): string => mappings[key] ?? key,
    toField: (col: string): string => reverse[col] ?? col,
  };
}

/**
 * Map a raw PostgreSQL row to a typed object, converting column names
 * from snake_case to camelCase. The pg driver returns Date objects for
 * TIMESTAMPTZ columns natively, so no string-to-Date conversion is needed.
 * We only need to normalize null to undefined for optional date fields.
 */
export function rowToObject<T>(
  row: Record<string, unknown>,
  toField: (col: string) => string,
  dateFields: Set<string>,
): T {
  const obj: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    const field = toField(col);
    if (dateFields.has(field)) {
      obj[field] = value != null ? value : undefined;
    } else {
      obj[field] = value;
    }
  }
  return obj as unknown as T;
}
