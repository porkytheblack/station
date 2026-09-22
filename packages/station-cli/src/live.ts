import { setTimeout } from "node:timers/promises";
import { StationApiError, type StationClient, type StationEvent } from "station-client";
export interface LiveStatus { state: "connecting" | "live" | "reconnecting" | "polling" | "unavailable" | "stopped"; cursor?: string; attempt: number; reason?: string }
export interface LiveOptions {
  signal: AbortSignal;
  onEvent: (event: StationEvent) => void | Promise<void>;
  onStatus: (status: LiveStatus) => void;
  retryMinMs?: number; retryMaxMs?: number;
}
/** Read-only reconnect loop. No mutation request or action callback belongs in this lifecycle. */
export async function watchStationEvents(client: Pick<StationClient, "connection" | "connect" | "events">, options: LiveOptions) {
  const { signal } = options;
  let cursor: string | undefined, attempt = 0, identity: string | undefined;
  const report = (state: LiveStatus["state"], reason?: string) => options.onStatus({ state, cursor, attempt, ...(reason ? { reason } : {}) });
  if (client.connection.tenant) { report("polling", "tenant-scoped resources only"); return; }
  const minimum = options.retryMinMs ?? 250, maximum = options.retryMaxMs ?? 5000;
  try {
    while (!signal.aborted) {
      report(attempt ? "reconnecting" : "connecting");
      let openedAt = 0;
      try {
        const info = await client.connect(signal);
        if (identity !== undefined && info.stationId !== identity) throw new StationApiError("identity_mismatch", 0, "Connected daemon identity changed.");
        identity = info.stationId;
        for await (const event of client.events(signal, { lastEventId: cursor, onOpen: () => { openedAt = Date.now(); report("live"); } })) {
          if (signal.aborted) break;
          if (event.id !== undefined) cursor = event.id;
          if (event.event === "stream.reset") report("live", "event replay gap; refreshed current state");
          if (event.event !== "heartbeat") await options.onEvent(event);
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof StationApiError && (error.status === 401 || error.status === 403 || ["identity_mismatch", "incompatible_version"].includes(error.code))) {
          report("unavailable", error.code); return;
        }
      }
      if (signal.aborted) break;
      if (openedAt && Date.now() - openedAt > 5000) attempt = 0;
      attempt++; report("reconnecting");
      const delay = Math.min(maximum, minimum * 2 ** Math.min(attempt - 1, 8));
      try { await setTimeout(delay, undefined, { signal }); } catch { if (!signal.aborted) throw new Error("Event reconnect wait failed."); }
    }
  } finally { if (signal.aborted) report("stopped"); }
}
