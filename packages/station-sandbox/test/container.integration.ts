import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerSandboxAdapter } from "../src/container.js";
import { engineCall } from "../src/container-engine.js";

const executable = process.env.STATION_CONTAINER_ENGINE;
const image = process.env.STATION_CONTAINER_IMAGE ?? "docker.io/library/node:22-bookworm-slim";
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
async function completed(adapter: ContainerSandboxAdapter, id: string, command: string, timeoutMs = 30_000) {
  const started = await adapter.exec(id, { command, timeoutMs });
  const deadline = Date.now() + timeoutMs + 15_000;
  while (Date.now() < deadline) {
    const current = await adapter.command(id, started.id);
    if (current.status !== "running") return current;
    await pause();
  }
  throw new Error("Command did not finish");
}

test("real Linux container: isolation, npm persistence, files, quotas, services and PTY", { skip: !executable, timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-container-"));
  const options = { rootDir: root, image, engine: (executable!.includes("podman") ? "podman" : "docker") as "podman" | "docker", executable, network: "bridge" as const, maxEnvironments: 2, maxConcurrent: 3, maxOutputBytes: 4096, memoryMb: 384, cpus: 0.5, pidsLimit: 64 };
  let adapter = new ContainerSandboxAdapter(options);
  const ids: string[] = [];
  t.after(async () => {
    try { for (const id of ids) { for (const service of await adapter.services(id)) await adapter.removeService(id, service.id); for (const terminal of await adapter.terminals(id)) await adapter.closeTerminal(id, terminal.id); await adapter.destroy(id); } } finally { await adapter.close(); rmSync(root, { recursive: true, force: true }); }
  });
  await adapter.ready();
  assert.throws(() => new ContainerSandboxAdapter(options), /owner|controller/i);
  const one = await adapter.create(); ids.push(one.id);
  const two = await adapter.create(); ids.push(two.id);
  await assert.rejects(adapter.create(), /capacity/);
  const security = await completed(adapter, one.id, "id -u; grep CapEff /proc/self/status; test ! -e /var/run/docker.sock && test ! -e /run/podman/podman.sock; test ! -w /etc; printf private > private.txt");
  assert.equal(security.status, "completed", security.stderr);
  assert.match(security.stdout, /1000/); assert.match(security.stdout, /CapEff:\s+0+/);
  assert.equal((await completed(adapter, two.id, "test ! -e private.txt")).status, "completed");
  const meta = JSON.parse(readFileSync(join(root, one.id, "workspace.json"), "utf8"));
  const details = JSON.parse(await engineCall(executable!, ["inspect", meta.container]))[0];
  assert.equal(details.HostConfig.Memory, 384 * 1024 * 1024);
  assert.equal(details.HostConfig.PidsLimit, 64);
  assert.equal(details.HostConfig.ReadonlyRootfs, true);
  assert.ok(details.HostConfig.SecurityOpt.some((value: string) => value.startsWith("no-new-privileges")));
  assert.equal(details.Config.User, "1000:1000");
  assert.equal(details.Mounts.filter((mount: any) => mount.Type === "bind").length, 0);
  await adapter.writeFile(one.id, "nested/message.txt", { base64: Buffer.from("persisted-file").toString("base64"), createParents: true });
  assert.equal(Buffer.from((await adapter.readFile(one.id, "nested/message.txt")).base64, "base64").toString(), "persisted-file");
  assert.ok((await adapter.listFiles(one.id, "nested")).entries.some((entry) => entry.name === "message.txt" && entry.type === "file"));
  await assert.rejects(adapter.readFile(one.id, "../../etc/passwd"));
  const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === expected);
  await assert.rejects(adapter.readFile(one.id, "missing.txt"), code("not_found"));
  await assert.rejects(adapter.listFiles(one.id, "missing-directory"), code("not_found"));
  await assert.rejects(adapter.removeFile(one.id, "missing.txt"), code("not_found"));
  await assert.rejects(adapter.writeFile(one.id, "missing-parent/file", { base64: "eA==" }), code("not_found"));
  await assert.rejects(adapter.readFile(one.id, "nested"), code("invalid_input"));
  await assert.rejects(adapter.readFile(one.id, "nested/message.txt", { offset: 99999 }), code("invalid_input"));
  assert.equal((await completed(adapter, one.id, "ln -s nested/message.txt link-file; ln -s nested link-dir")).status, "completed");
  await assert.rejects(adapter.readFile(one.id, "link-file"), code("invalid_input"));
  await assert.rejects(adapter.writeFile(one.id, "link-dir/unsafe.txt", { base64: "eA==" }), code("invalid_input"));
  assert.equal((await completed(adapter, one.id, "rm link-file link-dir")).status, "completed");
  // Workload PATH remains customizable, but adapter helpers must come from the immutable image.
  for (const tool of ["node", "setsid"]) await adapter.writeFile(one.id, `node_modules/.bin/${tool}`, { base64: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64"), createParents: true });
  assert.equal((await completed(adapter, one.id, "/bin/chmod +x node_modules/.bin/node node_modules/.bin/setsid")).status, "completed");
  assert.equal(Buffer.from((await adapter.readFile(one.id, "nested/message.txt")).base64, "base64").toString(), "persisted-file");
  const protectedRun = await adapter.exec(one.id, { command: "while true; do printf x >> cancellation-marker; /bin/sleep .05; done" });
  await pause(300);
  assert.equal((await adapter.command(one.id, protectedRun.id)).status, "running");
  await adapter.cancel(one.id, protectedRun.id);
  const stoppedBytes = (await adapter.readFile(one.id, "cancellation-marker")).totalBytes;
  await pause(300);
  assert.equal((await adapter.readFile(one.id, "cancellation-marker")).totalBytes, stoppedBytes);
  for (const tool of ["node", "setsid"]) await adapter.removeFile(one.id, `node_modules/.bin/${tool}`);
  const install = await completed(adapter, one.id, "npm install --global semver@7.7.3 --no-audit --no-fund && semver 1.2.3", 120_000);
  assert.equal(install.status, "completed", install.stderr); assert.match(install.stdout, /1\.2\.3/);
  const long = await adapter.exec(one.id, { command: "sleep 30", timeoutMs: 60_000 });
  assert.equal((await adapter.cancel(one.id, long.id)).status, "cancelled");
  const timeout = await completed(adapter, one.id, "sleep 30", 200);
  assert.equal(timeout.status, "timed_out");
  const large = await completed(adapter, one.id, "node -e 'process.stdout.write(\"x\".repeat(50000))'");
  assert.equal(large.truncated, true); assert.ok(Buffer.byteLength(large.stdout) <= 4096);
  const service = await adapter.startService(one.id, { name: "server", command: "node -e 'require(\"http\").createServer((q,s)=>s.end(\"container-service\")).listen(8080,\"127.0.0.1\")'" });
  await pause(300);
  assert.equal((await adapter.service(one.id, service.id)).status, "running");
  const response = await completed(adapter, one.id, "node -e 'fetch(\"http://127.0.0.1:8080\").then(r=>r.text()).then(console.log)'");
  assert.match(response.stdout, /container-service/);
  await adapter.stopService(one.id, service.id);
  assert.equal((await adapter.service(one.id, service.id)).status, "stopped");
  await adapter.removeService(one.id, service.id);
  assert.equal(adapter.capabilities.pty, true, "Production terminal test requires node-pty");
  const terminal = await adapter.openTerminal(one.id, { cols: 90, rows: 25 });
  await adapter.terminalInput(one.id, terminal.id, "printf 'pty-%s\n' works; printf 'π🙂\n'\r");
  const deadline = Date.now() + 15_000;
  let output = "";
  while (Date.now() < deadline) { output = (await adapter.terminal(one.id, terminal.id)).data; if (output.includes("pty-works")) break; await pause(); }
  assert.match(output, /pty-works/);
  await adapter.resizeTerminal(one.id, terminal.id, 110, 35);
  assert.equal((await adapter.terminal(one.id, terminal.id)).cols, 110);
  await adapter.closeTerminal(one.id, terminal.id);
  const transcript = await adapter.terminal(one.id, terminal.id);
  assert.match(transcript.data, /π🙂/);
  assert.equal(transcript.nextOffset - transcript.startOffset, Buffer.byteLength(transcript.data));
  const split = transcript.startOffset + Buffer.from(transcript.data).indexOf(Buffer.from("π")) + 1;
  const sliced = await adapter.terminal(one.id, terminal.id, split);
  assert.equal(sliced.offset, split + 1);
  assert.ok(!sliced.data.startsWith("�"));
  await adapter.close();
  const wrongNetwork = new ContainerSandboxAdapter({ ...options, network: "none" });
  await assert.rejects(wrongNetwork.ready(), /network differs/);
  await wrongNetwork.close();
  adapter = new ContainerSandboxAdapter(options); await adapter.ready();
  assert.equal((await adapter.list()).length, 2);
  assert.equal(Buffer.from((await adapter.readFile(one.id, "nested/message.txt")).base64, "base64").toString(), "persisted-file");
  const restored = await completed(adapter, one.id, "semver 2.3.4"); assert.match(restored.stdout, /2\.3\.4/);
  await adapter.destroy(two.id); ids.pop();
  assert.equal((await adapter.list()).length, 1);
});

test("real Linux container: default network denied and concurrent admission bounded", { skip: !executable, timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-container-offline-"));
  const adapter = new ContainerSandboxAdapter({ rootDir: root, executable, image, engine: executable!.includes("podman") ? "podman" : "docker", maxEnvironments: 1, maxConcurrent: 1, tenantId: "customer-a" });
  await adapter.ready();
  await adapter.bindTenant("customer-a");
  await assert.rejects(adapter.bindTenant("customer-b"), /tenant/);
  await assert.rejects(adapter.bindTenant(), /tenant/);
  assert.equal(adapter.capabilities.networkRestricted, true);
  const workspace = await adapter.create();
  t.after(async () => { await adapter.destroy(workspace.id); await adapter.close(); rmSync(root, { recursive: true, force: true }); });
  const network = await completed(adapter, workspace.id, "node -e 'fetch(\"https://registry.npmjs.org\",{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(1),()=>console.log(\"network-denied\"))'");
  assert.equal(network.status, "completed"); assert.match(network.stdout, /network-denied/);
  const policy = await completed(adapter, workspace.id, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max /sys/fs/cgroup/cpu.max");
  assert.equal(policy.status, "completed"); assert.match(policy.stdout, /536870912/); assert.match(policy.stdout, /128/); assert.match(policy.stdout, /100000 100000/);
  const competing = await Promise.allSettled([adapter.exec(workspace.id, { command: "sleep 20" }), adapter.exec(workspace.id, { command: "sleep 20" })]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of competing) if (result.status === "fulfilled") await adapter.cancel(workspace.id, result.value.id);
});

test("real Linux container: killed controller reconciles jobs and restores service intent", { skip: !executable, timeout: 90_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = mkdtempSync(join(tmpdir(), "station-container-recovery-"));
  const options = { rootDir: root, executable, image, engine: executable!.includes("podman") ? "podman" as const : "docker" as const };
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./container-crash-worker.ts", import.meta.url)), JSON.stringify(options)], { stdio: ["ignore", "pipe", "pipe"] });
  let adapter: ContainerSandboxAdapter | undefined;
  t.after(async () => { child.kill("SIGKILL"); if (adapter) { for (const workspace of await adapter.list()) { for (const service of await adapter.services(workspace.id)) await adapter.removeService(workspace.id, service.id); await adapter.destroy(workspace.id); } await adapter.close(); } rmSync(root, { recursive: true, force: true }); });
  const ready = await new Promise<any>((resolveReady, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => { buffer += chunk; if (buffer.includes("\n")) { try { resolveReady(JSON.parse(buffer.split("\n")[0])); } catch (e) { reject(e); } } });
    child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("exit", (code) => { if (!buffer.includes("\n")) reject(new Error(`Recovery fixture exited before ready: ${code}`)); });
  });
  await new Promise<void>((resolveExit) => { child.once("exit", () => resolveExit()); child.kill("SIGKILL"); });
  adapter = new ContainerSandboxAdapter(options); await adapter.ready();
  const interrupted = await adapter.command(ready.workspace.id, ready.run.id);
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.stdout, /recovery-checkpoint/);
  const deadline = Date.now() + 10_000;
  while ((await adapter.service(ready.workspace.id, ready.service.id)).status !== "running" && Date.now() < deadline) await pause();
  assert.equal((await adapter.service(ready.workspace.id, ready.service.id)).status, "running");
  await adapter.stopService(ready.workspace.id, ready.service.id);
});
