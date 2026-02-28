import { Hono } from "hono";
import type { SignalQueueAdapter } from "simple-signal";
import type { BroadcastQueueAdapter } from "simple-broadcast";

export interface HealthDeps {
  signalAdapter: SignalQueueAdapter;
  broadcastAdapter?: BroadcastQueueAdapter;
}

export function healthRoutes(deps: HealthDeps) {
  const app = new Hono();

  app.get("/health", async (c) => {
    let signalOk = false;
    let broadcastOk = false;

    try {
      signalOk = await deps.signalAdapter.ping();
    } catch {}

    if (deps.broadcastAdapter) {
      try {
        broadcastOk = await deps.broadcastAdapter.ping();
      } catch {}
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
