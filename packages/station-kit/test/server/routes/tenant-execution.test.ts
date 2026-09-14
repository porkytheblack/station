import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { StationNetworkMemoryAdapter, type StationNode } from "station-network";
import type { SandboxAdapter } from "station-sandbox";
import { authResolver } from "../../../src/server/middleware/auth.js";
import { KeyStore, MemoryKeyStorage } from "../../../src/server/auth/keys.js";
import { createSessionToken } from "../../../src/server/auth/session.js";
import { internalExecutionRoutes, publicExecutionRoutes, type ExecutionDeps } from "../../../src/server/routes/execution.js";
import { tenantExecutionRoutes, validateExecutionTenancy } from "../../../src/server/routes/tenant-execution.js";

const token = "private-worker-token-".repeat(3);
const capability = { filesystem: true as const, commands: true as const, pty: false, isolated: true, networkRestricted: true };
function node(id: string, tenantId: string, endpoint: string): StationNode {
  return { id, name: `Private ${id}`, endpoint, networkId: "tenants", role: "station", status: "online", labels: {}, capacity: { maxConcurrent: 2, activeRuns: 0 }, definitions: { signals: [], broadcasts: [], beacons: [], execution: { tenantId, sandbox: { backend: "test-isolated", capabilities: capability } } }, startedAt: new Date(), lastHeartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000) };
}
const request = (body: unknown, key: string, extra: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...extra }, body: JSON.stringify(body) });
const fakeSandbox = (owner: string) => ({ name: "test-isolated", capabilities: capability, bindTenant: async () => {}, list: async () => [{ id: `${owner}-workspace`, backend: "test-isolated", createdAt: new Date().toISOString() }], create: async () => ({ id: `${owner}-created`, backend: "test-isolated", createdAt: new Date().toISOString() }), close: async () => {} } as SandboxAdapter);

