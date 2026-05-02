import { Hono } from "hono";
import {
  evaluate,
  validate,
  parse,
  ExpressionEvalError,
  ExpressionParseError,
  type ExprNode,
  type SchemaField,
} from "station-expressions";

export function v1ExpressionRoutes() {
  const app = new Hono();

  app.post("/expressions/evaluate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { node, context } = body as {
      node?: ExprNode;
      context?: { input?: unknown; upstream?: Record<string, unknown> };
    };
    if (!node) {
      return c.json({ error: "bad_request", message: "Missing `node`." }, 400);
    }
    try {
      const result = evaluate(node, {
        input: context?.input,
        upstream: context?.upstream ?? {},
      });
      return c.json({ data: { value: result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ExpressionEvalError ? 400 : 500;
      return c.json({ error: "evaluation_failed", message }, status);
    }
  });

  app.post("/expressions/validate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { node, schemaContext } = body as {
      node?: ExprNode;
      schemaContext?: {
        inputSchema?: SchemaField;
        upstreamSchemas?: Record<string, SchemaField>;
        expectedSchema?: SchemaField;
      };
    };
    if (!node) {
      return c.json({ error: "bad_request", message: "Missing `node`." }, 400);
    }
    const result = validate(node, {
      inputSchema: schemaContext?.inputSchema ?? { type: "any" },
      upstreamSchemas: schemaContext?.upstreamSchemas ?? {},
      expectedSchema: schemaContext?.expectedSchema,
    });
    return c.json({ data: result });
  });

  app.post("/expressions/parse", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { source } = body as { source?: string };
    if (typeof source !== "string") {
      return c.json({ error: "bad_request", message: "Missing `source` string." }, 400);
    }
    try {
      const node = parse(source);
      return c.json({ data: { node } });
    } catch (err) {
      if (err instanceof ExpressionParseError) {
        return c.json({ error: "parse_error", message: err.message, position: err.position }, 400);
      }
      return c.json({ error: "parse_error", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
