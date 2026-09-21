import { Hono } from "hono";
import type { SignalRunner, SignalQueueAdapter, Run, RunStatus } from "station-signal";
import type { LogBuffer } from "../../log-buffer.js";
import type { LogStore } from "../../log-store.js";

export interface V1RunDeps {
  signalRunner?: SignalRunner;
  signalAdapter: SignalQueueAdapter;
  logBuffer: LogBuffer;
  logStore?: LogStore;
}

// Cancel endpoint is not included here — it requires "cancel" scope
// and is mounted separately in the server wiring.

export function v1RunRoutes(deps: V1RunDeps) {
  const app = new Hono();

  app.get("/runs", async (c) => {
    const status = c.req.query("status");
    const signalName = c.req.query("signalName");
    const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Math.min(Number.isNaN(limitRaw) ? 50 : Math.max(limitRaw, 1), 200);
    const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(offsetRaw, 0);
    const statuses = status ? ([status] as RunStatus[]) : undefined;

    // Filtering/ordering/limiting happen in the adapter, not in memory.
    const runs: Run[] = signalName
      ? await deps.signalAdapter.listRuns(signalName, { limit, offset, statuses })
      : await deps.signalAdapter.listAllRuns({ limit, offset, statuses });

    return c.json({ data: runs.map(serializeRun), meta: { count: runs.length, limit, offset } });
  });

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await deps.signalAdapter.getRun(id);
    if (!run) return c.json({ error: "not_found", message: "Run not found." }, 404);
    return c.json({ data: serializeRun(run) });
  });

  app.get("/runs/:id/steps", async (c) => {
    const id = c.req.param("id");
    const steps = await deps.signalAdapter.getSteps(id);
    return c.json({
      data: steps.map((s) => ({
        ...s,
        startedAt: s.startedAt?.toISOString?.() ?? s.startedAt,
        completedAt: s.completedAt?.toISOString?.() ?? s.completedAt,
      })),
    });
  });

  app.get("/runs/:id/logs", async (c) => {
    const id = c.req.param("id");
    const logs = deps.logStore ? await deps.logStore.get(id) : deps.logBuffer.get(id);
    return c.json({ data: logs });
  });

  return app;
}

function serializeRun(run: Run): Record<string, unknown> {
  return {
    ...run,
    nextRunAt: run.nextRunAt?.toISOString?.() ?? run.nextRunAt,
    lastRunAt: run.lastRunAt?.toISOString?.() ?? run.lastRunAt,
    startedAt: run.startedAt?.toISOString?.() ?? run.startedAt,
    completedAt: run.completedAt?.toISOString?.() ?? run.completedAt,
    createdAt: run.createdAt?.toISOString?.() ?? run.createdAt,
  };
}
