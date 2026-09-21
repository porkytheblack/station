import test from "node:test";
import assert from "node:assert/strict";
import { StationApiError, type StationClient, type StationInfo } from "station-client";
import { watchStationEvents, type LiveStatus } from "../src/live.js";
type Client = Pick<StationClient, "connection" | "connect" | "events">;
const info = { protocol: "station.api/v1", version: "3.0.0", stationId: "hq", role: "headquarters", capabilities: [] } as StationInfo;

test("read-only event reconnect preserves cursor, exposes gaps and aborts the active stream", async () => {
  const controller = new AbortController(), statuses: LiveStatus[] = [], events: string[] = [], cursors: (string | undefined)[] = [];
  let connections = 0, closed = 0;
  const client: Client = {
    connection: { url: "https://hq.example" }, connect: async () => { connections++; return info; },
    async *events(signal, options) {
      cursors.push(options?.lastEventId); options?.onOpen?.();
      try {
        if (cursors.length === 1) { yield { event: "run", id: "epoch:1", data: "{}" }; return; }
        yield { event: "stream.reset", id: "new-epoch:0", data: "{}" };
        assert.equal(signal.aborted, true);
      } finally { closed++; }
    },
  };
  await watchStationEvents(client, { signal: controller.signal, retryMinMs: 1, retryMaxMs: 1, onStatus: value => statuses.push(value), onEvent: event => { events.push(event.event); if (event.event === "stream.reset") controller.abort(); } });
  assert.deepEqual(cursors, [undefined, "epoch:1"]); assert.equal(connections, 2); assert.equal(closed, 2);
  assert.deepEqual(events, ["run", "stream.reset"]);
  assert.ok(statuses.some(status => status.state === "reconnecting"));
  assert.ok(statuses.some(status => status.reason?.includes("replay gap")));
  assert.equal(statuses.at(-1)?.cursor, "new-epoch:0"); assert.equal(statuses.at(-1)?.state, "stopped");
});

test("reconnect backoff cancels without another connection or credential-bearing errors", async () => {
  const controller = new AbortController(), statuses: LiveStatus[] = []; let connections = 0;
  const client: Client = { connection: { url: "https://hq.example" }, connect: async () => { connections++; throw new Error("Bearer secret-credential"); }, async *events() {} };
  await watchStationEvents(client, { signal: controller.signal, retryMinMs: 60_000, onEvent() {}, onStatus(status) { statuses.push(status); if (status.attempt === 1) controller.abort(); } });
  assert.equal(connections, 1); assert.equal(statuses.at(-1)?.state, "stopped"); assert.ok(!JSON.stringify(statuses).includes("secret-credential"));
});

test("changed identity and denied streams stop reconnection", async () => {
  for (const denied of [false, true]) {
    let connections = 0, streams = 0; const statuses: LiveStatus[] = [];
    const client: Client = { connection: { url: "https://hq.example" }, connect: async () => ({ ...info, stationId: ++connections > 1 ? "different" : "hq" }), async *events() { streams++; if (denied) throw new StationApiError("forbidden", 403, "redacted"); } };
    await watchStationEvents(client, { signal: new AbortController().signal, retryMinMs: 1, onEvent() {}, onStatus(status) { statuses.push(status); } });
    assert.equal(streams, 1); assert.equal(connections, denied ? 1 : 2);
    assert.equal(statuses.at(-1)?.state, "unavailable"); assert.equal(statuses.at(-1)?.reason, denied ? "forbidden" : "identity_mismatch");
  }
});

test("tenant contexts never subscribe to the operator event feed", async () => {
  const statuses: LiveStatus[] = [];
  const client: Client = { connection: { url: "https://hq.example", tenant: true }, async connect() { throw new Error("must not connect globally"); }, async *events() { throw new Error("must not subscribe globally"); } };
  await watchStationEvents(client, { signal: new AbortController().signal, onEvent() { assert.fail("no global events"); }, onStatus(status) { statuses.push(status); } });
  assert.deepEqual(statuses.map(status => status.state), ["polling"]);
});
