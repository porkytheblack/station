import test from "node:test";
import assert from "node:assert/strict";
import { StationClient, StationApiError, validateEndpoint } from "../src/index.js";
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const info = { protocol: "station.api/v1", version: "3.0.0", stationId: "hq", role: "headquarters", capabilities: [] };
test("connection validates version and identity before use", async () => {
  const client = new StationClient({ url: "https://hq.example", stationId: "hq", token: "sk_test" }, { fetch: async (url, options) => {
    assert.equal(String(url), "https://hq.example/api/v1/info");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer sk_test");
    assert.equal(options?.redirect, "error"); return response(info);
  } });
  assert.equal((await client.connect()).stationId, "hq");
  await assert.rejects(new StationClient({ url: "https://hq.example", stationId: "different" }, { fetch: async () => response(info) }).connect(), /identity/);
  await assert.rejects(new StationClient({ url: "https://hq.example" }, { fetch: async () => response({ ...info, version: "2.4.0" }) }).connect(), /requires a Station 3/);
});
test("remote TLS and API origin/path boundaries are mandatory", async () => {
  for (const url of ["http://remote.example", "https://user:password@hq.example", "https://hq.example/path", "https://hq.example?token=foo", "file:///tmp/test"]) assert.throws(() => validateEndpoint(url));
  for (const url of ["http://localhost:4400", "http://127.0.0.1:4400", "http://[::1]:4400", "https://hq.example"]) assert.equal(validateEndpoint(url), url);
  let calls = 0;
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async () => { calls++; return response(null); } });
  for (const path of ["//evil.example/", "/../../secret", "/%2e%2e/secret", "/\\evil", "https://evil.example"]) await assert.rejects(client.request("GET", path));
  assert.equal(calls, 0);
});
test("HTTP and transport failures redact upstream secrets and never retry mutations", async () => {
  let calls = 0;
  const client = new StationClient({ url: "https://hq.example", token: "sk_secret" }, { fetch: async () => { calls++; return new Response(JSON.stringify({ error: "provider_auth", message: "password=secret" }), { status: 503 }); } });
  await assert.rejects(client.request("POST", "/trigger", {}), (error: unknown) => error instanceof StationApiError && error.status === 503 && !error.message.includes("secret"));
  assert.equal(calls, 1);
  await assert.rejects(new StationClient({ url: "https://hq.example" }, { fetch: async () => { throw new Error("secret request details"); } }).health(), /No automatic retry/);
});
test("tenant execution uses the restricted route and encoded owner", async () => {
  const client = new StationClient({ url: "https://hq.example", tenant: true }, { fetch: async (url, options) => {
    assert.equal(String(url), "https://hq.example/api/v1/tenant/stations/worker%2Fone/execution/browser");
    assert.deepEqual(JSON.parse(String(options?.body)), { method: "execute", id: "session", command: { op: "pages" } }); return response([]);
  } });
  assert.deepEqual(await client.execution("worker/one", "browser", { method: "execute", id: "session", command: { op: "pages" } }), []);
});
test("oversized and malformed responses fail explicitly", async () => {
  await assert.rejects(new StationClient({ url: "https://hq.example" }, { maxResponseBytes: 4, fetch: async () => response("too large") }).health(), /size limit/);
  await assert.rejects(new StationClient({ url: "https://hq.example" }, { fetch: async () => new Response("not json") }).health(), /non-JSON/);
});
test("binary artifact upload preserves bytes and does not use JSON encoding", async () => {
  const bytes = new Uint8Array([0, 255, 10]); const digest = "sha256:" + "a".repeat(64);
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("content-type"), "application/octet-stream"); assert.equal(options?.body, bytes); return response({ digest, size: 3 });
  } });
  assert.equal((await client.putBlob(digest, bytes)).size, 3);
});
test("SSE decodes multiline events split across network chunks and closes on consumer exit", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const part of ["event: run\r", "\ndata: one\r\ndata: two\r\n", "\r\nid: 2\ndata: next\n\n"]) c.enqueue(new TextEncoder().encode(part)); }, cancel() { cancelled = true; } });
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async () => new Response(stream) });
  for await (const event of client.events(new AbortController().signal)) { assert.deepEqual(event, { event: "run", data: "one\ntwo" }); break; }
  assert.equal(cancelled, true);
});
