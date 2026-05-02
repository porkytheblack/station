import type {
  ExprNode,
  SchemaField,
  ValidationContext,
  ValidationError,
  ValidationResult,
  BinaryOp,
  UnaryOp,
} from "./ast.js";

const ANY: SchemaField = { type: "any" };

const COMPARISON_OPS = new Set<BinaryOp>(["==", "!=", ">", "<", ">=", "<="]);
const ARITH_OPS = new Set<BinaryOp>(["+", "-", "*", "/"]);
const LOGIC_OPS = new Set<BinaryOp>(["&&", "||"]);

export function validate(node: ExprNode, ctx: ValidationContext): ValidationResult {
  const errors: ValidationError[] = [];
  const inferred = inferSchema(node, ctx, "$", errors);

  if (ctx.expectedSchema) {
    checkAssignable(inferred, ctx.expectedSchema, "$", errors);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Walk the AST, infer the type of each node, and accumulate errors.
 * `errors` is an out-parameter.
 */
function inferSchema(
  node: ExprNode,
  ctx: ValidationContext,
  path: string,
  errors: ValidationError[],
): SchemaField {
  switch (node.kind) {
    case "lit": {
      const v = node.value;
      if (v === null) return { type: "null" };
      if (typeof v === "string") return { type: "string" };
      if (typeof v === "number") return { type: "number" };
      if (typeof v === "boolean") return { type: "boolean" };
      if (Array.isArray(v)) return { type: "array" };
      if (typeof v === "object") return { type: "object" };
      return ANY;
    }

    case "ref":
      return resolveRefSchema(node.path, ctx, path, errors);

    case "tmpl": {
      for (let i = 0; i < node.parts.length; i++) {
        const p = node.parts[i];
        if (typeof p !== "string") {
          inferSchema(p, ctx, `${path}.parts[${i}]`, errors);
        }
      }
      return { type: "string" };
    }

    case "obj": {
      const properties: Record<string, SchemaField> = {};
      for (const [key, sub] of Object.entries(node.entries)) {
        properties[key] = inferSchema(sub, ctx, `${path}.${key}`, errors);
      }
      return { type: "object", properties };
    }

    case "arr": {
      const items: SchemaField[] = node.items.map((it, i) =>
        inferSchema(it, ctx, `${path}[${i}]`, errors),
      );
      const merged = items.length > 0 ? unify(items) : undefined;
      return { type: "array", items: merged };
    }

    case "op":
      return inferOpSchema(node.op, node.args, ctx, path, errors);
  }
}

function inferOpSchema(
  op: BinaryOp | UnaryOp,
  args: ExprNode[],
  ctx: ValidationContext,
  path: string,
  errors: ValidationError[],
): SchemaField {
  const argSchemas = args.map((a, i) => inferSchema(a, ctx, `${path}.args[${i}]`, errors));

  if (op === "!") {
    if (args.length !== 1) {
      errors.push({ path, message: `Operator "!" requires exactly 1 argument` });
    }
    return { type: "boolean" };
  }

  if (LOGIC_OPS.has(op as BinaryOp)) {
    return { type: "boolean" };
  }

  if (COMPARISON_OPS.has(op as BinaryOp)) {
    if (args.length !== 2) {
      errors.push({ path, message: `Operator "${op}" requires exactly 2 arguments` });
    }
    return { type: "boolean" };
  }

  if (ARITH_OPS.has(op as BinaryOp)) {
    if (args.length !== 2) {
      errors.push({ path, message: `Operator "${op}" requires exactly 2 arguments` });
    }
    if (op === "+") {
      // String OR number
      const isString = argSchemas.some((s) => s.type === "string");
      return { type: isString ? "string" : "number" };
    }
    return { type: "number" };
  }

  errors.push({ path, message: `Unknown operator "${op}"` });
  return ANY;
}

function resolveRefSchema(
  refPath: string[],
  ctx: ValidationContext,
  exprPath: string,
  errors: ValidationError[],
): SchemaField {
  if (refPath.length === 0) {
    errors.push({ path: exprPath, message: "Empty reference path" });
    return ANY;
  }
  const root = refPath[0];
  let cur: SchemaField;
  if (root === "input") {
    cur = ctx.inputSchema;
  } else if (root === "upstream") {
    if (refPath.length === 1) {
      // `upstream` itself — object whose keys are node names
      const properties: Record<string, SchemaField> = {};
      for (const [k, v] of Object.entries(ctx.upstreamSchemas)) properties[k] = v;
      return { type: "object", properties };
    }
    const nodeName = refPath[1];
    if (!Object.prototype.hasOwnProperty.call(ctx.upstreamSchemas, nodeName)) {
      errors.push({
        path: exprPath,
        message: `Reference to unknown upstream node "${nodeName}"`,
      });
      return ANY;
    }
    cur = ctx.upstreamSchemas[nodeName];
    return walkPath(cur, refPath.slice(2), exprPath, errors);
  } else if (Object.prototype.hasOwnProperty.call(ctx.upstreamSchemas, root)) {
    cur = ctx.upstreamSchemas[root];
  } else {
    errors.push({
      path: exprPath,
      message: `Reference root "${root}" is not "input" or a known upstream node name`,
    });
    return ANY;
  }
  return walkPath(cur, refPath.slice(1), exprPath, errors);
}

function walkPath(
  start: SchemaField,
  rest: string[],
  exprPath: string,
  errors: ValidationError[],
): SchemaField {
  let cur: SchemaField = start;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (cur.type === "any" || cur.type === "unknown") return ANY;
    if (cur.type === "object") {
      if (cur.properties && Object.prototype.hasOwnProperty.call(cur.properties, key)) {
        cur = cur.properties[key];
      } else if (cur.additionalProperties) {
        return ANY;
      } else {
        errors.push({
          path: exprPath,
          message: `Property "${key}" not found at ${rest.slice(0, i + 1).join(".")}`,
        });
        return ANY;
      }
    } else {
      errors.push({
        path: exprPath,
        message: `Cannot access "${key}" on non-object type "${cur.type}"`,
      });
      return ANY;
    }
  }
  return cur;
}

function checkAssignable(
  actual: SchemaField,
  expected: SchemaField,
  path: string,
  errors: ValidationError[],
): void {
  if (expected.type === "any" || expected.type === "unknown") return;
  if (actual.type === "any" || actual.type === "unknown") return;

  if (expected.type === "union") {
    // Pass if any branch matches; collect errors only if none do.
    const subErrors: ValidationError[] = [];
    for (const opt of expected.options) {
      const tmp: ValidationError[] = [];
      checkAssignable(actual, opt, path, tmp);
      if (tmp.length === 0) return;
      subErrors.push(...tmp);
    }
    errors.push({ path, message: `Type does not match any union option (${subErrors.map((e) => e.message).join("; ")})` });
    return;
  }

  if (actual.type !== expected.type) {
    // Number ↔ string coercion is intentionally not allowed; user must explicitly cast.
    errors.push({
      path,
      message: `Type mismatch: expected "${expected.type}", got "${actual.type}"`,
    });
    return;
  }

  if (expected.type === "object" && actual.type === "object" && expected.properties) {
    for (const [key, subExpected] of Object.entries(expected.properties)) {
      const subActual = actual.properties?.[key];
      if (!subActual) {
        errors.push({ path: `${path}.${key}`, message: `Missing required property "${key}"` });
      } else {
        checkAssignable(subActual, subExpected, `${path}.${key}`, errors);
      }
    }
  }

  if (expected.type === "array" && actual.type === "array" && expected.items && actual.items) {
    checkAssignable(actual.items, expected.items, `${path}[*]`, errors);
  }
}

/** Best-effort merge of multiple schemas — yields `any` if heterogenous. */
function unify(schemas: SchemaField[]): SchemaField {
  if (schemas.length === 0) return ANY;
  const first = schemas[0];
  for (let i = 1; i < schemas.length; i++) {
    if (schemas[i].type !== first.type) return ANY;
  }
  return first;
}
