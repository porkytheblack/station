import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";

export interface StationEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Async guard run before completing a WebSocket upgrade. Return false to
 * reject with 401. Event payloads include run inputs/outputs and full job
 * logs, so the stream must enforce the same auth as the HTTP API.
 */
export type WsVerifyFn = (req: IncomingMessage) => Promise<boolean> | boolean;

export class WebSocketHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  attach(server: Server, verify?: WsVerifyFn): void {
    // noServer + manual upgrade handling: the `ws` path-matching shortcut
    // would complete the handshake before any auth check could run (Hono
    // middleware never sees upgrade requests).
    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    wss.on("connection", (ws: WebSocket) => {
      this.clients.add(ws);
      ws.on("close", () => {
        this.clients.delete(ws);
      });
      ws.on("error", () => {
        this.clients.delete(ws);
      });
    });

    server.on("upgrade", async (req, socket, head) => {
      const pathname = new URL(req.url ?? "", "http://localhost").pathname;
      if (pathname !== "/api/events") {
        socket.destroy();
        return;
      }

      try {
        if (verify && !(await verify(req))) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(event: StationEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  close(): void {
    this.wss?.close();
  }
}
