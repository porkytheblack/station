import { Hono } from "hono";
import type { SignalRunner, SignalQueueAdapter } from "station-signal";
import type { StationSignalSubscriber } from "../subscriber.js";

export interface SignalDeps {
  signalRunner?: SignalRunner;
  signalAdapter: SignalQueueAdapter;
  signalSubscriber?: StationSignalSubscriber;
}

export function signalRoutes(deps: SignalDeps) {
  const app = new Hono();

  // GET /signals — list all signals with metadata
  app.get("/signals", async (c) => {
    // Prefer metadata from subscriber (includes schemas, config)
    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getAllSignalMeta();
      if (meta.length > 0) {
        return c.json({ data: meta });
      }
    }

    // Fallback to registry
    if (!deps.signalRunner) {
      return c.json({ data: [] });
    }
    const result = deps.signalRunner.listRegistered().map(({ name, filePath }) => ({ name, filePath }));
    return c.json({ data: result });
  });

  // GET /signals/scheduled — recurring signals with next/last run info
  app.get("/signals/scheduled", async (c) => {
    const allMeta = deps.signalSubscriber?.getAllSignalMeta() ?? [];
    const recurring = allMeta.filter((s) => s.interval);

    const result: Array<{
      name: string;
      interval: string;
      nextRunAt: string | null;
      lastRunAt: string | null;
      lastStatus: string | null;
    }> = [];

    for (const sig of recurring) {
      // Two bounded queries instead of loading the signal's full history:
      // the current pending run and the most recent non-pending run.
      const [pendingRuns, lastRuns] = await Promise.all([
        deps.signalAdapter.listRuns(sig.name, { limit: 1, statuses: ["pending"] }),
        deps.signalAdapter.listRuns(sig.name, {
          limit: 1,
          statuses: ["running", "completed", "failed", "cancelled"],
        }),
      ]);
      const pendingRun = pendingRuns.find((r) => r.kind === "recurring");
      const lastRun = lastRuns[0];

      result.push({
        name: sig.name,
        interval: sig.interval!,
        nextRunAt: pendingRun?.nextRunAt
          ? (pendingRun.nextRunAt instanceof Date ? pendingRun.nextRunAt.toISOString() : String(pendingRun.nextRunAt))
          : null,
        lastRunAt: lastRun?.completedAt
          ? (lastRun.completedAt instanceof Date ? lastRun.completedAt.toISOString() : String(lastRun.completedAt))
          : lastRun?.startedAt
            ? (lastRun.startedAt instanceof Date ? lastRun.startedAt.toISOString() : String(lastRun.startedAt))
            : null,
        lastStatus: lastRun?.status ?? null,
      });
    }

    return c.json({ data: result });
  });

  // GET /signals/:name — single signal metadata
  app.get("/signals/:name", async (c) => {
    const name = c.req.param("name");

    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getSignalMeta(name);
      if (meta) {
        return c.json({ data: meta });
      }
    }

    // Fallback: check registry
    if (deps.signalRunner) {
      const entry = deps.signalRunner.listRegistered().find((s) => s.name === name);
      if (entry) {
        return c.json({ data: { name, filePath: entry.filePath } });
      }
    }

    return c.json({ error: "not_found", message: `Signal "${name}" not found.` }, 404);
  });

  // POST /signals/:name/trigger
  app.post("/signals/:name/trigger", async (c) => {
    const name = c.req.param("name");
    if (!deps.signalRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }

    if (!deps.signalRunner.hasSignal(name)) {
      return c.json({ error: "not_found", message: `Signal "${name}" not found.` }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const input = body.input ?? {};

    const id = deps.signalAdapter.generateId();
    await deps.signalAdapter.addRun({
      id,
      signalName: name,
      kind: "trigger",
      input: JSON.stringify(input),
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      timeout: 5 * 60 * 1000,
      createdAt: new Date(),
    });

    return c.json({ data: { id } });
  });

  // GET /signals/:name/runs
  app.get("/signals/:name/runs", async (c) => {
    const name = c.req.param("name");
    if (!deps.signalRunner) {
      return c.json({ data: [], meta: { total: 0 } });
    }
    const limitRaw = parseInt(c.req.query("limit") ?? "100", 10);
    const limit = Math.min(Number.isNaN(limitRaw) ? 100 : Math.max(limitRaw, 1), 500);
    const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
    const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(offsetRaw, 0);
    const runs = await deps.signalRunner.listRuns(name, { limit, offset });
    return c.json({
      data: runs.map(serializeRun),
      meta: { count: runs.length, limit, offset },
    });
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
