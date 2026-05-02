export type BinaryOp =
  | "=="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "&&"
  | "||"
  | "+"
  | "-"
  | "*"
  | "/";
export type UnaryOp = "!";

export type ExprNode =
  | { kind: "ref"; path: string[] }
  | { kind: "lit"; value: unknown }
  | { kind: "tmpl"; parts: (string | ExprNode)[] }
  | { kind: "op"; op: BinaryOp | UnaryOp; args: ExprNode[] }
  | { kind: "obj"; entries: Record<string, ExprNode> }
  | { kind: "arr"; items: ExprNode[] };

/**
 * Schema field used by the validator. Mirrors the shape produced by
 * Station's existing `inputSchema` / `outputSchema` reflection.
 */
export type SchemaField =
  | { type: "string" | "number" | "boolean" | "null" | "any" | "unknown" }
  | { type: "array"; items?: SchemaField }
  | { type: "object"; properties?: Record<string, SchemaField>; additionalProperties?: boolean }
  | { type: "union"; options: SchemaField[] };

export interface EvalContext {
  /** The broadcast's trigger input. */
  input: unknown;
  /** Outputs of upstream nodes, keyed by node name. */
  upstream: Record<string, unknown>;
}

export interface ValidationContext {
  /** Schema for the broadcast's trigger input (root reference: `input.*`). */
  inputSchema: SchemaField;
  /** Schemas for each upstream node's output, keyed by node name. */
  upstreamSchemas: Record<string, SchemaField>;
  /** When validating an `input` mapping, the target signal's input schema. */
  expectedSchema?: SchemaField;
}

export interface ValidationError {
  /** Dotted path from the root of the expression node where the error occurred. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}
