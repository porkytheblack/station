import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStore } from "../src/store.js";
import { parseArgs } from "../src/commands.js";
test("saved contexts are private, immutable by add, and listings exclude credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "station-context-")); t.after(() => rm(dir, { force: true, recursive: true }));
  const store = new ContextStore(dir);
  await store.add("prod", { url: "https://hq.example", token: "sk_private", stationId: "hq" });
  assert.equal((await store.resolve()).connection.token, "sk_private");
  assert.equal(JSON.stringify(await store.list()).includes("sk_private"), false);
  if (process.platform !== "win32") { assert.equal((await stat(join(dir, "contexts.json"))).mode & 0o777, 0o600); assert.equal((await stat(dir)).mode & 0o777, 0o700); }
  await assert.rejects(store.add("prod", { url: "https://different.example" }), /already exists/);
  await assert.rejects(store.add("../outside", { url: "https://hq.example" }), /Names/);
  await store.add("local", { url: "http://127.0.0.1:4400" }); await store.use("local"); assert.equal((await store.resolve()).name, "local");
  await store.remove("local"); await assert.rejects(store.resolve(), /No saved context/);
});
test("insecure context credentials and directory symlinks fail closed", async (t) => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "station-context-")); t.after(() => rm(dir, { force: true, recursive: true }));
  const home = join(dir, "home"), store = new ContextStore(home); await store.add("test", { url: "https://hq.example" });
  await chmod(join(home, "contexts.json"), 0o644); await assert.rejects(store.read(), /0600/);
  await symlink(home, join(dir, "link")); await assert.rejects(new ContextStore(join(dir, "link")).read(), /real directory/);
});
test("argument parser rejects duplicate/unknown options and supports JSON values containing equals", () => {
  assert.deepEqual(parseArgs(["api", "POST", "/trigger", '--json={"input":"a=b"}']).flags.json, '{"input":"a=b"}');
  assert.throws(() => parseArgs(["daemon", "stop", "--force"]), /Unknown option/);
  assert.throws(() => parseArgs(["--port", "1", "--port", "2"]), /Duplicate/);
  assert.throws(() => parseArgs(["--context"]), /needs a value/);
});
test("registry lifecycle commands keep reference and export separate and surface unavailable capability", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "station-cli-registry-")); t.after(() => rm(dir, { force: true, recursive: true }));
  const store = new ContextStore(dir); await store.add("test", { url: "https://hq.example", token: "sk_test" });
  const requests: { path: string; method?: string; body: unknown }[] = [];
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/info")) return new Response(JSON.stringify({ data: { protocol: "station.api/v1", version: "3.0.0", stationId: "hq", role: "headquarters", capabilities: ["registry"] } }));
    requests.push({ path, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/pull")) return new Response(JSON.stringify({ error: "upstream_not_configured" }), { status: 409 });
    return new Response(JSON.stringify({ data: { accepted: true } }));
  };
  const { run } = await import("../src/commands.js");
  await run(parseArgs(["images", "install", "acme/tools@1.0.0"]), store);
  await run(parseArgs(["images", "run", "acme/tools@1.0.0", "resize", "--input", '{"width":640}', "--station", "worker-a"]), store);
  await assert.rejects(run(parseArgs(["images", "pull", "acme/tools@1.0.0"]), store), /upstream_not_configured/);
  assert.deepEqual(requests, [
    { path: "/api/v1/registry/install", method: "POST", body: { reference: "acme/tools@1.0.0" } },
    { path: "/api/v1/registry/run", method: "POST", body: { reference: "acme/tools@1.0.0", export: "resize", input: { width: 640 }, stationId: "worker-a" } },
    { path: "/api/v1/registry/pull", method: "POST", body: { reference: "acme/tools@1.0.0" } },
  ]);
});

test("private registry target routing stays separate from image execution pinning", async t => {
  const dir = await mkdtemp(join(tmpdir(), "station-cli-target-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ContextStore(dir); await store.add("hq", { url: "https://hq.example" });
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const calls: { path: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/info")) return new Response(JSON.stringify({ data: { protocol: "station.api/v1", version: "3.0.0", stationId: "hq" } }));
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ data: [] }));
  };
  const { run } = await import("../src/commands.js");
  await run(parseArgs(["images", "list", "--station", "worker-a"]), store);
  await run(parseArgs(["images", "install", "acme/echo@1.0.0", "--station", "worker-a"]), store);
  await run(parseArgs(["deployments", "list", "--station", "worker-a"]), store);
  await run(parseArgs(["images", "run", "acme/echo@1.0.0", "echo", "--station", "worker-a"]), store);
  assert.deepEqual(calls, [
    { path: "/api/v1/stations/worker-a/registry/images", body: undefined },
    { path: "/api/v1/stations/worker-a/registry/install", body: { reference: "acme/echo@1.0.0" } },
    { path: "/api/v1/stations/worker-a/registry/deployments", body: undefined },
    { path: "/api/v1/registry/run", body: { reference: "acme/echo@1.0.0", export: "echo", input: {}, stationId: "worker-a" } },
  ]);
});
