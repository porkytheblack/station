import type { ExprNode, EvalContext } from "./ast.js";

const MAX_NODES = 10_000;

export class ExpressionEvalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionEvalError";
  }
}

interface EvalState {
  count: number;
}

export function evaluate(node: ExprNode, ctx: EvalContext): unknown {
  const state: EvalState = { count: 0 };
  return evalNode(node, ctx, state);
}

function evalNode(node: ExprNode, ctx: EvalContext, state: EvalState): unknown {
  if (++state.count > MAX_NODES) {
    throw new ExpressionEvalError(`Expression evaluation exceeded ${MAX_NODES} nodes`);
  }

  switch (node.kind) {
    case "lit":
      return node.value;

    case "ref":
      return resolveRef(node.path, ctx);

    case "tmpl": {
      let out = "";
      for (const part of node.parts) {
        if (typeof part === "string") {
          out += part;
        } else {
          const v = evalNode(part, ctx, state);
          out += v === undefined || v === null ? "" : String(v);
        }
      }
      return out;
    }

    case "obj": {
      const result: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(node.entries)) {
        result[key] = evalNode(sub, ctx, state);
      }
      return result;
    }

    case "arr":
      return node.items.map((it) => evalNode(it, ctx, state));

    case "op":
      return evalOp(node.op, node.args, ctx, state);
  }
}

function resolveRef(path: string[], ctx: EvalContext): unknown {
  if (path.length === 0) return undefined;
  const root = path[0];
  let cur: unknown;
  if (root === "input") {
    cur = ctx.input;
  } else if (root === "upstream") {
    cur = ctx.upstream;
  } else {
    // Allow direct upstream node name access: `nodeName.field`
    if (Object.prototype.hasOwnProperty.call(ctx.upstream, root)) {
      cur = ctx.upstream[root];
    } else {
      return undefined;
    }
  }

  for (let i = 1; i < path.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[path[i]];
  }
  return cur;
}

function evalOp(
  op: string,
  args: ExprNode[],
  ctx: EvalContext,
  state: EvalState,
): unknown {
  switch (op) {
    case "!": {
      const v = evalNode(args[0], ctx, state);
      return !v;
    }
    case "&&": {
      // Short-circuit
      for (const a of args) {
        const v = evalNode(a, ctx, state);
        if (!v) return v;
      }
      return args.length > 0 ? evalNode(args[args.length - 1], ctx, state) : true;
    }
    case "||": {
      let last: unknown = false;
      for (const a of args) {
        last = evalNode(a, ctx, state);
        if (last) return last;
      }
      return last;
    }
    case "==":
    case "!=":
    case ">":
    case "<":
    case ">=":
    case "<=":
    case "+":
    case "-":
    case "*":
    case "/": {
      const l = evalNode(args[0], ctx, state);
      const r = evalNode(args[1], ctx, state);
      switch (op) {
        case "==": return l === r;
        case "!=": return l !== r;
        case ">": return (l as number) > (r as number);
        case "<": return (l as number) < (r as number);
        case ">=": return (l as number) >= (r as number);
        case "<=": return (l as number) <= (r as number);
        case "+": {
          if (typeof l === "string" || typeof r === "string") {
            return String(l ?? "") + String(r ?? "");
          }
          return (l as number) + (r as number);
        }
        case "-": return (l as number) - (r as number);
        case "*": return (l as number) * (r as number);
        case "/": return (l as number) / (r as number);
      }
    }
  }
  throw new ExpressionEvalError(`Unknown op: ${op}`);
}
