import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { BeaconMemoryAdapter, BeaconRunner } from "station-beacon";
import {
  v1BeaconReadRoutes,
  v1BeaconStartRoutes,
  v1BeaconStopRoutes,
  v1BeaconAdminRoutes,
} from "../../../src/server/routes/v1/beacons.js";
import { serverBeacon, workerBeacon } from "./fixtures/beacons.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/beacons.ts", import.meta.url));

async function makeApp() {
  const beaconRunner = new BeaconRunner({ adapter: new BeaconMemoryAdapter(), pollIntervalMs: 5_000 });
  beaconRunner.register(workerBeacon, FIXTURE);
  beaconRunner.register(serverBeacon, FIXTURE);
  // start() runs the supervision loop forever, so await readiness (discovery +
  // seeding) rather than the call itself.
  beaconRunner.start().catch(() => {});
  await beaconRunner.whenReady();

  const app = new Hono();
  // Mounted without scope guards — these tests cover route semantics; auth is
  // covered elsewhere.
  app.route("/api/v1", v1BeaconReadRoutes({ beaconRunner }));
  app.route("/api/v1", v1BeaconStartRoutes({ beaconRunner }));
  app.route("/api/v1", v1BeaconStopRoutes({ beaconRunner }));
  app.route("/api/v1", v1BeaconAdminRoutes({ beaconRunner }));

  return {
    app,
    beaconRunner,
    cleanup: () => beaconRunner.stop({ graceful: false }),
  };
}

async function req(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const init: RequestInit = { method, headers: body ? { "Content-Type": "application/json" } : {} };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(`http://localhost${path}`, init);
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, data: parsed };
}

test("GET /beacons lists definitions with their instances and start mode", async () => {
  const { app, cleanup } = await makeApp();
  try {
    const { status, data } = await req(app, "GET", "/api/v1/beacons");
    assert.equal(status, 200);
    const worker = data.data.find((b: any) => b.name === "worker");
    const server = data.data.find((b: any) => b.name === "server");

    assert.equal(worker.startMode, "on-demand");
    assert.equal(worker.maxInstances, 2);
    assert.equal(worker.instance, null, "on-demand beacons seed no instance");
    assert.deepEqual(worker.instances, []);

    assert.equal(server.startMode, "manual");
    assert.equal(server.instance.id, "server", "manual beacons seed one, stopped");
    assert.equal(server.instance.desiredState, "stopped");
    assert.equal(server.instanceCount, 1);
    assert.equal(server.runningCount, 0);
  } finally { await cleanup(); }
});

test("GET /beacons/:name exposes the config schema for building an instance", async () => {
  const { app, cleanup } = await makeApp();
  try {
    const { status, data } = await req(app, "GET", "/api/v1/beacons/worker");
    assert.equal(status, 200);
    assert.equal(data.data.configSchema.type, "object");
    assert.equal(data.data.configSchema.properties.queue.type, "string");

    assert.equal((await req(app, "GET", "/api/v1/beacons/nope")).status, 404);
  } finally { await cleanup(); }
});

