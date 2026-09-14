import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { StationNetworkMemoryAdapter, type StationNode } from "station-network";
import { HostSandboxAdapter } from "station-sandbox";
import { BrowserSessionManager } from "station-browser-use";
import { executionCatalogRoutes, internalExecutionRoutes, publicExecutionRoutes, type ExecutionDeps } from "../../../src/server/routes/execution.js";
import { authResolver } from "../../../src/server/middleware/auth.js";
import { KeyStore, MemoryKeyStorage } from "../../../src/server/auth/keys.js";
import { resolveConfig } from "../../../src/config/schema.js";

const token = "worker-secret-".repeat(4);
const request = (body: unknown, auth?: string) => ({ method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });

test("dashboard discovers advertised capabilities with owner availability and admin authentication", async () => {
  const adapter = new StationNetworkMemoryAdapter();
  const keys = new KeyStore(new MemoryKeyStorage());
  const admin = (await keys.create("operator", ["admin"])).key;
  const read = (await keys.create("observer", ["read"])).key;
  const worker = node("coding", "http://private-worker:5700");
  worker.definitions.execution = { sandbox: { backend: "host-process" } };
  await adapter.upsertStation(worker);
  await adapter.upsertStation({ ...worker, id: "browser", status: "draining", definitions: { ...worker.definitions, execution: { browser: { backend: "bun" } } } });
  await adapter.upsertStation({ ...worker, id: "offline", leaseExpiresAt: new Date(0) });
  await adapter.upsertStation({ ...worker, id: "elsewhere", networkId: "other" });
  await adapter.upsertStation(node("legacy", "http://private-worker:5701"));
  const app = new Hono();
  app.use("/*", authResolver({ keyStore: keys }));
  app.route("/", executionCatalogRoutes({ adapter, networkId: "test", stationId: "hq", role: "headquarters", enabled: true }));
  assert.equal((await app.request("/execution")).status, 401);
  assert.equal((await app.request("/execution", { headers: { authorization: `Bearer ${read}` } })).status, 403);
  const response = await app.request("/execution", { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.deepEqual(data.map((row: { stationId: string }) => row.stationId).sort(), ["browser", "coding", "offline"]);
  assert.deepEqual(data.find((row: { stationId: string }) => row.stationId === "coding").capabilities, { sandbox: true, browser: false });
  assert.equal(data.find((row: { stationId: string }) => row.stationId === "browser").available, true);
  assert.equal(data.find((row: { stationId: string }) => row.stationId === "offline").available, false);
  assert.ok(data.every((row: object) => !Object.hasOwn(row, "endpoint")));
});
function node(id: string, endpoint: string, patch: Partial<StationNode> = {}): StationNode {
  return { id, name: id, networkId: "test", role: "station", status: "online", labels: {}, capacity: { maxConcurrent: 2, activeRuns: 0 }, definitions: { signals: [], broadcasts: [], beacons: [] }, endpoint, startedAt: new Date(), lastHeartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000), ...patch };
}

test("execution RPC authenticates both boundaries and keeps real commands on their owning worker", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-execution-"));
  const sandbox = new HostSandboxAdapter({ rootDir: root });
  const network = new StationNetworkMemoryAdapter();
  const keys = new KeyStore(new MemoryKeyStorage());
  const admin = (await keys.create("operator", ["admin"])).key;
  const read = (await keys.create("observer", ["read"])).key;
  const deps: ExecutionDeps = { execution: { token, sandbox }, adapter: network, networkId: "test", stationId: "worker", role: "station" };
  const worker = new Hono();
  worker.route("/internal", internalExecutionRoutes(deps));
  const server = serve({ fetch: worker.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await sandbox.close(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  await network.upsertStation(node("worker", endpoint));
  const hq = new Hono();
  hq.use("/*", authResolver({ keyStore: keys }));
  hq.route("/api/v1", publicExecutionRoutes({ ...deps, execution: { token }, role: "headquarters", stationId: "hq" }));
  const path = "/api/v1/stations/worker/execution/sandbox";
  assert.equal((await hq.request(path, request({ method: "create" }))).status, 401);
  assert.equal((await hq.request(path, request({ method: "create" }, read))).status, 403);
  assert.equal((await hq.request(path, request({ method: "create" }, token))).status, 401);
  assert.equal((await fetch(`${endpoint}/internal/execution/sandbox`, request({ method: "create" }, admin))).status, 401);
  assert.equal((await fetch(`${endpoint}/internal/execution/sandbox`, request({ method: "create" }, "wrong"))).status, 401);
  const created = await hq.request(path, request({ method: "create" }, admin));
  assert.equal(created.status, 200);
  const { data: workspace } = await created.json();
  assert.equal((await sandbox.list()).length, 1);
  const executed = await hq.request(path, request({ method: "exec", id: workspace.id, command: "printf station-routed" }, admin));
  assert.equal(executed.status, 200);
  const { data: run } = await executed.json();
  let result;
  const deadline = Date.now() + 5_000;
  do {
    const response = await hq.request(path, request({ method: "command", id: workspace.id, runId: run.id }, admin));
    result = (await response.json()).data;
    if (result.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "station-routed");
  for (const patch of [{ status: "offline" as const }, { leaseExpiresAt: new Date(0) }]) {
    await network.upsertStation(node("worker", endpoint, patch));
    assert.equal((await hq.request(path, request({ method: "list" }, admin))).status, 503);
  }
  await network.upsertStation(node("worker", endpoint, { status: "draining" }));
  assert.equal((await hq.request(path, request({ method: "list" }, admin))).status, 200);
  assert.equal((await hq.request(path, request({ method: "command", id: workspace.id, runId: run.id }, admin))).status, 200);
  assert.equal((await hq.request(path, request({ method: "cancel", id: workspace.id, runId: run.id }, admin))).status, 200);
  assert.equal((await hq.request(path, request({ method: "create" }, admin))).status, 503);
  assert.equal((await hq.request(path, request({ method: "exec", id: workspace.id, command: "true" }, admin))).status, 503);
  assert.equal((await fetch(`${endpoint}/internal/execution/sandbox`, request({ method: "create" }, token))).status, 503);
  assert.equal((await fetch(`${endpoint}/internal/execution/sandbox`, request({ method: "get", id: workspace.id }, token))).status, 200);
  await network.upsertStation(node("worker", endpoint, { networkId: "other" }));
  assert.equal((await hq.request(path, request({ method: "list" }, admin))).status, 404);
  await network.upsertStation(node("worker", endpoint));
  assert.equal((await hq.request(path, request({ method: "exec", id: workspace.id, command: "echo hi", endpoint: "http://attacker" }, admin))).status, 400);
  assert.equal((await hq.request(path, request({ method: "constructor" }, admin))).status, 400);
  assert.equal((await hq.request(path, request({ method: "exec", id: workspace.id, command: "x".repeat(140_000) }, admin))).status, 413);
  const noAuth = new Hono();
  noAuth.use("/*", authResolver({}));
  noAuth.route("/api/v1", publicExecutionRoutes(deps));
  assert.equal((await noAuth.request(path, request({ method: "list" }))).status, 401);
});

test("browser RPC has its own lifecycle and sanitized failures", async () => {
  let closed = 0;
  const browser = new BrowserSessionManager({ name: "test", capabilities: { screenshots: true, independentSessions: true }, async open() {
    return { async navigate() { throw new Error("secret-database-password"); }, async evaluate() { return "page title"; }, async click() {}, async type() {}, async press() {}, async screenshot() { return new Uint8Array([1, 2, 3]); }, async close() { closed++; } };
  } });
  const adapter = new StationNetworkMemoryAdapter();
  await adapter.upsertStation(node("browser", "http://unused"));
  const app = internalExecutionRoutes({ execution: { token, browser }, adapter, networkId: "test", stationId: "browser", role: "station" });
  const call = (body: unknown) => app.request("/execution/browser", request(body, token));
  const { data: handle } = await (await call({ method: "open" })).json();
  const { data: screenshot } = await (await call({ method: "action", id: handle.id, action: "screenshot" })).json();
  assert.deepEqual(screenshot, { mimeType: "image/png", base64: "AQID" });
  const failed = await call({ method: "action", id: handle.id, action: "navigate", value: "https://example.com" });
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("secret-database-password"));
  assert.equal((await call({ method: "action", id: handle.id, action: "deleteAll" })).status, 400);
  await adapter.upsertStation(node("browser", "http://unused", { status: "draining" }));
  assert.equal((await call({ method: "open" })).status, 503);
  assert.equal((await call({ method: "action", id: handle.id, action: "screenshot" })).status, 503);
  assert.equal((await call({ method: "list" })).status, 200);
  assert.equal((await call({ method: "close", id: handle.id })).status, 200);
  await adapter.upsertStation(node("browser", "http://unused"));
  assert.equal(closed, 1);
  assert.equal((await call({ method: "action", id: handle.id, action: "screenshot" })).status, 404);
  assert.equal((await app.request("/execution/sandbox", request({ method: "create" }, token))).status, 503);
  await browser.close();
});

test("execution rejects weak service secrets during configuration", () => {
  assert.throws(() => resolveConfig({ execution: { token: "short" } }), /32 characters/);
});

test("execution proxy refuses redirects without forwarding the worker secret", async (t) => {
  let destinationCalls = 0;
  const destination = serve({ hostname: "127.0.0.1", port: 0, fetch: () => { destinationCalls++; return new Response('{}'); } });
  await new Promise<void>((resolve) => destination.listening ? resolve() : destination.once("listening", resolve));
  const address = destination.address();
  assert.ok(address && typeof address !== "string");
  const redirect = serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${address.port}` } }) });
  await new Promise<void>((resolve) => redirect.listening ? resolve() : redirect.once("listening", resolve));
  t.after(async () => { await Promise.all([destination, redirect].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
  const redirectAddress = redirect.address();
  assert.ok(redirectAddress && typeof redirectAddress !== "string");
  const adapter = new StationNetworkMemoryAdapter();
  await adapter.upsertStation(node("worker", `http://127.0.0.1:${redirectAddress.port}`));
  const keys = new KeyStore(new MemoryKeyStorage());
  const admin = (await keys.create("operator", ["admin"])).key;
  const app = new Hono();
  app.use("/*", authResolver({ keyStore: keys }));
  app.route("/", publicExecutionRoutes({ execution: { token }, adapter, networkId: "test", stationId: "hq", role: "headquarters" }));
  const response = await app.request("/stations/worker/execution/sandbox", request({ method: "create" }, admin));
  assert.equal(response.status, 503);
  assert.equal(destinationCalls, 0);
});

test("station shutdown closes browser actions before waiting for HTTP connections", { timeout: 10_000 }, async (t) => {
  const { createStation } = await import("../../../src/server/index.js");
  const { createServer } = await import("node:net");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const root = mkdtempSync(join(tmpdir(), "station-execution-stop-"));
  let finish!: (value: unknown) => void;
  let began!: () => void;
  const active = new Promise<void>((resolve) => { began = resolve; });
  const browser = new BrowserSessionManager({ name: "test", capabilities: { screenshots: true, independentSessions: true }, async open() {
    return { async navigate() {}, async evaluate() { began(); return new Promise((resolve) => { finish = resolve; }); }, async click() {}, async type() {}, async press() {}, async screenshot() { return new Uint8Array(); }, async close() { finish?.(null); } };
  } });
  const station = await createStation(resolveConfig({ port, host: "127.0.0.1", runRunners: false, open: false, network: { stationId: "browser" }, auth: { username: "operator", password: "test-password" }, execution: { token, browser } }), root);
  let stopped = false;
  t.after(async () => { if (!stopped) { finish?.(null); await station.stop(); } rmSync(root, { recursive: true, force: true }); });
  await station.start();
  const admin = (await station.keyStore!.create("operator", ["admin"])).key;
  const handle = await browser.open();
  const pending = fetch(`http://127.0.0.1:${port}/api/v1/stations/browser/execution/browser`, request({ method: "action", id: handle.id, action: "evaluate", value: "pending" }, admin));
  await active;
  await station.stop();
  stopped = true;
  assert.equal((await pending).status, 200);
});

test("proxy preserves browser output above 16 MiB with a bounded envelope", async (t) => {
  let bytes = 17 * 1024 * 1024;
  const worker = serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: { mimeType: "image/png", base64: "A".repeat(bytes) } }) });
  await new Promise<void>((resolve) => worker.listening ? resolve() : worker.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => worker.close(() => resolve())));
  const address = worker.address();
  assert.ok(address && typeof address !== "string");
  const adapter = new StationNetworkMemoryAdapter();
  await adapter.upsertStation(node("browser", `http://127.0.0.1:${address.port}`));
  const keys = new KeyStore(new MemoryKeyStorage());
  const admin = (await keys.create("operator", ["admin"])).key;
  const app = new Hono();
  app.use("/*", authResolver({ keyStore: keys }));
  app.route("/", publicExecutionRoutes({ execution: { token }, adapter, networkId: "test", stationId: "hq", role: "headquarters" }));
  const body = { method: "action", id: "session", action: "screenshot" };
  const result = await app.request("/stations/browser/execution/browser", request(body, admin));
  assert.equal(result.status, 200);
  const data = (await result.json()).data;
  assert.equal(data.base64.length, bytes);
  assert.equal(data.mimeType, "image/png");
  bytes = 34 * 1024 * 1024;
  assert.equal((await app.request("/stations/browser/execution/browser", request(body, admin))).status, 503);
});

