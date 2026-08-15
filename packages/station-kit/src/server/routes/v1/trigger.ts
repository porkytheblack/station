import { Hono } from "hono";
import type { SignalRunner, SignalQueueAdapter } from "station-signal";
import type { BroadcastRunner, BroadcastQueueAdapter } from "station-broadcast";
import type { StationSignalSubscriber } from "../../subscriber.js";
import type { StationNetworkAdapter } from "station-network";

export interface V1TriggerDeps {
  signalRunner?: SignalRunner;
  signalAdapter: SignalQueueAdapter;
  broadcastRunner?: BroadcastRunner;
  broadcastAdapter?: BroadcastQueueAdapter;
  signalSubscriber?: StationSignalSubscriber;
  networkAdapter?: StationNetworkAdapter;
  networkId?: string;
}

export function v1TriggerRoutes(deps: V1TriggerDeps) {
  const app = new Hono();

  app.post("/trigger", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.signalName !== "string" || body.signalName.trim().length === 0) {
      return c.json({ error: "bad_request", message: "Missing signalName." }, 400);
    }

    const signalName = body.signalName.trim();
    const { input } = body;

    const knownLocally = deps.signalRunner?.hasSignal(signalName) ?? false;
    if (deps.networkAdapter && deps.networkId) {
      await deps.networkAdapter.markOfflineBefore(new Date(), deps.networkId);
    }
    const knownInNetwork = deps.networkAdapter && deps.networkId
      ? (await deps.networkAdapter.listStations({ networkId: deps.networkId, status: "online" }))
          .some((station) => station.definitions.signals.includes(signalName))
      : false;
    if (!knownLocally && !knownInNetwork) {
      return c.json(
        { error: "not_found", message: `Signal "${signalName}" not registered.` },
        404,
      );
    }

    // Resolve maxAttempts and timeout from the signal metadata if available,
    // otherwise fall back to sensible defaults matching the existing dashboard trigger.
    let maxAttempts = 3;
    let timeout = 300_000;

    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getSignalMeta(signalName);
      if (meta) {
        maxAttempts = meta.maxAttempts;
        timeout = meta.timeout;
      }
    }

    const id = deps.signalAdapter.generateId();
    await deps.signalAdapter.addRun({
      id,
      signalName,
      kind: "trigger",
      input: JSON.stringify(input ?? {}),
      status: "pending",
      attempts: 0,
      maxAttempts,
      timeout,
      createdAt: new Date(),
    });

    return c.json(
      {
        data: { id, signalName, status: "pending", createdAt: new Date().toISOString() },
      },
      201,
    );
  });

  app.post("/runs/:id/rerun", async (c) => {
    const id = c.req.param("id");
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

    return c.json(
      { data: { id: newId, signalName: run.signalName, status: "pending", createdAt: new Date().toISOString() } },
      201,
    );
  });

  app.post("/runs/:id/retry", async (c) => {
    const id = c.req.param("id");
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
      stationId: undefined,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
      claimedAt: undefined,
    });

    return c.json({ data: { retried: true } });
  });

  app.post("/trigger-broadcast", async (c) => {
    if (!deps.broadcastRunner) {
      return c.json(
        { error: "unavailable", message: "Broadcast runner not configured." },
        503,
      );
    }

    const body = await c.req.json().catch(() => null);
    if (!body?.broadcastName) {
      return c.json({ error: "bad_request", message: "Missing broadcastName." }, 400);
    }

    const { broadcastName, input } = body;

    if (!deps.broadcastRunner.hasBroadcast(broadcastName)) {
      return c.json(
        { error: "not_found", message: `Broadcast "${broadcastName}" not registered.` },
        404,
      );
    }

    try {
      const id = await deps.broadcastRunner.trigger(broadcastName, input ?? {});
      return c.json(
        {
          data: {
            id,
            broadcastName,
            status: "pending",
            createdAt: new Date().toISOString(),
          },
        },
        201,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "trigger_failed", message }, 400);
    }
  });

  app.post("/trigger-dynamic-broadcast", async (c) => {
    if (!deps.broadcastRunner) {
      return c.json({ error: "unavailable", message: "Broadcast runner not configured." }, 503);
    }
    const body = await c.req.json().catch(() => null);
    if (!body?.broadcastName) {
      return c.json({ error: "bad_request", message: "Missing broadcastName." }, 400);
    }
    const { broadcastName, input } = body;
    if (!deps.broadcastRunner.hasDynamicBroadcast(broadcastName)) {
      return c.json(
        { error: "not_found", message: `Dynamic broadcast "${broadcastName}" not registered.` },
        404,
      );
    }
    try {
      const id = await deps.broadcastRunner.triggerDynamic(broadcastName, input ?? {});
      return c.json(
        { data: { id, broadcastName, status: "pending", createdAt: new Date().toISOString() } },
        201,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "trigger_failed", message }, 400);
    }
  });

  app.post("/broadcast-runs/:id/rerun", async (c) => {
    if (!deps.broadcastRunner || !deps.broadcastAdapter) {
      return c.json({ error: "unavailable", message: "Broadcast runner not configured." }, 503);
    }
    const id = c.req.param("id");
    const run = await deps.broadcastAdapter.getBroadcastRun(id);
    if (!run) {
      return c.json({ error: "not_found", message: "Broadcast run not found." }, 404);
    }
    if (run.status !== "failed" && run.status !== "completed" && run.status !== "cancelled") {
      return c.json({ error: "invalid_status", message: "Only failed, completed, or cancelled broadcast runs can be rerun." }, 400);
    }

    try {
      const input = typeof run.input === "string" ? JSON.parse(run.input) : run.input;
      const newId = await deps.broadcastRunner.trigger(run.broadcastName, input);
      return c.json(
        { data: { id: newId, broadcastName: run.broadcastName, status: "pending", createdAt: new Date().toISOString() } },
        201,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "rerun_failed", message }, 400);
    }
  });

  return app;
}
