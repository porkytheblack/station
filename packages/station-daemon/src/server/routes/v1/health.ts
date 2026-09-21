import { Hono } from "hono";
import type { SignalQueueAdapter } from "station-signal";
import type { BroadcastQueueAdapter } from "station-broadcast";

export interface V1HealthDeps {
  signalAdapter: SignalQueueAdapter;
  broadcastAdapter?: BroadcastQueueAdapter;
}

export function v1HealthRoutes(deps: V1HealthDeps) {
  const app = new Hono();

  app.get("/health", async (c) => {
    let signalOk = false;
    let broadcastOk = false;

    try {
      signalOk = await deps.signalAdapter.ping();
    } catch {
      // ping failed — signalOk stays false
    }

    if (deps.broadcastAdapter) {
      try {
        broadcastOk = await deps.broadcastAdapter.ping();
      } catch {
        // ping failed — broadcastOk stays false
      }
    }

    return c.json({
      data: {
        ok: signalOk && (!deps.broadcastAdapter || broadcastOk),
        signal: signalOk,
        broadcast: deps.broadcastAdapter ? broadcastOk : null,
      },
    });
  });

  return app;
}
