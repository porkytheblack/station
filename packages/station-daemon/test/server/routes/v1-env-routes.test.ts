import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { EnvStore, MemoryEnvStorage } from "station-env";
import { v1EnvRoutes, v1EnvReadRoutes } from "../../../src/server/routes/v1/env.js";

function makeApp() {
  const envStore = new EnvStore(new MemoryEnvStorage(), { cacheTtlMs: 0 });
  const app = new Hono();
  // Mount without scope guards — route semantics only; auth is tested elsewhere.
  app.route("/api/v1", v1EnvReadRoutes({ envStore }));
  app.route("/api/v1", v1EnvRoutes({ envStore }));
  return { app, envStore };
}

async function jsonRequest(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const init: RequestInit = {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(`http://localhost${path}`, init);
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, data: parsed };
}

test("POST /env + GET /env round-trips a non-secret var", async () => {
  const { app } = makeApp();
  const create = await jsonRequest(app, "POST", "/api/v1/env", { key: "API_URL", value: "https://x" });
  assert.equal(create.status, 201);
  const list = await jsonRequest(app, "GET", "/api/v1/env");
  const data = (list.data as { data: Array<{ key: string; value: string | null }> }).data;
  assert.equal(data.length, 1);
  assert.equal(data[0].key, "API_URL");
  assert.equal(data[0].value, "https://x");
});

test("secret var value is never returned through the API", async () => {
  const { app } = makeApp();
  const create = await jsonRequest(app, "POST", "/api/v1/env", { key: "TOKEN", value: "sk_live_x", secret: true });
  // The creation response is already redacted.
  assert.equal((create.data as { data: { value: string | null } }).data.value, null);
  const list = await jsonRequest(app, "GET", "/api/v1/env");
  const data = (list.data as { data: Array<{ value: string | null; secret: boolean }> }).data;
  assert.equal(data[0].value, null);
  assert.equal(data[0].secret, true);
});

test("POST /env 400s on a reserved key", async () => {
  const { app } = makeApp();
  const res = await jsonRequest(app, "POST", "/api/v1/env", { key: "PATH", value: "/evil" });
  assert.equal(res.status, 400);
});

test("POST /env 400s on a conflicting global key", async () => {
  const { app } = makeApp();
  await jsonRequest(app, "POST", "/api/v1/env", { key: "K", value: "1" });
  const res = await jsonRequest(app, "POST", "/api/v1/env", { key: "K", value: "2" });
  assert.equal(res.status, 400);
});

test("PATCH /env/:id updates the value", async () => {
  const { app, envStore } = makeApp();
  const create = await jsonRequest(app, "POST", "/api/v1/env", { key: "K", value: "old" });
  const id = (create.data as { data: { id: string } }).data.id;
  const patch = await jsonRequest(app, "PATCH", `/api/v1/env/${id}`, { value: "new" });
  assert.equal(patch.status, 200);
  // The stored value changed (resolveFor exposes the real value).
  const resolved = await envStore.resolveFor({ kind: "signal", name: "any" });
  assert.equal(resolved.K, "new");
});

test("DELETE /env/:id removes the var", async () => {
  const { app } = makeApp();
  const create = await jsonRequest(app, "POST", "/api/v1/env", { key: "K", value: "1" });
  const id = (create.data as { data: { id: string } }).data.id;
  const del = await jsonRequest(app, "DELETE", `/api/v1/env/${id}`);
  assert.equal(del.status, 200);
  const missing = await jsonRequest(app, "DELETE", `/api/v1/env/${id}`);
  assert.equal(missing.status, 404);
});

test("POST /env with a non-object body is a 400, not a 500", async () => {
  const { app } = makeApp();
  // Body is valid JSON but not an object — must not crash on `"key" in body`.
  const res = await app.request("http://localhost/api/v1/env", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "null",
  });
  assert.equal(res.status, 400);
});

test("PATCH /env/:id with a non-object body is a 400, not a 500", async () => {
  const { app } = makeApp();
  const create = await jsonRequest(app, "POST", "/api/v1/env", { key: "K", value: "1" });
  const id = (create.data as { data: { id: string } }).data.id;
  const res = await app.request(`http://localhost/api/v1/env/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: "null",
  });
  assert.equal(res.status, 400);
});

test("scoped var round-trips its targets", async () => {
  const { app } = makeApp();
  const create = await jsonRequest(app, "POST", "/api/v1/env", {
    key: "SCOPED",
    value: "v",
    targets: [{ kind: "signal", name: "worker" }],
  });
  assert.equal(create.status, 201);
  const targets = (create.data as { data: { targets: Array<{ kind: string; name: string }> } }).data.targets;
  assert.deepEqual(targets, [{ kind: "signal", name: "worker" }]);
});
