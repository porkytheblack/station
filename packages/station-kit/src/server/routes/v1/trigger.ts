import { Hono } from "hono";
import type { SignalRunner, SignalQueueAdapter } from "station-signal";
import type { BroadcastRunner } from "station-broadcast";
import type { StationSignalSubscriber } from "../../subscriber.js";

export interface V1TriggerDeps {
  signalRunner?: SignalRunner;
  signalAdapter: SignalQueueAdapter;
  broadcastRunner?: BroadcastRunner;
  signalSubscriber?: StationSignalSubscriber;
}

export function v1TriggerRoutes(deps: V1TriggerDeps) {
  const app = new Hono();

  app.post("/trigger", async (c) => {
    if (!deps.signalRunner) {
      return c.json({ error: "unavailable", message: "Station is in read-only mode." }, 503);
    }

    const body = await c.req.json().catch(() => null);
    if (!body?.signalName) {
      return c.json({ error: "bad_request", message: "Missing signalName." }, 400);
    }

    const { signalName, input } = body;

    if (!deps.signalRunner.hasSignal(signalName)) {
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

  return app;
}
