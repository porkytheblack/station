import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import crypto from "node:crypto";
import type { SSEHub, SSEClient } from "../../sse.js";
import type { StationEvent } from "../../ws.js";

export interface V1EventDeps {
  sseHub: SSEHub;
}

export function v1EventRoutes(deps: V1EventDeps) {
  const app = new Hono();

  app.get("/events", (c) => {
    const signalFilter = c.req.query("signals")
      ? new Set(c.req.query("signals")!.split(",").filter(Boolean))
      : null;
    const broadcastFilter = c.req.query("broadcasts")
      ? new Set(c.req.query("broadcasts")!.split(",").filter(Boolean))
      : null;
    const eventFilter = c.req.query("events")
      ? new Set(c.req.query("events")!.split(",").filter(Boolean))
      : null;

    return streamSSE(c, async (stream) => {
      const clientId = crypto.randomUUID();
      let eventCounter = 0;

      const client: SSEClient = {
        id: clientId,
        signalFilter,
        broadcastFilter,
        eventFilter,
        send(event: StationEvent) {
          eventCounter++;
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data),
            id: `evt_${eventCounter}`,
          });
        },
        close() {
          stream.close();
        },
      };

      deps.sseHub.addClient(client);

      // Keep connection alive with a periodic heartbeat comment
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: "" });
      }, 30_000);

      // Clean up when client disconnects
      stream.onAbort(() => {
        clearInterval(heartbeat);
        deps.sseHub.removeClient(clientId);
      });

      // Hold the connection open indefinitely until the client disconnects.
      // The stream will be closed by onAbort or by the SSEHub.close() method.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          resolve();
        });
      });
    });
  });

  return app;
}
