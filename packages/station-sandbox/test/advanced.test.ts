import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HostSandboxAdapter } from "../src/index.js";

async function setup(t: Parameters<Parameters<typeof test>[1]>[0], options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "station advanced "));
  const host = new HostSandboxAdapter({ rootDir, ...options });
  t.after(async () => { await host.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { host, rootDir, workspace: await host.create() };
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Condition did not become true.");
}

test("exclusive ownership rejects live managers and safely recovers known-dead host owners", async (t) => {
  const { host, rootDir } = await setup(t);
  assert.throws(() => new HostSandboxAdapter({ rootDir }), /owner/);
  await host.close();
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(dead.status, 0);
  writeFileSync(join(rootDir, ".station-owner.json"), JSON.stringify({ pid: Number(dead.stdout), hostname: hostname(), token: "dead-owner" }));
  const recovered = new HostSandboxAdapter({ rootDir }); await recovered.close();
  writeFileSync(join(rootDir, ".station-owner.json"), JSON.stringify({ pid: Number(dead.stdout), hostname: "other-host", token: "unknown-owner" }));
  assert.throws(() => new HostSandboxAdapter({ rootDir }), /owner/);
  assert.match(readFileSync(join(rootDir, ".station-owner.json"), "utf8"), /other-host/);
});

test("file APIs page directories, read bounded ranges, write atomically and reject symlink traversal", async (t) => {
  const { host, rootDir, workspace } = await setup(t, { maxFileBytes: 8 });
  const id = workspace.id;
  await host.writeFile(id, "folder/a.txt", { base64: Buffer.from("abcdefgh").toString("base64"), createParents: true });
  await host.writeFile(id, "folder/b.txt", { base64: "" });
  const first = await host.listFiles(id, "folder", { limit: 1 });
  assert.equal(first.entries.length, 1); assert.equal(first.nextOffset, 1);
  const second = await host.listFiles(id, "folder", { offset: first.nextOffset, limit: 1 });
  assert.equal(second.entries.length, 1); assert.equal(second.nextOffset, undefined);
  assert.deepEqual([...first.entries, ...second.entries].map((entry) => entry.name).sort(), ["a.txt", "b.txt"]);
  const chunk = await host.readFile(id, "folder/a.txt", { offset: 2, length: 3 });
  assert.equal(Buffer.from(chunk.base64, "base64").toString(), "cde"); assert.equal(chunk.nextOffset, 5); assert.equal(chunk.totalBytes, 8);
  await assert.rejects(host.readFile(id, "folder/a.txt", { length: 9 }), /bound/);
  await assert.rejects(host.writeFile(id, "big", { base64: Buffer.from("123456789").toString("base64") }), /limit/);
  await assert.rejects(host.writeFile(id, "bad", { base64: "%%%" }), /base64/);
  await assert.rejects(host.writeFile(id, "../escape", { base64: "" }), /traversal/);
  symlinkSync(tmpdir(), join(rootDir, id, "workspace/escape"));
  await assert.rejects(host.readFile(id, "escape/file"), /Symlink/);
  await assert.rejects(host.writeFile(id, "escape/new", { base64: "" }), /Symlink/);
  await assert.rejects(host.removeFile(id, "escape", { recursive: true }), /Symlink/);
  await assert.rejects(host.removeFile(id, ".", { recursive: true }), /root/);
  await host.removeFile(id, "folder", { recursive: true });
  await assert.rejects(host.readFile(id, "folder/a.txt"), /exist/);
});

test("real PTYs preserve shell state, resize, reconnect offsets and bounded output", { skip: "Bun" in globalThis ? "Native PTY requires a Node controller" : false }, async (t) => {
  const { host, rootDir, workspace } = await setup(t, { enablePty: true, maxOutputBytes: 256, maxTerminals: 1 });
  const terminal = await host.openTerminal(workspace.id, { cols: 80, rows: 24 });
  await assert.rejects(host.openTerminal(workspace.id), /capacity/);
  await host.terminalInput(workspace.id, terminal.id, "export STATION_TERMINAL_VALUE=retained\r");
  await host.terminalInput(workspace.id, terminal.id, "printf 'value:%s\\n' \"$STATION_TERMINAL_VALUE\"\r");
  const result = await until(() => host.terminal(workspace.id, terminal.id), (value) => value.data.includes("value:retained"));
  await assert.rejects(host.resizeTerminal(workspace.id, terminal.id, 0, 40), /bound/);
  await assert.rejects(host.terminalInput(workspace.id, terminal.id, "x".repeat(65_537)), /limit/);
  await host.resizeTerminal(workspace.id, terminal.id, 100, 40);
  await host.terminalInput(workspace.id, terminal.id, "stty size\r");
  const resized = await until(() => host.terminal(workspace.id, terminal.id, result.nextOffset), (value) => value.data.includes("40 100"));
  assert.equal(resized.cols, 100); assert.equal(resized.rows, 40);
  await host.terminalInput(workspace.id, terminal.id, "printf '%1000s' x; printf '\\nTAIL_MARKER\\n'\r");
  const bounded = await until(() => host.terminal(workspace.id, terminal.id), (value) => value.data.includes("TAIL_MARKER") && value.truncated);
  assert.ok(Buffer.byteLength(bounded.data) <= 256); assert.ok(bounded.startOffset > 0);
  await assert.rejects(host.destroy(workspace.id), /Cancel/);
  await host.close();
  const recovered = new HostSandboxAdapter({ rootDir });
  t.after(() => recovered.close());
  assert.equal((await recovered.terminals(workspace.id))[0].status, "interrupted");
  assert.equal((await recovered.terminal(workspace.id, terminal.id)).data, "");
});

test("supervised HTTP services restart explicitly and recover definitions without automatic replay", async (t) => {
  const { host, rootDir, workspace } = await setup(t);
  const code = `require('http').createServer((q,s)=>s.end('station-service')).listen(0,'127.0.0.1',function(){console.log('PORT:'+this.address().port)})`;
  await host.writeFile(workspace.id, "server.cjs", { base64: Buffer.from(code).toString("base64") });
  const started = await host.startService(workspace.id, { name: "http", command: "printf 'WRAPPER_READY\\n'; node server.cjs" });
  const ready = await until(() => host.service(workspace.id, started.id), (value) => value.stdout.includes("PORT:"));
  const port = Number(ready.stdout.match(/PORT:(\d+)/)![1]);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "station-service");
  await assert.rejects(host.destroy(workspace.id), /Cancel/);
  const stopping = host.stopService(workspace.id, started.id);
  await assert.rejects(host.restartService(workspace.id, started.id), /already in progress/);
  await stopping;
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  await host.restartService(workspace.id, started.id);
  const restarted = await until(() => host.service(workspace.id, started.id), (value) => value.stdout.includes("PORT:"));
  assert.equal(restarted.history.length, 2);
  await host.close();
  const recovered = new HostSandboxAdapter({ rootDir });
  t.after(() => recovered.close());
  assert.equal((await recovered.service(workspace.id, started.id)).status, "interrupted");
  await recovered.restartService(workspace.id, started.id);
  await until(() => recovered.service(workspace.id, started.id), (value) => value.stdout.includes("PORT:"));
  assert.equal((await recovered.stopService(workspace.id, started.id)).status, "stopped");
  await recovered.removeService(workspace.id, started.id);
  assert.equal((await recovered.services(workspace.id)).length, 0);
});

