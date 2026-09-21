import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import crypto from "node:crypto";
import type { SSEHub, SSEClient } from "../../sse.js";

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
      let heartbeat: ReturnType<typeof setInterval> | undefined, finished = false;
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const cleanup = () => {
        if (finished) return;
        finished = true; if (heartbeat) clearInterval(heartbeat);
        deps.sseHub.removeClient(clientId); finish();
      };
      const write = (event: string, data: string, id?: string) => {
        if (!finished) void stream.writeSSE({ event, data, ...(id ? { id } : {}) }).catch(cleanup);
      };
      const client: SSEClient = {
        id: clientId, signalFilter, broadcastFilter, eventFilter,
        send(event, serializedData, cursor) { write(event.type, serializedData, cursor); },
        close() { cleanup(); void stream.close().catch(() => {}); },
      };
      stream.onAbort(cleanup);
      const replay = deps.sseHub.addClient(client, c.req.header("Last-Event-ID"));
      // Replay is bounded and process-local. Clients must refetch state after an explicit gap.
      write(replay.reset ? "stream.reset" : "stream.ready", JSON.stringify(replay), replay.cursor);
      heartbeat = setInterval(() => write("heartbeat", ""), 30_000);
      await done;

    });
  });

  return app;
}