test("tenant gateway uses verified key identity at both boundaries and never forwards customer assertions", async (t) => {
  const network = new StationNetworkMemoryAdapter();
  const keys = new KeyStore(new MemoryKeyStorage());
  const a = await keys.create("customer-a", ["execution"]);
  const b = await keys.create("customer-b", ["execution"]);
  const admin = await keys.create("operator", ["admin"]);
  const mixed = await keys.create("mixed", ["execution", "read"]);
  const unmapped = await keys.create("unmapped", ["execution"]);
  const sessionConfig = { username: "operator", password: "password", sessionTtlMs: 60_000 };
  const deps: ExecutionDeps = { execution: { token }, adapter: network, networkId: "tenants", stationId: "hq", role: "headquarters" };
  const workers = new Map<string, Hono>();
  for (const tenantId of ["a", "b"]) {
    const worker = new Hono();
    worker.route("/internal", internalExecutionRoutes({ ...deps, role: "station", stationId: tenantId, execution: { token, tenantId, sandbox: fakeSandbox(tenantId) } }));
    const server = serve({ fetch: worker.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await network.upsertStation(node(tenantId, tenantId, `http://127.0.0.1:${address.port}`));
    workers.set(tenantId, worker);
  }
  const hq = new Hono();
  hq.use("/*", authResolver({ keyStore: keys, sessionConfig }));
  hq.route("/", tenantExecutionRoutes({ ...deps, execution: { token, tenants: { apiKeyTenants: { [a.record.id]: "a", [b.record.id]: "b", [admin.record.id]: "a", [mixed.record.id]: "a" } } } }));
  hq.route("/", publicExecutionRoutes(deps));
  const path = (owner: string) => `/tenant/stations/${owner}/execution/sandbox`;
  assert.equal((await hq.request("/tenant/execution")).status, 401);
  for (const key of [admin.key, mixed.key, unmapped.key]) assert.equal((await hq.request(path("a"), request({ method: "list" }, key))).status, 403);
  const session = createSessionToken(sessionConfig);
  assert.equal((await hq.request("/tenant/execution", { headers: { cookie: `station_session=${session}` } })).status, 403);
  const discovered = await (await hq.request("/tenant/execution", { headers: { authorization: `Bearer ${a.key}` } })).json();
  assert.deepEqual(discovered.data.map((item: any) => item.stationId), ["a"]);
  assert.equal(discovered.data[0].features.sandbox.networkRestricted, true);
  assert.equal(discovered.data[0].backends.sandbox, "test-isolated");
  assert.ok(!JSON.stringify(discovered).includes("tenantId") && !JSON.stringify(discovered).includes("127.0.0.1"));
  assert.equal((await hq.request(path("b"), request({ method: "list" }, a.key))).status, 404);
  assert.equal((await hq.request(path("missing"), request({ method: "list" }, a.key))).status, 404);
  const own = await hq.request(path("a"), request({ method: "list" }, a.key, { "x-station-execution-tenant": "b" }));
  assert.equal(own.status, 200); assert.equal((await own.json()).data[0].id, "a-workspace");
  assert.equal((await hq.request(path("a"), request({ method: "create", tenantId: "b" }, a.key))).status, 400);
  assert.equal((await hq.request("/stations/a/execution/sandbox", request({ method: "list" }, a.key))).status, 403);
  assert.equal((await hq.request("/stations/a/execution/sandbox", request({ method: "list" }, admin.key))).status, 200);
  assert.equal((await workers.get("a")!.request("/internal/execution/sandbox", request({ method: "list" }, a.key, { "x-station-execution-tenant": "a" }))).status, 401);
  assert.equal((await workers.get("a")!.request("/internal/execution/sandbox", request({ method: "list" }, token, { "x-station-execution-tenant": "b" }))).status, 404);
  // Even stale or corrupted ownership advertised in membership cannot override the worker's configured owner.
  const bNode = (await network.getStation("b"))!;
  await network.upsertStation({ ...bNode, definitions: { ...bNode.definitions, execution: { ...bNode.definitions.execution!, tenantId: "a" } } });
  assert.equal((await hq.request(path("b"), request({ method: "list" }, a.key))).status, 404);
  const aNode = (await network.getStation("a"))!;
  await network.upsertStation({ ...aNode, status: "draining" });
  assert.equal((await hq.request(path("a"), request({ method: "list" }, a.key))).status, 200);
  assert.equal((await hq.request(path("a"), request({ method: "create" }, a.key))).status, 503);
  await network.upsertStation({ ...aNode, leaseExpiresAt: new Date(0) });
  assert.equal((await hq.request(path("a"), request({ method: "list" }, a.key))).status, 503);
  await keys.revoke(a.record.id);
  assert.equal((await hq.request(path("a"), request({ method: "list" }, a.key))).status, 401);
});

test("tenant startup rejects unsafe backends, unprotected egress and invalid role/auth combinations", () => {
  const sandbox = fakeSandbox("a");
  const worker = { role: "station" as const, execution: { token, tenantId: "a", sandbox } };
  assert.doesNotThrow(() => validateExecutionTenancy(worker));
  for (const capabilities of [{ ...capability, isolated: false }, { ...capability, networkRestricted: false }, { ...capability, networkRestricted: undefined }]) {
    assert.throws(() => validateExecutionTenancy({ ...worker, execution: { ...worker.execution, sandbox: { ...sandbox, capabilities } } }), /isolated|networkRestricted/);
  }
  assert.throws(() => validateExecutionTenancy({ ...worker, role: "headquarters" }), /dedicated/);
  assert.throws(() => validateExecutionTenancy({ role: "headquarters", execution: { token, tenants: { apiKeyTenants: {} } } }), /authenticated/);
  assert.throws(() => validateExecutionTenancy({ ...worker, execution: { token, tenantId: "../invalid", sandbox } }), /tenant ID/);
  const auth = { username: "operator", password: "password" };
  assert.doesNotThrow(() => validateExecutionTenancy({ role: "headquarters", auth, execution: { token, tenants: { apiKeyTenants: { key: "a" } } } }));
  assert.throws(() => validateExecutionTenancy({ role: "headquarters", auth, execution: { token, tenants: { apiKeyTenants: { key: "../../bad" } } } }), /mapping/);
});

test("tenant request quotas are shared by keys, separate by tenant, and release in-flight slots", async (t) => {
  const network = new StationNetworkMemoryAdapter();
  const keys = new KeyStore(new MemoryKeyStorage());
  const a = await keys.create("a", ["execution"]);
  const a2 = await keys.create("a2", ["execution"]);
  const b = await keys.create("b", ["execution"]);
  const unknown = await keys.create("unknown", ["execution"]);
  const deps: ExecutionDeps = { execution: { token, tenants: { apiKeyTenants: { [a.record.id]: "a", [a2.record.id]: "a", [b.record.id]: "b" }, limits: { requestsPerSecond: 1, burst: 1 } } }, adapter: network, networkId: "tenants", stationId: "hq", role: "headquarters" };
  const app = new Hono(); app.use("/*", authResolver({ keyStore: keys })); app.route("/", tenantExecutionRoutes(deps));
  const get = (key: string) => app.request("/tenant/execution", { headers: { authorization: `Bearer ${key}` } });
  assert.equal((await get(unknown.key)).status, 403);
  assert.equal((await get(a.key)).status, 200);
  const throttled = await get(a2.key); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get("retry-after"), "1");
  assert.equal((await get(b.key)).status, 200);

  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const original = network.listStations.bind(network);
  network.listStations = async (filter) => { if (++calls === 1) { entered(); await held; } return original(filter); };
  const bounded = new Hono(); bounded.use("/*", authResolver({ keyStore: keys }));
  bounded.route("/", tenantExecutionRoutes({ ...deps, execution: { token, tenants: { ...deps.execution.tenants!, limits: { burst: 20, maxInFlightPerTenant: 1, maxInFlight: 2 } } } }));
  const boundedGet = (key: string) => bounded.request("/tenant/execution", { headers: { authorization: `Bearer ${key}` } });
  const first = boundedGet(a.key); await started;
  assert.equal((await boundedGet(a2.key)).status, 429);
  assert.equal((await boundedGet(b.key)).status, 200);
  release(); assert.equal((await first).status, 200);
  assert.equal((await boundedGet(a2.key)).status, 200);
  network.listStations = async () => { throw new Error("private database URL"); };
  assert.equal((await boundedGet(a.key)).status, 503);
  network.listStations = original;
  assert.equal((await boundedGet(a.key)).status, 200);
  let globalRelease!: () => void;
  let globalEntered!: () => void;
  const globalStarted = new Promise<void>((resolve) => { globalEntered = resolve; });
  const globalHeld = new Promise<void>((resolve) => { globalRelease = resolve; });
  network.listStations = async (filter) => { globalEntered(); await globalHeld; return original(filter); };
  const globallyBounded = new Hono(); globallyBounded.use("/*", authResolver({ keyStore: keys }));
  globallyBounded.route("/", tenantExecutionRoutes({ ...deps, execution: { token, tenants: { ...deps.execution.tenants!, limits: { burst: 20, maxInFlightPerTenant: 8, maxInFlight: 1 } } } }));
  const globalGet = (key: string) => globallyBounded.request("/tenant/execution", { headers: { authorization: `Bearer ${key}` } });
  const globalFirst = globalGet(a.key); await globalStarted;
  assert.equal((await globalGet(b.key)).status, 429);
  globalRelease(); assert.equal((await globalFirst).status, 200);
  assert.equal((await globalGet(b.key)).status, 200);
});

test("tenant mapping ignores inherited prototype keys", async () => {
  const network = new StationNetworkMemoryAdapter();
  const app = new Hono();
  app.use("/*", async (c, next) => { c.set("authType", "api-key"); c.set("apiKeyId", "__proto__"); c.set("scopes", ["execution"]); return next(); });
  app.route("/", tenantExecutionRoutes({ execution: { token, tenants: { apiKeyTenants: {} } }, adapter: network, networkId: "tenants", stationId: "hq", role: "headquarters" }));
  assert.equal((await app.request("/tenant/execution")).status, 403);
});