test("POST /beacons/:name/instances creates an instance with its own config", async () => {
  const { app, cleanup } = await makeApp();
  try {
    const created = await req(app, "POST", "/api/v1/beacons/worker/instances", {
      id: "worker-alpha",
      label: "alpha queue",
      config: { queue: "alpha" },
      start: false,
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.data.id, "worker-alpha");
    assert.equal(created.data.data.beaconName, "worker");
    assert.equal(created.data.data.origin, "api");
    assert.equal(created.data.data.label, "alpha queue");
    assert.equal(created.data.data.config, JSON.stringify({ queue: "alpha" }));
    assert.equal(created.data.data.desiredState, "stopped");

    const list = await req(app, "GET", "/api/v1/beacons/worker/instances");
    assert.deepEqual(list.data.data.map((i: any) => i.id), ["worker-alpha"]);

    const one = await req(app, "GET", "/api/v1/beacons/worker/instances/worker-alpha");
    assert.equal(one.status, 200);
    assert.equal(one.data.data.id, "worker-alpha");
  } finally { await cleanup(); }
});

test("instance creation surfaces validation, conflict, and limit failures distinctly", async () => {
  const { app, cleanup } = await makeApp();
  try {
    const badConfig = await req(app, "POST", "/api/v1/beacons/worker/instances", {
      config: { queue: 42 },
      start: false,
    });
    assert.equal(badConfig.status, 400);
    assert.equal(badConfig.data.error, "invalid_config");

    const unknown = await req(app, "POST", "/api/v1/beacons/ghost/instances", { start: false });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.data.error, "not_found");

    await req(app, "POST", "/api/v1/beacons/worker/instances", {
      id: "dup",
      config: { queue: "a" },
      start: false,
    });
    const conflict = await req(app, "POST", "/api/v1/beacons/worker/instances", {
      id: "dup",
      config: { queue: "b" },
      start: false,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, "instance_exists");

    // maxInstances(2): "dup" plus one more fills the cap.
    await req(app, "POST", "/api/v1/beacons/worker/instances", {
      id: "second",
      config: { queue: "b" },
      start: false,
    });
    const overCap = await req(app, "POST", "/api/v1/beacons/worker/instances", {
      id: "third",
      config: { queue: "c" },
      start: false,
    });
    assert.equal(overCap.status, 409);
    assert.equal(overCap.data.error, "instance_limit");
  } finally { await cleanup(); }
});

test("stop / start / restart target a single instance", async () => {
  const { app, cleanup } = await makeApp();
  try {
    await req(app, "POST", "/api/v1/beacons/worker/instances", {
      id: "w1",
      config: { queue: "one" },
      start: false,
    });

    const started = await req(app, "POST", "/api/v1/beacons/worker/instances/w1/start");
    assert.equal(started.status, 200);
    assert.equal(
      (await req(app, "GET", "/api/v1/beacons/worker/instances/w1")).data.data.desiredState,
      "running",
    );

    const stopped = await req(app, "POST", "/api/v1/beacons/worker/instances/w1/stop");
    assert.equal(stopped.status, 200);
    assert.equal(
      (await req(app, "GET", "/api/v1/beacons/worker/instances/w1")).data.data.desiredState,
      "stopped",
    );

    assert.equal((await req(app, "POST", "/api/v1/beacons/worker/instances/w1/restart")).status, 200);
  } finally { await cleanup(); }
});

test("an instance id is only addressable under the beacon that owns it", async () => {
  const { app, cleanup } = await makeApp();
  try {
    await req(app, "POST", "/api/v1/beacons/worker/instances", { id: "w1", config: { queue: "one" }, start: false });

    // Same id, wrong beacon in the path — must not resolve.
    assert.equal((await req(app, "GET", "/api/v1/beacons/server/instances/w1")).status, 404);
    assert.equal((await req(app, "POST", "/api/v1/beacons/server/instances/w1/stop")).status, 404);
    assert.equal((await req(app, "DELETE", "/api/v1/beacons/server/instances/w1")).status, 404);
    assert.equal((await req(app, "GET", "/api/v1/beacons/worker/instances/w1")).status, 200);
  } finally { await cleanup(); }
});

test("PATCH updates config and DELETE removes a runtime instance", async () => {
  const { app, cleanup } = await makeApp();
  try {
    await req(app, "POST", "/api/v1/beacons/worker/instances", {
      id: "w1",
      config: { queue: "before" },
      start: false,
    });

    const patched = await req(app, "PATCH", "/api/v1/beacons/worker/instances/w1", {
      config: { queue: "after" },
      label: "renamed",
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.data.config, JSON.stringify({ queue: "after" }));
    assert.equal(patched.data.data.label, "renamed");

    const badPatch = await req(app, "PATCH", "/api/v1/beacons/worker/instances/w1", {
      config: { queue: 7 },
    });
    assert.equal(badPatch.status, 400);
    assert.equal(badPatch.data.error, "invalid_config");

    const deleted = await req(app, "DELETE", "/api/v1/beacons/worker/instances/w1");
    assert.equal(deleted.status, 200);
    assert.equal((await req(app, "GET", "/api/v1/beacons/worker/instances/w1")).status, 404);
    assert.deepEqual((await req(app, "GET", "/api/v1/beacons/worker/instances")).data.data, []);
  } finally { await cleanup(); }
});

test("a definition-owned instance cannot be deleted through the API", async () => {
  const { app, cleanup } = await makeApp();
  try {
    const res = await req(app, "DELETE", "/api/v1/beacons/server/instances/server");
    assert.equal(res.status, 400);
    assert.match(res.data.message, /cannot be deleted/);
    assert.equal((await req(app, "GET", "/api/v1/beacons/server/instances/server")).status, 200);
  } finally { await cleanup(); }
});

test("definition-level start reports why an on-demand beacon has nothing to start", async () => {
  const { app, cleanup } = await makeApp();
  try {
    const res = await req(app, "POST", "/api/v1/beacons/worker/start");
    assert.equal(res.status, 400);
    assert.match(res.data.message, /on-demand/);

    assert.equal((await req(app, "POST", "/api/v1/beacons/server/start")).status, 200);
  } finally { await cleanup(); }
});

test("POST /beacons/:name/stop?all=true stops every instance of the beacon", async () => {
  const { app, cleanup } = await makeApp();
  try {
    await req(app, "POST", "/api/v1/beacons/worker/instances", { id: "w1", config: { queue: "a" } });
    await req(app, "POST", "/api/v1/beacons/worker/instances", { id: "w2", config: { queue: "b" } });

    const res = await req(app, "POST", "/api/v1/beacons/worker/stop?all=true");
    assert.equal(res.status, 200);
    assert.equal(res.data.data.count, 2);

    const list = await req(app, "GET", "/api/v1/beacons/worker/instances");
    assert.deepEqual(
      list.data.data.map((i: any) => i.desiredState),
      ["stopped", "stopped"],
    );
  } finally { await cleanup(); }
});
