import test from "node:test";
import assert from "node:assert/strict";
import { SSEHub, type SSEClient } from "../../src/server/sse.js";
import { v1EventRoutes } from "../../src/server/routes/v1/events.js";
const event = (name: string) => ({ type: "run:started", timestamp: new Date().toISOString(), data: { signalName: name } });
function client(id: string, signal?: string) {
  const seen: { cursor: string; data: string }[] = [];
  const value: SSEClient = { id, signalFilter: signal ? new Set([signal]) : null, eventFilter: null, broadcastFilter: null, send(_event, data, cursor) { seen.push({ cursor, data }); }, close() {} };
  return { value, seen };
}
test("SSE cursors are global across subscribers and replay preserves filters", () => {
  const hub = new SSEHub(), first = client("one"), second = client("two");
  hub.addClient(first.value); hub.addClient(second.value); hub.broadcast(event("a"));
  assert.equal(first.seen[0].cursor, second.seen[0].cursor);
  const cursor = first.seen[0].cursor; hub.broadcast(event("b")); hub.broadcast(event("a"));
  const reconnect = client("three", "a"); assert.equal(hub.addClient(reconnect.value, cursor).reset, undefined);
  assert.equal(reconnect.seen.length, 1); assert.equal(reconnect.seen[0].cursor, hub.cursor);
});
test("bounded history and daemon restart explicitly reset stale cursors", () => {
  const hub = new SSEHub({ maxEvents: 1, maxBytes: 1024 }), start = hub.cursor;
  hub.broadcast(event("one")); hub.broadcast(event("two"));
  assert.equal(hub.addClient(client("expired").value, start).reset, "replay_expired");
  assert.equal(new SSEHub().addClient(client("restart").value, hub.cursor).reset, "server_restarted");
  assert.equal(hub.addClient(client("invalid").value, "garbage").reset, "invalid_cursor");
  const small = new SSEHub({ maxBytes: 1 }), before = small.cursor; small.broadcast(event("large"));
  assert.equal(small.addClient(client("large").value, before).reset, "replay_expired");
});
test("SSE HTTP route announces reset and removes subscriptions on abort", async () => {
  const hub = new SSEHub(), app = v1EventRoutes({ sseHub: hub }), controller = new AbortController();
  const response = await app.request("http://local/events", { signal: controller.signal, headers: { "Last-Event-ID": "old-epoch:4" } });
  const reader = response.body!.getReader(), first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: stream.reset/); assert.match(first, /server_restarted/); assert.equal(hub.clientCount, 1);
  controller.abort(); await reader.cancel(); hub.close(); assert.equal(hub.clientCount, 0);
});
