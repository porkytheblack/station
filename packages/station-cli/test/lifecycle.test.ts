import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localStatus, stopLocal, startLocal, type LaunchSpec } from "../dist/lifecycle.js";
const exec = promisify(execFile);
async function freePort() { const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("No port"); await new Promise<void>((resolve) => server.close(() => resolve())); return address.port; }
test("a separately launched service survives launcher exit and only its authenticated owner can stop it", { timeout: 30_000 }, async (t) => {
  if (process.platform === "win32") return;
  const home = await mkdtemp(join(tmpdir(), "station-managed-"));
  t.after(async () => { await stopLocal("daemon", "test", home).catch(() => {}); await rm(home, { recursive: true, force: true }); });
  const port = await freePort(), worker = join(home, "worker.mjs"), marker = join(home, "stopped");
  await writeFile(worker, `import{createServer}from'node:http';import{writeFileSync}from'node:fs';const s=createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({data:{ok:true}}))});s.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(marker)},'yes');s.close()});`);
  const spec: LaunchSpec = { kind: "daemon", instance: "test", entrypoint: worker, args: [], cwd: home, endpoint: `http://127.0.0.1:${port}`, home };
  const lifecycle = fileURLToPath(new URL("../dist/lifecycle.js", import.meta.url));
  const launcher = join(home, "launcher.mjs"); await writeFile(launcher, `import{startLocal}from ${JSON.stringify(lifecycle)};console.log(JSON.stringify(await startLocal(${JSON.stringify(spec)})));`);
  const launched = await exec(process.execPath, [launcher]); const result = JSON.parse(launched.stdout);
  assert.equal(result.status, "running"); assert.equal(result.apiReady, true);
  assert.equal((await localStatus("daemon", "test", home)).status, "running");
  assert.equal((await startLocal(spec)).pid, result.pid);
  await assert.rejects(startLocal({ ...spec, args: ["different"] }), /different launch configuration/);
  const state = JSON.parse(await readFile(join(home, "processes", "daemon-test", "state.json"), "utf8"));
  const denied = await fetch(`http://127.0.0.1:${state.controlPort}/stop`, { method: "POST", headers: { authorization: "Bearer wrong" } }); assert.equal(denied.status, 401);
  assert.equal((await localStatus("daemon", "test", home)).status, "running");
  assert.equal((await stopLocal("daemon", "test", home)).status, "stopped"); assert.equal(await readFile(marker, "utf8"), "yes");
});
test("stale instance state never signals an unrelated PID", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "station-stale-")); t.after(() => rm(home, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises"); const dir = join(home, "processes", "daemon-stale"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify({ pid: process.pid, token: "wrong", controlPort: await freePort(), status: "running", endpoint: "http://127.0.0.1:1" }));
  await assert.rejects(stopLocal("daemon", "stale", home), /No process was signalled/);
  assert.equal((await localStatus("daemon", "stale", home)).status, "unreachable");
});