test("restart policy bounds failed attempts and stopping during backoff prevents a later launch", async (t) => {
  const { host, workspace } = await setup(t, { maxServices: 1 });
  const started = await host.startService(workspace.id, { name: "fails", command: "printf failure; exit 1", restart: { policy: "on-failure", maxRestarts: 2, delayMs: 20 } });
  const failed = await until(() => host.service(workspace.id, started.id), (value) => value.status === "failed");
  assert.equal(failed.restartCount, 2); assert.equal(failed.history.length, 3);
  await assert.rejects(host.startService(workspace.id, { name: "extra", command: "true" }), /capacity/);
  await host.removeService(workspace.id, started.id);
  const delay = await host.startService(workspace.id, { name: "delay", command: "exit 1", restart: { policy: "always", maxRestarts: 1, delayMs: 500 } });
  await until(() => host.service(workspace.id, delay.id), (value) => value.status === "restarting");
  await host.stopService(workspace.id, delay.id);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const stopped = await host.service(workspace.id, delay.id);
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.history.length, 1);
});

if ("Bun" in globalThis) test("Bun controllers reject unsupported native PTY before accepting work", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "station-bun-pty-"));
  try { assert.throws(() => new HostSandboxAdapter({ rootDir, enablePty: true }), /require a Node controller/); }
  finally { rmSync(rootDir, { recursive: true, force: true }); }
});
