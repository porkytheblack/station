import { Hono } from "hono";
import type { SignalRunner, SignalQueueAdapter } from "station-signal";
import type { LogBuffer } from "../log-buffer.js";
import type { LogStore } from "../log-store.js";

export interface RunDeps {
  signalRunner?: SignalRunner;
  signalAdapter: SignalQueueAdapter;
  logBuffer: LogBuffer;
  logStore?: LogStore;
}

export function runRoutes(deps: RunDeps) {
  const app = new Hono();

  app.get("/runs", async (c) => {
    const status = c.req.query("status");
    const signalName = c.req.query("signalName");

    // Gather runs from adapter
    let runs: any[] = [];

    if (signalName) {
      runs = await deps.signalAdapter.listRuns(signalName);
    } else {
      // Get all runs by combining due + running + listing by known signals
      const due = await deps.signalAdapter.getRunsDue();
      const running = await deps.signalAdapter.getRunsRunning();
      const seen = new Set<string>();
      for (const r of [...due, ...running]) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          runs.push(r);
        }
      }

      // Also get runs from known signals
      if (deps.signalRunner) {
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
    }

    if (status) {
      runs = runs.filter((r) => r.status === status);
    }

    // Sort by createdAt descending
    runs.sort((a, b) => {
      const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(a.createdAt).getTime();
      const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(b.createdAt).getTime();
      return bTime - aTime;
    });

    return c.json({
      data: runs.map(serializeRun),
      meta: { total: runs.length },
    });
  });

  app.get("/runs/stats", async (c) => {
    const due = await deps.signalAdapter.getRunsDue();
    const running = await deps.signalAdapter.getRunsRunning();

    // Aggregate from known signals
    let allRuns: any[] = [...due, ...running];
    const seen = new Set(allRuns.map((r) => r.id));

    if (deps.signalRunner) {
      for (const { name } of deps.signalRunner.listRegistered()) {
        const signalRuns = await deps.signalAdapter.listRuns(name);
        for (const r of signalRuns) {
          if (!seen.has(r.id)) {
            seen.add(r.id);
            allRuns.push(r);
          }
        }
      }
    }

    const stats = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const r of allRuns) {
      if (r.status in stats) {
        stats[r.status as keyof typeof stats]++;
      }
    }

    return c.json({ data: stats });
  });

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await deps.signalAdapter.getRun(id);
    if (!run) {
      return c.json({ error: "not_found", message: "Run not found." }, 404);
    }
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

  app.post("/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!deps.signalRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }
    const success = await deps.signalRunner.cancel(id);
    if (!success) {
      return c.json({ error: "cannot_cancel", message: "Run cannot be cancelled." }, 400);
    }
    return c.json({ data: { cancelled: true } });
  });

  return app;
}

function serializeRun(run: any): Record<string, unknown> {
  return {
    ...run,
    nextRunAt: run.nextRunAt?.toISOString?.() ?? run.nextRunAt,
    lastRunAt: run.lastRunAt?.toISOString?.() ?? run.lastRunAt,
    startedAt: run.startedAt?.toISOString?.() ?? run.startedAt,
    completedAt: run.completedAt?.toISOString?.() ?? run.completedAt,
    createdAt: run.createdAt?.toISOString?.() ?? run.createdAt,
  };
}
