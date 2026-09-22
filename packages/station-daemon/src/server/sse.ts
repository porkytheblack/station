import { randomUUID } from "node:crypto";
import type { StationEvent } from "./ws.js";

export interface SSEClient {
  id: string;
  /** `serializedData` is `JSON.stringify(event.data)`, computed once per broadcast. */
  send(event: StationEvent, serializedData: string, cursor: string): void;
  close(): void;
  readonly signalFilter: Set<string> | null;
  readonly broadcastFilter: Set<string> | null;
  readonly eventFilter: Set<string> | null;
}

export class SSEHub {
  private clients = new Map<string, SSEClient>();
  private readonly epoch = randomUUID();
  private sequence = 0;
  private floor = 0;
  private retainedBytes = 0;
  private history: { event: StationEvent; data: string; sequence: number; bytes: number }[] = [];
  constructor(private readonly options: { maxEvents?: number; maxBytes?: number } = {}) {
    for (const value of [options.maxEvents ?? 256, options.maxBytes ?? 1024 * 1024]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("SSE replay bounds must be positive integers.");
  }
  get cursor() { return `${this.epoch}:${this.sequence}`; }

  get clientCount(): number {
    return this.clients.size;
  }

  addClient(client: SSEClient, lastEventId?: string): { cursor: string; reset?: "invalid_cursor" | "server_restarted" | "replay_expired" } {
    this.clients.set(client.id, client);
    if (!lastEventId) return { cursor: this.cursor };
    const split = lastEventId.lastIndexOf(":"), epoch = lastEventId.slice(0, split), sequence = Number(lastEventId.slice(split + 1));
    if (split < 0 || !Number.isSafeInteger(sequence) || sequence < 0 || String(sequence) !== lastEventId.slice(split + 1)) return { cursor: this.cursor, reset: "invalid_cursor" };
    if (epoch !== this.epoch) return { cursor: this.cursor, reset: "server_restarted" };
    if (sequence > this.sequence) return { cursor: this.cursor, reset: "invalid_cursor" };
    if (sequence < this.floor) return { cursor: this.cursor, reset: "replay_expired" };
    for (const item of this.history) if (item.sequence > sequence && this.matchesFilter(client, item.event)) client.send(item.event, item.data, `${this.epoch}:${item.sequence}`);
    return { cursor: this.cursor };
  }

  removeClient(id: string): void {
    this.clients.delete(id);
  }

  broadcast(event: StationEvent): void {
    const data = JSON.stringify(event.data), bytes = Buffer.byteLength(data), sequence = ++this.sequence;
    // Snapshot protects replay/filtering from mutations to caller-owned event objects.
    const snapshot = { ...event, data: JSON.parse(data) as Record<string, unknown> };
    this.history.push({ event: snapshot, data, sequence, bytes }); this.retainedBytes += bytes;
    while (this.history.length > (this.options.maxEvents ?? 256) || this.retainedBytes > (this.options.maxBytes ?? 1024 * 1024)) {
      const discarded = this.history.shift()!; this.floor = discarded.sequence; this.retainedBytes -= discarded.bytes;
    }
    for (const client of this.clients.values()) if (this.matchesFilter(client, snapshot)) client.send(snapshot, data, this.cursor);
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
