import { Hono } from "hono";
import type { SignalRunner, SignalQueueAdapter, Run, RunStatus } from "station-signal";
import type { LogBuffer } from "../log-buffer.js";
import type { LogStore } from "../log-store.js";
import type { StationSignalSubscriber } from "../subscriber.js";

export interface RunDeps {
  signalRunner?: SignalRunner;
  signalAdapter: SignalQueueAdapter;
  logBuffer: LogBuffer;
  logStore?: LogStore;
  signalSubscriber?: StationSignalSubscriber;
}

export function runRoutes(deps: RunDeps) {
  const app = new Hono();

  app.get("/runs", async (c) => {
    const status = c.req.query("status");
    const signalName = c.req.query("signalName");
    const limit = clampInt(c.req.query("limit"), 100, 1, 500);
    const offset = clampInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const statuses = status ? ([status] as RunStatus[]) : undefined;

    // Push filtering, ordering, and limiting into the adapter instead of
    // loading every signal's full history and sorting in memory.
    const runs: Run[] = signalName
      ? await deps.signalAdapter.listRuns(signalName, { limit, offset, statuses })
      : await deps.signalAdapter.listAllRuns({ limit, offset, statuses });

    return c.json({
      data: runs.map(serializeRun),
      meta: { count: runs.length, limit, offset },
    });
  });

  app.get("/runs/stats", async (c) => {
    const counts = await deps.signalAdapter.countRunsByStatus();
    const stats = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const key of Object.keys(stats) as RunStatus[]) {
      stats[key as keyof typeof stats] = counts[key] ?? 0;
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
    const logs = deps.logStore ? await deps.logStore.get(id) : deps.logBuffer.get(id);
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

  app.post("/runs/:id/rerun", async (c) => {
    const id = c.req.param("id");
    if (!deps.signalRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }
    const run = await deps.signalAdapter.getRun(id);
    if (!run) {
      return c.json({ error: "not_found", message: "Run not found." }, 404);
    }
    if (run.status !== "failed" && run.status !== "completed" && run.status !== "cancelled") {
      return c.json({ error: "invalid_status", message: "Only failed, completed, or cancelled runs can be rerun." }, 400);
    }

    let maxAttempts = run.maxAttempts;
    let timeout = run.timeout;
    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getSignalMeta(run.signalName);
      if (meta) {
        maxAttempts = meta.maxAttempts;
        timeout = meta.timeout;
      }
    }

    const newId = deps.signalAdapter.generateId();
    await deps.signalAdapter.addRun({
      id: newId,
      signalName: run.signalName,
      kind: "trigger",
      input: run.input,
      status: "pending",
      attempts: 0,
      maxAttempts,
      timeout,
      createdAt: new Date(),
    });

    return c.json({ data: { id: newId, signalName: run.signalName, status: "pending" } });
  });

  app.post("/runs/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (!deps.signalRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }
    const run = await deps.signalAdapter.getRun(id);
    if (!run) {
      return c.json({ error: "not_found", message: "Run not found." }, 404);
    }
    if (run.status !== "failed") {
      return c.json({ error: "invalid_status", message: "Only failed runs can be retried." }, 400);
    }

    let maxAttempts = run.maxAttempts;
    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getSignalMeta(run.signalName);
      if (meta) {
        maxAttempts = meta.maxAttempts;
      }
    }

    await deps.signalAdapter.updateRun(id, {
      status: "pending",
      attempts: 0,
      maxAttempts,
      error: undefined,
      output: undefined,
      startedAt: undefined,
      completedAt: undefined,
      lastRunAt: undefined,
    });

    return c.json({ data: { retried: true } });
  });

  return app;
}

/** Parse an integer query param, clamping to [min, max] with a fallback. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
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
