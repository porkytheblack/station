/** Validate table name to prevent SQL injection (alphanumeric + underscores only). */
export function validateTableName(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid table name "${name}". Only alphanumeric characters and underscores are allowed.`);
  }
  return name;
}

/** Serialise a Date to ISO string, or pass through null/undefined. */
export function dateToStr(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return null;
  return String(value);
}

/** Deserialise an ISO string back to Date, or return undefined. */
export function strToDate(value: unknown): Date | undefined {
  if (typeof value === "string") return new Date(value);
  return undefined;
}

/** Create forward and reverse column mappers from a camelCase→snake_case mapping. */
export function createColumnMapper(mappings: Record<string, string>) {
  const reverse = Object.fromEntries(
    Object.entries(mappings).map(([k, v]) => [v, k]),
  );
  return {
    toColumn: (key: string): string => mappings[key] ?? key,
    toField: (col: string): string => reverse[col] ?? col,
  };
}

/** Map a raw SQLite row to a typed object, converting date fields. */
export function rowToObject<T>(
  row: Record<string, unknown>,
  toField: (col: string) => string,
  dateFields: Set<string>,
): T {
  const obj: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    const field = toField(col);
    if (dateFields.has(field)) {
      obj[field] = value != null ? strToDate(value) : undefined;
    } else {
      obj[field] = value;
    }
  }
  return obj as unknown as T;
}
