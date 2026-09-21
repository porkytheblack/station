import { fail, type ImageSchema } from "./types.js";
const keywords = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "description"]);
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Reject non-JSON inputs (including NaN, undefined and prototype-bearing values). */
export function assertJson(value: unknown, depth = 0, seen = new Set<unknown>()): void {
  if (depth > 64) fail("invalid_json", "JSON nesting exceeds 64 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if ((!Array.isArray(value) && !isRecord(value)) || seen.has(value)) fail("invalid_json", "Expected finite, acyclic JSON data");
  seen.add(value);
  for (const entry of Object.values(value as object)) assertJson(entry, depth + 1, seen);
  seen.delete(value);
}
export function validateSchema(schema: unknown, depth = 0): asserts schema is ImageSchema {
  if (!isRecord(schema) || depth > 16) fail("invalid_schema", "Schema must be an object with at most 16 nested levels");
  for (const key of Object.keys(schema)) if (!keywords.has(key)) fail("invalid_schema", `Unsupported schema keyword: ${key}`);
  if (schema.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(schema.type))) fail("invalid_schema", "Invalid schema type");
  if (schema.description !== undefined && typeof schema.description !== "string") fail("invalid_schema", "Invalid schema description");
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties) || Object.keys(schema.properties).length > 256) fail("invalid_schema", "Invalid properties");
    for (const sub of Object.values(schema.properties)) validateSchema(sub, depth + 1);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== "string") || new Set(schema.required).size !== schema.required.length)) fail("invalid_schema", "Invalid required keys");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") fail("invalid_schema", "additionalProperties must be boolean");
  if (schema.items !== undefined) validateSchema(schema.items, depth + 1);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 256)) fail("invalid_schema", "Invalid enum");
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    const number = schema[key];
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number) || ((key.endsWith("Length") || key.endsWith("Items")) && (!Number.isInteger(number) || number < 0)))) fail("invalid_schema", `Invalid ${key}`);
  }
  for (const [min, max] of [["minimum", "maximum"], ["minLength", "maxLength"], ["minItems", "maxItems"]]) {
    if (typeof schema[min!] === "number" && typeof schema[max!] === "number" && (schema[min!] as number) > (schema[max!] as number)) fail("invalid_schema", "Schema minimum exceeds maximum");
  }
  assertJson(schema);
}
function stable(value: unknown): string { return JSON.stringify(value, (_, v) => isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v); }
export function validateValue(schema: ImageSchema | undefined, value: unknown, path = "$", depth = 0): void {
  if (depth === 0) assertJson(value);
  if (!schema) return;
  if (depth > 64) fail("schema_mismatch", "Value nesting exceeds limits");
  const mismatch = (rule: string): never => fail("schema_mismatch", `${path}: ${rule}`);
  if (schema.enum && !schema.enum.some(v => stable(v) === stable(value))) mismatch("not in enum");
  const type = schema.type;
  if (type === "object" && !isRecord(value) || type === "array" && !Array.isArray(value) || type === "null" && value !== null || type === "integer" && (typeof value !== "number" || !Number.isInteger(value)) || type && ["string", "number", "boolean"].includes(type) && typeof value !== type) mismatch(`expected ${type}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) mismatch("below minimum");
    if (schema.maximum !== undefined && value > schema.maximum) mismatch("above maximum");
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) mismatch("too short");
    if (schema.maxLength !== undefined && length > schema.maxLength) mismatch("too long");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) mismatch("too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) mismatch("too many items");
    value.forEach((entry, i) => validateValue(schema.items, entry, `${path}[${i}]`, depth + 1));
  }
  if (isRecord(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) mismatch(`missing required property ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      const sub = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (!sub && schema.additionalProperties === false) mismatch(`unknown property ${key}`);
      validateValue(sub, entry, `${path}.${key}`, depth + 1);
    }
  }
}
