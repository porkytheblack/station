import { Hono } from "hono";
import type { BroadcastRunner, BroadcastQueueAdapter } from "station-broadcast";
import type { StationBroadcastSubscriber } from "../subscriber.js";

export interface BroadcastDeps {
  broadcastRunner?: BroadcastRunner;
  broadcastAdapter?: BroadcastQueueAdapter;
  broadcastSubscriber?: StationBroadcastSubscriber;
  logBuffer?: import("../log-buffer.js").LogBuffer;
  logStore?: import("../log-store.js").LogStore;
}

export function broadcastRoutes(deps: BroadcastDeps) {
  const app = new Hono();

  // GET /broadcasts — list all broadcasts with metadata
  app.get("/broadcasts", async (c) => {
    if (deps.broadcastSubscriber) {
      const meta = deps.broadcastSubscriber.getAllBroadcastMeta();
      if (meta.length > 0) {
        return c.json({ data: meta });
      }
    }

    // Fallback to registry
    if (!deps.broadcastRunner) {
      return c.json({ data: [] });
    }
    const result = deps.broadcastRunner.listRegistered();
    return c.json({ data: result });
  });

  // GET /broadcasts/:name — single broadcast metadata
  app.get("/broadcasts/:name", async (c) => {
    const name = c.req.param("name");

    if (deps.broadcastSubscriber) {
      const meta = deps.broadcastSubscriber.getBroadcastMeta(name);
      if (meta) {
        return c.json({ data: meta });
      }
    }

    // Fallback: check registry
    if (deps.broadcastRunner) {
      const entry = deps.broadcastRunner.listRegistered().find((b) => b.name === name);
      if (entry) {
        return c.json({ data: entry });
      }
    }

    return c.json({ error: "not_found", message: `Broadcast "${name}" not found.` }, 404);
  });

  // POST /broadcasts/:name/trigger
  app.post("/broadcasts/:name/trigger", async (c) => {
    const name = c.req.param("name");
    if (!deps.broadcastRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const input = body.input ?? {};

    try {
      const id = await deps.broadcastRunner.trigger(name, input);
      return c.json({ data: { id } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "trigger_failed", message }, 400);
    }
  });

  // GET /broadcasts/:name/runs
  app.get("/broadcasts/:name/runs", async (c) => {
    const name = c.req.param("name");
    if (!deps.broadcastAdapter) {
      return c.json({ data: [], meta: { total: 0 } });
    }
    const runs = await deps.broadcastAdapter.listBroadcastRuns(name);
    return c.json({
      data: runs.map(serializeBroadcastRun),
      meta: { total: runs.length },
    });
  });

  // GET /broadcast-runs/:id
  app.get("/broadcast-runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.broadcastAdapter) {
      return c.json({ error: "not_found", message: "No broadcast adapter configured." }, 404);
    }
    const run = await deps.broadcastAdapter.getBroadcastRun(id);
    if (!run) {
      return c.json({ error: "not_found", message: "Broadcast run not found." }, 404);
    }
    return c.json({ data: serializeBroadcastRun(run) });
  });

  // GET /broadcast-runs/:id/nodes
  app.get("/broadcast-runs/:id/nodes", async (c) => {
    const id = c.req.param("id");
    if (!deps.broadcastAdapter) {
      return c.json({ data: [] });
    }
    const nodes = await deps.broadcastAdapter.getNodeRuns(id);
    return c.json({
      data: nodes.map((nr) => ({
        ...nr,
        startedAt: nr.startedAt?.toISOString?.() ?? nr.startedAt,
        completedAt: nr.completedAt?.toISOString?.() ?? nr.completedAt,
      })),
    });
  });

  // GET /broadcast-runs/:id/logs — aggregate logs from all node signal runs
  app.get("/broadcast-runs/:id/logs", async (c) => {
    const id = c.req.param("id");
    if (!deps.broadcastAdapter || (!deps.logStore && !deps.logBuffer)) {
      return c.json({ data: [] });
    }
    const nodes = await deps.broadcastAdapter.getNodeRuns(id);
    const allLogs: Array<{ runId: string; signalName: string; level: string; message: string; timestamp: string; nodeName: string }> = [];
    for (const nr of nodes) {
      if (nr.signalRunId) {
        const logs = deps.logStore?.get(nr.signalRunId) ?? deps.logBuffer?.get(nr.signalRunId) ?? [];
        for (const log of logs) {
          allLogs.push({ ...log, nodeName: nr.nodeName });
        }
      }
    }
    allLogs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return c.json({ data: allLogs });
  });

  // POST /broadcast-runs/:id/cancel
  app.post("/broadcast-runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!deps.broadcastRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }
    const success = await deps.broadcastRunner.cancel(id);
    if (!success) {
      return c.json({ error: "cannot_cancel", message: "Broadcast run cannot be cancelled." }, 400);
    }
    return c.json({ data: { cancelled: true } });
  });

  return app;
}

function serializeBroadcastRun(run: any): Record<string, unknown> {
  return {
    ...run,
    nextRunAt: run.nextRunAt?.toISOString?.() ?? run.nextRunAt,
    startedAt: run.startedAt?.toISOString?.() ?? run.startedAt,
    completedAt: run.completedAt?.toISOString?.() ?? run.completedAt,
    createdAt: run.createdAt?.toISOString?.() ?? run.createdAt,
  };
}
