import { Hono } from "hono";
import type { SignalRunner, SignalQueueAdapter, Run } from "station-signal";
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
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

    let runs: Run[] = [];

    if (signalName) {
      runs = await deps.signalAdapter.listRuns(signalName);
    } else if (deps.signalRunner) {
      const seen = new Set<string>();
      for (const { name } of deps.signalRunner.listRegistered()) {
        const signalRuns = await deps.signalAdapter.listRuns(name);
        for (const r of signalRuns) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            runs.push(r);
          }
        }
      }
    }

    if (status) {
      runs = runs.filter((r) => r.status === status);
    }

    runs.sort((a, b) => {
      const aTime = a.createdAt instanceof Date
        ? a.createdAt.getTime()
        : new Date(a.createdAt as unknown as string).getTime();
      const bTime = b.createdAt instanceof Date
        ? b.createdAt.getTime()
        : new Date(b.createdAt as unknown as string).getTime();
      return bTime - aTime;
    });

    runs = runs.slice(0, limit);

    return c.json({ data: runs.map(serializeRun), meta: { total: runs.length } });
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
    const logs = deps.logStore?.get(id) ?? deps.logBuffer.get(id);
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
