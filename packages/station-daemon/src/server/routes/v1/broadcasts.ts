import { Hono } from "hono";
import type { BroadcastRunner, BroadcastQueueAdapter, BroadcastRun } from "station-broadcast";
import type { StationBroadcastSubscriber } from "../../subscriber.js";

export interface V1BroadcastDeps {
  broadcastRunner?: BroadcastRunner;
  broadcastAdapter?: BroadcastQueueAdapter;
  broadcastSubscriber?: StationBroadcastSubscriber;
}

export function v1BroadcastRoutes(deps: V1BroadcastDeps) {
  const app = new Hono();

  app.get("/broadcasts", async (c) => {
    if (deps.broadcastSubscriber) {
      const meta = deps.broadcastSubscriber.getAllBroadcastMeta();
      if (meta.length > 0) return c.json({ data: meta });
    }

    if (!deps.broadcastRunner) return c.json({ data: [] });

    // BroadcastRunner.listRegistered() returns { name, nodeCount, failurePolicy, timeout?, interval? }
    const result = deps.broadcastRunner.listRegistered();
    return c.json({ data: result });
  });

  app.get("/broadcasts/:name", async (c) => {
    const name = c.req.param("name");

    if (deps.broadcastSubscriber) {
      const meta = deps.broadcastSubscriber.getBroadcastMeta(name);
      if (meta) return c.json({ data: meta });
    }

    if (deps.broadcastRunner) {
      const entry = deps.broadcastRunner.listRegistered().find((b) => b.name === name);
      if (entry) return c.json({ data: entry });
    }

    return c.json({ error: "not_found", message: `Broadcast "${name}" not found.` }, 404);
  });

  app.get("/broadcast-runs/:id", async (c) => {
    if (!deps.broadcastAdapter) {
      return c.json({ error: "unavailable", message: "No broadcast adapter configured." }, 503);
    }
    const id = c.req.param("id");
    const run = await deps.broadcastAdapter.getBroadcastRun(id);
    if (!run) {
      return c.json({ error: "not_found", message: "Broadcast run not found." }, 404);
    }
    return c.json({ data: serializeBroadcastRun(run) });
  });

  app.get("/broadcast-runs/:id/nodes", async (c) => {
    if (!deps.broadcastAdapter) {
      return c.json({ error: "unavailable", message: "No broadcast adapter configured." }, 503);
    }
    const id = c.req.param("id");
    const nodes = await deps.broadcastAdapter.getNodeRuns(id);
    return c.json({
      data: nodes.map((n) => ({
        ...n,
        startedAt: n.startedAt?.toISOString?.() ?? n.startedAt,
        completedAt: n.completedAt?.toISOString?.() ?? n.completedAt,
      })),
    });
  });

  // Cancel endpoint is not included here — it requires "cancel" scope
  // and is mounted separately in the server wiring.

  return app;
}

function serializeBroadcastRun(run: BroadcastRun): Record<string, unknown> {
  return {
    ...run,
    nextRunAt: run.nextRunAt?.toISOString?.() ?? run.nextRunAt,
    startedAt: run.startedAt?.toISOString?.() ?? run.startedAt,
    completedAt: run.completedAt?.toISOString?.() ?? run.completedAt,
    createdAt: run.createdAt?.toISOString?.() ?? run.createdAt,
  };
}
