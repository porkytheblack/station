import type { StationEvent } from "./ws.js";

export interface SSEClient {
  id: string;
  send(event: StationEvent): void;
  close(): void;
  readonly signalFilter: Set<string> | null;
  readonly broadcastFilter: Set<string> | null;
  readonly eventFilter: Set<string> | null;
}

export class SSEHub {
  private clients = new Map<string, SSEClient>();

  get clientCount(): number {
    return this.clients.size;
  }

  addClient(client: SSEClient): void {
    this.clients.set(client.id, client);
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  broadcast(event: StationEvent): void {
    for (const client of this.clients.values()) {
      if (this.matchesFilter(client, event)) {
        client.send(event);
      }
    }
  }

  private matchesFilter(client: SSEClient, event: StationEvent): boolean {
    // Event type filter
    if (client.eventFilter && !client.eventFilter.has(event.type)) {
      return false;
    }

    // Signal name filter
    if (client.signalFilter) {
      const data = event.data as Record<string, unknown>;
      const run = data?.run as Record<string, unknown> | undefined;
      const signalName = run?.signalName ?? data?.signalName;
      if (typeof signalName === "string" && !client.signalFilter.has(signalName)) {
        return false;
      }
    }

    // Broadcast name filter
    if (client.broadcastFilter) {
      const data = event.data as Record<string, unknown>;
      const broadcastRun = data?.broadcastRun as Record<string, unknown> | undefined;
      const broadcastName = broadcastRun?.broadcastName ?? data?.broadcastName;
      if (typeof broadcastName === "string" && !client.broadcastFilter.has(broadcastName)) {
        return false;
      }
    }

    return true;
  }

  close(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }
}
