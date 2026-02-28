import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

export interface StationEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class WebSocketHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/api/events" });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => {
        this.clients.delete(ws);
      });
      ws.on("error", () => {
        this.clients.delete(ws);
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
