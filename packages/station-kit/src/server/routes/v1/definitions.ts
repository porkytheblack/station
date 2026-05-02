import { Hono } from "hono";
import type {
  BroadcastRunner,
  BroadcastQueueAdapter,
  DynamicBroadcastSpec,
} from "station-broadcast";
import { validateDynamicSpec, type DynamicValidationContext } from "station-broadcast";
import type { SignalRunner } from "station-signal";
import type { SchemaField } from "station-expressions";
import type { StationSignalSubscriber } from "../../subscriber.js";

export interface V1DefinitionDeps {
  broadcastRunner?: BroadcastRunner;
  broadcastAdapter?: BroadcastQueueAdapter;
  signalRunner?: SignalRunner;
  signalSubscriber?: StationSignalSubscriber;
}

/**
 * v1 routes for dynamic broadcast definition CRUD + validation.
 * Static (file-defined) broadcasts live under /broadcasts and are
 * intentionally separate.
 */
export function v1DefinitionRoutes(deps: V1DefinitionDeps) {
  const app = new Hono();

  app.post("/broadcast-definitions/validate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const spec = body as DynamicBroadcastSpec;
    if (!spec || typeof spec !== "object" || typeof spec.name !== "string") {
      return c.json({ error: "bad_request", message: "Spec is missing required fields." }, 400);
    }
    const ctx = buildValidationContext(deps);
    const result = validateDynamicSpec(spec, ctx);
    return c.json({ data: result });
  });

  app.post("/broadcast-definitions", async (c) => {
    if (!deps.broadcastAdapter?.saveDefinition) {
      return c.json({ error: "unavailable", message: "Broadcast adapter does not support dynamic definitions." }, 503);
    }
    const body = await c.req.json().catch(() => ({}));
    const incoming = body as DynamicBroadcastSpec;
    if (!incoming?.name || !Array.isArray(incoming.nodes)) {
      return c.json({ error: "bad_request", message: "Spec is missing required fields." }, 400);
    }

    const ctx = buildValidationContext(deps);
    const validation = validateDynamicSpec(incoming, ctx);
    if (!validation.ok) {
      return c.json({ error: "validation_failed", data: validation }, 422);
    }

    const apiKeyId = c.get("apiKeyId" as never) as string | undefined;
    const now = new Date();
    const toSave: DynamicBroadcastSpec = {
      ...incoming,
      version: 0,
      createdAt: incoming.createdAt ?? now,
      updatedAt: now,
      createdBy: apiKeyId,
      failurePolicy: incoming.failurePolicy ?? "fail-fast",
    };

    const saved = await deps.broadcastAdapter.saveDefinition(toSave);

    // Trigger an eager reconciliation so the new version is live immediately.
    if (deps.broadcastRunner) {
      void deps.broadcastRunner.reconcileDynamicDefinitions().catch(() => {});
    }

    return c.json({ data: serializeSpec(saved) }, 201);
  });

  app.get("/broadcast-definitions", async (c) => {
    if (!deps.broadcastAdapter?.listDefinitions) {
      return c.json({ data: [] });
    }
    const specs = await deps.broadcastAdapter.listDefinitions();
    return c.json({ data: specs.map(serializeSpec) });
  });

  app.get("/broadcast-definitions/:name", async (c) => {
    if (!deps.broadcastAdapter?.getDefinition) {
      return c.json({ error: "unavailable" }, 503);
    }
    const spec = await deps.broadcastAdapter.getDefinition(c.req.param("name"));
    if (!spec) return c.json({ error: "not_found" }, 404);
    return c.json({ data: serializeSpec(spec) });
  });

  app.get("/broadcast-definitions/:name/versions", async (c) => {
    if (!deps.broadcastAdapter?.listDefinitionVersions) {
      return c.json({ data: [] });
    }
    const versions = await deps.broadcastAdapter.listDefinitionVersions(c.req.param("name"));
    return c.json({ data: versions.map(serializeSpec) });
  });

  app.get("/broadcast-definitions/:name/versions/:n", async (c) => {
    if (!deps.broadcastAdapter?.getDefinition) {
      return c.json({ error: "unavailable" }, 503);
    }
    const version = parseInt(c.req.param("n"), 10);
    if (Number.isNaN(version)) {
      return c.json({ error: "bad_request", message: "Version must be a number." }, 400);
    }
    const spec = await deps.broadcastAdapter.getDefinition(c.req.param("name"), version);
    if (!spec) return c.json({ error: "not_found" }, 404);
    return c.json({ data: serializeSpec(spec) });
  });

  app.delete("/broadcast-definitions/:name", async (c) => {
    if (!deps.broadcastAdapter?.deleteDefinition) {
      return c.json({ error: "unavailable" }, 503);
    }
    const success = await deps.broadcastAdapter.deleteDefinition(c.req.param("name"));
    if (!success) return c.json({ error: "not_found" }, 404);
    if (deps.broadcastRunner) {
      void deps.broadcastRunner.reconcileDynamicDefinitions().catch(() => {});
    }
    return c.json({ data: { deleted: true } });
  });

  return app;
}

function serializeSpec(spec: DynamicBroadcastSpec): Record<string, unknown> {
  return {
    ...spec,
    createdAt: spec.createdAt?.toISOString?.() ?? spec.createdAt,
    updatedAt: spec.updatedAt?.toISOString?.() ?? spec.updatedAt,
    deletedAt: spec.deletedAt?.toISOString?.() ?? spec.deletedAt,
  };
}

function buildValidationContext(deps: V1DefinitionDeps): DynamicValidationContext {
  const signalSchemas = new Map<string, { inputSchema: SchemaField; outputSchema: SchemaField }>();
  // Best-effort schema reflection: we don't know the precise SchemaField for
  // each signal here without traversing Zod schemas. Use `any` for now — the
  // structural checks (signal exists, deps exist, no cycles, expression
  // wellformedness) still run. Zod input validation runs at trigger time.
  const sigs = deps.signalRunner?.getAllSignals();
  if (sigs) {
    for (const name of sigs.keys()) {
      signalSchemas.set(name, {
        inputSchema: { type: "any" },
        outputSchema: { type: "any" },
      });
    }
  } else if (deps.signalSubscriber) {
    for (const meta of deps.signalSubscriber.getAllSignalMeta()) {
      signalSchemas.set(meta.name, {
        inputSchema: { type: "any" },
        outputSchema: { type: "any" },
      });
    }
  }
  return { signalSchemas };
}