test("browser recordings stay owner-routed and admin-only, with retained frames and draining cleanup", async (t) => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const browser = new BrowserSessionManager({ name: "fixture", capabilities: { screenshots: true, independentSessions: true }, async open() {
    return { async navigate() {}, async evaluate() {}, async click() {}, async type() {}, async press() {}, async screenshot() { return png; }, async close() {} };
  } });
  const network = new StationNetworkMemoryAdapter();
  const deps: ExecutionDeps = { execution: { token, browser }, adapter: network, networkId: "test", stationId: "worker", role: "station" };
  const worker = new Hono();
  worker.route("/internal", internalExecutionRoutes(deps));
  const server = serve({ fetch: worker.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  t.after(async () => { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  await network.upsertStation(node("worker", endpoint));
  const keys = new KeyStore(new MemoryKeyStorage());
  const admin = (await keys.create("operator", ["admin"])).key;
  const read = (await keys.create("observer", ["read"])).key;
  const hq = new Hono();
  hq.use("/*", authResolver({ keyStore: keys }));
  hq.route("/", publicExecutionRoutes({ ...deps, execution: { token }, stationId: "hq", role: "headquarters" }));
  const path = "/stations/worker/execution/browser";
  const call = (body: unknown, auth = admin) => hq.request(path, request(body, auth));
  assert.equal((await hq.request(path, request({ method: "recordings" }))).status, 401);
  assert.equal((await call({ method: "recordings" }, read)).status, 403);
  assert.equal((await fetch(`${endpoint}/internal/execution/browser`, request({ method: "recordings" }, admin))).status, 401);
  const { data: session } = await (await call({ method: "open" })).json();
  const started = await call({ method: "recordingStart", id: session.id });
  assert.equal(started.status, 200);
  let recording = (await started.json()).data;
  assert.equal(recording.intervalMs, 5000);
  for (let attempts = 0; recording.frames.length === 0 && attempts < 100; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    recording = (await (await call({ method: "recording", id: recording.id })).json()).data;
  }
  assert.equal(recording.frames.length, 1);
  const frame = recording.frames[0];
  assert.ok(!JSON.stringify(recording).includes("base64"), "metadata does not transfer image payloads");
  for (const invalid of [
    { method: "recordingFrame", id: recording.id, frameId: "../outside" },
    { method: "recordingFrame", id: recording.id },
    { method: "recordingStart", id: session.id, intervalMs: 1 },
  ]) assert.equal((await call(invalid)).status, 400);
  await network.upsertStation(node("worker", endpoint, { status: "draining" }));
  assert.equal((await call({ method: "recordingStart", id: session.id })).status, 503);
  assert.equal((await call({ method: "recordingStop", id: recording.id })).status, 200);
  assert.equal((await call({ method: "close", id: session.id })).status, 200);
  assert.equal((await call({ method: "recordings" })).status, 200);
  const retained = await call({ method: "recordingFrame", id: recording.id, frameId: frame.id });
  assert.equal(retained.status, 200);
  assert.deepEqual((await retained.json()).data, { mimeType: "image/png", base64: Buffer.from(png).toString("base64") });
  assert.equal((await call({ method: "recordingFrame", id: recording.id, frameId: "missing" })).status, 404);
  assert.equal((await call({ method: "recordingDelete", id: recording.id })).status, 200);
  assert.equal((await call({ method: "recording", id: recording.id })).status, 404);
});

test("advanced sandbox gateway preserves file bytes, service ownership and draining cleanup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-advanced-rpc-"));
  const sandbox = new HostSandboxAdapter({ rootDir: root });
  t.after(async () => { await sandbox.close(); rmSync(root, { recursive: true, force: true }); });
  const network = new StationNetworkMemoryAdapter();
  await network.upsertStation(node("worker", "http://unused"));
  const app = internalExecutionRoutes({ execution: { token, sandbox }, adapter: network, networkId: "test", stationId: "worker", role: "station" });
  const call = (body: unknown) => app.request("/execution/sandbox", request(body, token));
  const { data: workspace } = await (await call({ method: "create" })).json();
  const id = workspace.id;
  const bytes = Buffer.alloc(200_000, 123);
  assert.equal((await call({ method: "writeFile", id, path: "nested/data.bin", options: { base64: bytes.toString("base64"), createParents: true } })).status, 200);
  const read = await call({ method: "readFile", id, path: "nested/data.bin", options: { offset: 150_000, length: 100 } });
  assert.equal(read.status, 200);
  assert.deepEqual(Buffer.from((await read.json()).data.base64, "base64"), bytes.subarray(150_000, 150_100));
  for (const body of [
    { method: "writeFile", id, path: "../outside", options: { base64: "eA==" } },
    { method: "readFile", id, path: "nested/data.bin", options: { offset: -1 } },
    { method: "writeFile", id, path: "bad", options: { base64: "!@#$" } },
    { method: "openTerminal", id, options: { cols: 0 } },
    { method: "startService", id, options: { name: "bad", command: "true", restart: { policy: "always", maxRestarts: -1, delayMs: 100 } } },
    { method: "exec", id, command: "true", options: { privileged: true } },
  ]) assert.equal((await call(body)).status, 400, JSON.stringify(body));
  assert.equal((await call({ method: "openTerminal", id })).status, 503, "PTY is opt-in");
  const response = await call({ method: "startService", id, options: { name: "held", command: "sleep 30" } });
  assert.equal(response.status, 200);
  const { data: service } = await response.json();
  const { data: other } = await (await call({ method: "create" })).json();
  assert.equal((await call({ method: "service", id: other.id, serviceId: service.id })).status, 404);
  await network.upsertStation(node("worker", "http://unused", { status: "draining" }));
  assert.equal((await call({ method: "readFile", id, path: "nested/data.bin" })).status, 200);
  assert.equal((await call({ method: "writeFile", id, path: "denied", options: { base64: "eA==" } })).status, 503);
  assert.equal((await call({ method: "startService", id, options: { name: "denied", command: "true" } })).status, 503);
  assert.equal((await call({ method: "stopService", id, serviceId: service.id })).status, 200);
  assert.equal((await call({ method: "removeService", id, serviceId: service.id })).status, 200);
});

