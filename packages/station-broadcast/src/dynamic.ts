import type { AnySignal } from "station-signal";
import {
  evaluate,
  validate as validateExpression,
  type ExprNode,
  type SchemaField,
  type ValidationResult as ExprValidationResult,
} from "station-expressions";
import type { BroadcastDefinition, BroadcastNode, NodeEvalContext } from "./broadcast.js";
import { BROADCAST_BRAND, topologicalSort } from "./util.js";
import type { DynamicBroadcastSpec, DynamicNodeSpec } from "./types.js";
import { getBroadcastAdapter } from "./config.js";

/**
 * The runner's representation of a registered dynamic broadcast: the
 * materialized DAG plus the spec and version it was built from.
 */
export interface MaterializedDynamicBroadcast {
  readonly spec: DynamicBroadcastSpec;
  readonly definition: BroadcastDefinition;
}

/**
 * Build a runtime-usable BroadcastDefinition from a DynamicBroadcastSpec.
 * Throws if any signal name is unknown — callers should validate first.
 */
export function materializeDynamic(
  spec: DynamicBroadcastSpec,
  signalRegistry: Map<string, AnySignal>,
): MaterializedDynamicBroadcast {
  const nodes: BroadcastNode[] = spec.nodes.map((n) => buildNode(n, signalRegistry, spec.name));

  // Validate the resulting DAG (throws on cycles or missing deps).
  const nodeNames = new Set(nodes.map((n) => n.name));
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      if (!nodeNames.has(dep)) {
        throw new Error(
          `Dynamic broadcast "${spec.name}" node "${n.name}" depends on unknown node "${dep}"`,
        );
      }
    }
  }
  topologicalSort(spec.name, nodes);

  const definition: BroadcastDefinition = {
    [BROADCAST_BRAND]: true as const,
    name: spec.name,
    nodes,
    failurePolicy: spec.failurePolicy,
    timeout: spec.timeout,
    interval: undefined,
    recurringInput: undefined,
    async trigger(input: unknown): Promise<string> {
      // Snapshot-on-trigger lives in BroadcastRunner.triggerDynamic; this fallback
      // mirrors the static path so direct calls still work in single-process tests.
      const adapter = getBroadcastAdapter();
      const id = adapter.generateId();
      await adapter.addBroadcastRun({
        id,
        broadcastName: spec.name,
        input: JSON.stringify(input),
        status: "pending",
        failurePolicy: spec.failurePolicy,
        timeout: spec.timeout,
        createdAt: new Date(),
        definitionSnapshot: JSON.stringify(spec),
      });
      return id;
    },
  };
  return { spec, definition };
}

function buildNode(
  spec: DynamicNodeSpec,
  signalRegistry: Map<string, AnySignal>,
  broadcastName: string,
): BroadcastNode {
  const signal = signalRegistry.get(spec.signalName);
  if (!signal) {
    throw new Error(
      `Dynamic broadcast "${broadcastName}" references unregistered signal "${spec.signalName}"`,
    );
  }
  const inputExpr = spec.input as ExprNode | undefined;
  const whenExpr = spec.when as ExprNode | undefined;

  return {
    name: spec.name,
    signalName: spec.signalName,
    signal,
    dependsOn: [...spec.dependsOn],
    timeout: signal.timeout,
    maxAttempts: signal.maxAttempts,
    evalInput: inputExpr
      ? (ctx: NodeEvalContext) => evaluate(inputExpr, ctx)
      : undefined,
    evalGuard: whenExpr
      ? (ctx: NodeEvalContext) => Boolean(evaluate(whenExpr, ctx))
      : undefined,
  };
}

// ─── Validation ──────────────────────────────────────────────────────

export interface SignalSchemas {
  inputSchema: SchemaField;
  outputSchema: SchemaField;
}

export interface DynamicValidationContext {
  /** Map signal name → input/output schemas. */
  signalSchemas: Map<string, SignalSchemas>;
  /**
   * Schema for the broadcast's trigger input. When omitted, refs to `input.*`
   * are not type-checked but are not flagged as errors either.
   */
  broadcastInputSchema?: SchemaField;
}

export interface DynamicValidationError {
  /** node name, or `"$"` for spec-level errors. */
  node: string;
  /** sub-path within the node (e.g. "input", "when", "dependsOn") */
  field?: string;
  message: string;
}

export interface DynamicValidationResult {
  ok: boolean;
  errors: DynamicValidationError[];
}

const ANY_SCHEMA: SchemaField = { type: "any" };

export function validateDynamicSpec(
  spec: DynamicBroadcastSpec,
  ctx: DynamicValidationContext,
): DynamicValidationResult {
  const errors: DynamicValidationError[] = [];

  // 1. Node names unique
  const seenNames = new Set<string>();
  for (const n of spec.nodes) {
    if (seenNames.has(n.name)) {
      errors.push({ node: n.name, message: `Duplicate node name "${n.name}"` });
    }
    seenNames.add(n.name);
  }

  // 2. Signals exist
  for (const n of spec.nodes) {
    if (!ctx.signalSchemas.has(n.signalName)) {
      errors.push({
        node: n.name,
        field: "signalName",
        message: `Signal "${n.signalName}" is not registered`,
      });
    }
  }

  // 3. Dependencies exist
  for (const n of spec.nodes) {
    for (const dep of n.dependsOn) {
      if (!seenNames.has(dep)) {
        errors.push({
          node: n.name,
          field: "dependsOn",
          message: `Depends on unknown node "${dep}"`,
        });
      }
    }
  }

  // 4. Cycle detection — only when nodes/deps look structurally sound
  if (errors.length === 0) {
    try {
      topologicalSort(spec.name, spec.nodes);
    } catch (err) {
      errors.push({
        node: "$",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Per-node expression validation
  for (const node of spec.nodes) {
    const upstreamSchemas: Record<string, SchemaField> = {};
    for (const dep of node.dependsOn) {
      const depNode = spec.nodes.find((n) => n.name === dep);
      if (!depNode) continue;
      const depSchemas = ctx.signalSchemas.get(depNode.signalName);
      upstreamSchemas[dep] = depSchemas?.outputSchema ?? ANY_SCHEMA;
    }
    const sigSchemas = ctx.signalSchemas.get(node.signalName);
    const expectedSchema = sigSchemas?.inputSchema;

    if (node.input !== undefined) {
      const result = validateExpression(node.input as ExprNode, {
        inputSchema: ctx.broadcastInputSchema ?? ANY_SCHEMA,
        upstreamSchemas,
        expectedSchema,
      });
      pushExprErrors(errors, node.name, "input", result);
    }

    if (node.when !== undefined) {
      const result = validateExpression(node.when as ExprNode, {
        inputSchema: ctx.broadcastInputSchema ?? ANY_SCHEMA,
        upstreamSchemas,
        expectedSchema: { type: "boolean" },
      });
      pushExprErrors(errors, node.name, "when", result);
    }
  }

  return { ok: errors.length === 0, errors };
}

function pushExprErrors(
  errors: DynamicValidationError[],
  nodeName: string,
  field: string,
  result: ExprValidationResult,
): void {
  for (const e of result.errors) {
    errors.push({ node: nodeName, field, message: `${e.path}: ${e.message}` });
  }
}