test("advanced browser requests are validated before dispatch and allow draining reads", async (t) => {
  const commands: unknown[] = [];
  const browser = new BrowserSessionManager({ name: "advanced-fixture", capabilities: { screenshots: true, independentSessions: true, commands: true, pages: true }, async open() {
    return { async navigate() {}, async evaluate() {}, async click() {}, async type() {}, async press() {}, async screenshot() { return new Uint8Array(); }, async close() {}, async execute(command) { commands.push(command); return "handled"; } };
  } });
  t.after(() => browser.close());
  const network = new StationNetworkMemoryAdapter();
  await network.upsertStation(node("worker", "http://unused"));
  const app = internalExecutionRoutes({ execution: { token, browser }, adapter: network, networkId: "test", stationId: "worker", role: "station" });
  const call = (body: unknown) => app.request("/execution/browser", request(body, token));
  const { data: handle } = await (await call({ method: "open" })).json();
  const id = handle.id;
  assert.equal((await call({ method: "execute", id, command: { op: "fill", selector: "#input", value: "hello" } })).status, 200);
  for (const body of [
    { method: "open", options: { profileId: "../secret" } },
    { method: "execute", id, command: { op: "fill", selector: "#input", value: "hello", arbitrary: true } },
    { method: "execute", id, command: { op: "upload", selector: "input", files: [{ name: "bad", mimeType: "text/plain", base64: "!" }] } },
  ]) assert.equal((await call(body)).status, 400);
  assert.equal(commands.length, 1);
  await network.upsertStation(node("worker", "http://unused", { status: "draining" }));
  assert.equal((await call({ method: "execute", id, command: { op: "pages" } })).status, 200);
  assert.equal((await call({ method: "execute", id, command: { op: "newPage" } })).status, 503);
  assert.equal((await call({ method: "audit" })).status, 200);
  assert.equal((await call({ method: "close", id })).status, 200);
});

test("backend readiness failure releases both execution backends before advertising", async () => {
  const { createStation } = await import("../../../src/server/index.js");
  const root = mkdtempSync(join(tmpdir(), "station-ready-failure-"));
  const sandbox = new HostSandboxAdapter({ rootDir: join(root, "workspaces") });
  let closed = 0;
  const browser = new BrowserSessionManager({ name: "fixture", capabilities: { screenshots: true, independentSessions: true }, async open() {
    return { async navigate() {}, async evaluate() {}, async click() {}, async type() {}, async press() {}, async screenshot() { return new Uint8Array(); }, async close() { closed++; } };
  } });
  await browser.open();
  Object.assign(sandbox, { async ready() { throw Error("engine unavailable"); } });
  try {
    await assert.rejects(createStation(resolveConfig({ execution: { token, sandbox, browser }, open: false }), root), /engine unavailable/);
    assert.equal(closed, 1);
    const recovered = new HostSandboxAdapter({ rootDir: join(root, "workspaces") });
    await recovered.close();
  } finally { await sandbox.close(); await browser.close(); rmSync(root, { recursive: true, force: true }); }
});
