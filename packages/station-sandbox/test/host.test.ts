import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostSandboxAdapter } from "../src/index.js";

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0], options = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "station sandbox-"));
  const host = new HostSandboxAdapter({ rootDir, ...options });
  t.after(async () => { await host.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { host, rootDir };
}
async function finished(host: HostSandboxAdapter, id: string, runId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await host.command(id, runId);
    if (run.finishedAt) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Command did not finish.");
}
test("real bash, per-workspace home, output, exit status and disk recovery", async (t) => {
  const { host, rootDir } = await fixture(t);
  const sandbox = await host.create();
  const start = await host.exec(sandbox.id, { command: "printf hello > greeting; printf world; printf error >&2; exit 7" });
  const end = await finished(host, sandbox.id, start.id);
  assert.equal(end.status, "failed"); assert.equal(end.exitCode, 7);
  assert.equal(end.stdout, "world"); assert.equal(end.stderr, "error");
  await host.close();
  const restored = new HostSandboxAdapter({ rootDir });
  assert.equal((await restored.get(sandbox.id)).id, sandbox.id);
  assert.equal(readFileSync(join(rootDir, sandbox.id, "workspace/greeting"), "utf8"), "hello");
  assert.equal((await restored.command(sandbox.id, start.id)).exitCode, 7);
  await restored.close();
});
test("timeout, cancellation, output and admission are bounded", async (t) => {
  const { host } = await fixture(t, { maxConcurrent: 1, maxEnvironments: 1, maxOutputBytes: 32 });
  const sandbox = await host.create();
  await assert.rejects(host.create(), /capacity/);
  const run = await host.exec(sandbox.id, { command: "while :; do printf 12345678; done", timeoutMs: 100 });
  await assert.rejects(host.exec(sandbox.id, { command: "true" }), /capacity/);
  const result = await finished(host, sandbox.id, run.id);
  assert.equal(result.status, "timed_out"); assert.ok(result.truncated); assert.ok(result.stdout.length <= 32);
  const next = await host.exec(sandbox.id, { command: "sleep 30" });
  await assert.rejects(host.destroy(sandbox.id), /Cancel/);
  assert.equal((await host.cancel(sandbox.id, next.id)).status, "cancelled");
  await host.destroy(sandbox.id);
  await assert.rejects(host.get(sandbox.id), /not found/);
});
test("bad paths, symlink cwd escape and host secret inheritance are rejected", async (t) => {
  const { host, rootDir } = await fixture(t);
  const sandbox = await host.create();
  await assert.rejects(host.exec(sandbox.id, { command: "true", cwd: ".." }), /inside/);
  symlinkSync(tmpdir(), join(rootDir, sandbox.id, "workspace/escape"));
  await assert.rejects(host.exec(sandbox.id, { command: "true", cwd: "escape" }), /inside/);
  await assert.rejects(host.command(sandbox.id, "../../etc/passwd"), /not found/);
  await assert.rejects(host.exec(sandbox.id, { command: "", timeoutMs: -1 }), /non-empty/);
  process.env.STATION_SANDBOX_TEST_SECRET = "must-not-inherit";
  try {
    const run = await host.exec(sandbox.id, { command: 'printf "%s" "${STATION_SANDBOX_TEST_SECRET-unset}"' });
    assert.equal((await finished(host, sandbox.id, run.id)).stdout, "unset");
  } finally { delete process.env.STATION_SANDBOX_TEST_SECRET; }
});
test("shutdown interrupts commands and stale running records are never replayed", async (t) => {
  const { host, rootDir } = await fixture(t);
  const sandbox = await host.create();
  const run = await host.exec(sandbox.id, { command: "sleep 30" });
  await host.close();
  assert.equal((await host.command(sandbox.id, run.id)).status, "interrupted");
  writeFileSync(join(rootDir, sandbox.id, "runs", `${run.id}.json`), JSON.stringify(run));
  const recovered = new HostSandboxAdapter({ rootDir });
  assert.equal((await recovered.command(sandbox.id, run.id)).status, "interrupted");
  await recovered.close();
});

test("a shell that exits cleans background descendants holding output pipes", async (t) => {
  const { host } = await fixture(t);
  const sandbox = await host.create();
  const run = await host.exec(sandbox.id, { command: "sleep 30 & printf '%s' $!", timeoutMs: 5_000 });
  const result = await finished(host, sandbox.id, run.id);
  assert.equal(result.status, "completed", "shell exit must finish without waiting for the timeout or background pipe handles");
  const pid = Number(result.stdout);
  assert.ok(pid > 0);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Background child survived command completion.");
});

test("cancellation escalates when a process ignores SIGTERM", async (t) => {
  const { host } = await fixture(t);
  const sandbox = await host.create();
  const run = await host.exec(sandbox.id, { command: "trap '' TERM; printf ready; while :; do sleep 30; done" });
  const deadline = Date.now() + 5_000;
  while (!(await host.command(sandbox.id, run.id)).stdout.includes("ready")) {
    assert.ok(Date.now() < deadline, "shell did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const result = await host.cancel(sandbox.id, run.id);
  assert.equal(result.status, "cancelled");
  assert.ok(result.finishedAt);
});

test("UTF-8 capture handles split characters and a cap inside a multibyte sequence", async (t) => {
  const { host } = await fixture(t, { maxOutputBytes: 5 });
  const sandbox = await host.create();
  const run = await host.exec(sandbox.id, { command: "printf '\\342'; sleep 0.05; printf '\\202\\254\\342\\202\\254'" });
  const result = await finished(host, sandbox.id, run.id);
  assert.equal(result.stdout, "€");
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 5);
});

test("a missing executable fails the run and releases admission capacity", async (t) => {
  const { host } = await fixture(t, { shell: "/station-test-missing-shell", maxConcurrent: 1 });
  const sandbox = await host.create();
  const run = await host.exec(sandbox.id, { command: "true" });
  const result = await finished(host, sandbox.id, run.id);
  assert.equal(result.status, "failed");
  assert.match(result.stderr, /ENOENT/);
  const another = await host.exec(sandbox.id, { command: "true" });
  assert.equal((await finished(host, sandbox.id, another.id)).status, "failed");
});

test("history bounds survive reopening without deleting workspace files", async (t) => {
  const { host, rootDir } = await fixture(t, { maxHistoryPerSandbox: 2 });
  const sandbox = await host.create();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const run = await host.exec(sandbox.id, { command: "printf preserved > artifact" });
    runs.push(await finished(host, sandbox.id, run.id));
  }
  await assert.rejects(host.command(sandbox.id, runs[0]!.id), /not found/);
  await host.close();
  const recovered = new HostSandboxAdapter({ rootDir, maxHistoryPerSandbox: 1 });
  t.after(() => recovered.close());
  await assert.rejects(recovered.command(sandbox.id, runs[1]!.id), /not found/);
  assert.equal((await recovered.command(sandbox.id, runs[2]!.id)).status, "completed");
  assert.equal(readFileSync(join(rootDir, sandbox.id, "workspace/artifact"), "utf8"), "preserved");
});

test("malformed and foreign command metadata is rejected rather than accepted on recovery", async (t) => {
  const { host, rootDir } = await fixture(t);
  const sandbox = await host.create();
  const run = await host.exec(sandbox.id, { command: "true" });
  const result = await finished(host, sandbox.id, run.id);
  await host.close();
  const path = join(rootDir, sandbox.id, "runs", `${run.id}.json`);
  writeFileSync(path, "{broken");
  assert.throws(() => new HostSandboxAdapter({ rootDir }), /Unreadable sandbox metadata/);
  writeFileSync(path, JSON.stringify({ ...result, sandboxId: "another workspace" }));
  assert.throws(() => new HostSandboxAdapter({ rootDir }), /Invalid command metadata/);
});

test("persistence failures surface to callers instead of stale running results", async (t) => {
  const { host, rootDir } = await fixture(t);
  const sandbox = await host.create();
  const run = await host.exec(sandbox.id, { command: "sleep 30" });
  rmSync(join(rootDir, sandbox.id, "runs"), { recursive: true });
  await assert.rejects(host.cancel(sandbox.id, run.id), /Failed to persist/);
  await assert.rejects(host.command(sandbox.id, run.id), /Failed to persist/);
  await assert.rejects(host.exec(sandbox.id, { command: "true" }), /storage is unavailable/);
  await assert.rejects(host.create(), /storage is unavailable/);
});

test("offline npm-installed tools survive new commands and restart, without leaking through another workspace PATH", async (t) => {
  const configuredPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const { host, rootDir } = await fixture(t, { env: { PATH: configuredPath } });
  const workspace = await host.create();
  const other = await host.create();
  const workingDir = join(rootDir, workspace.id, "workspace");
  const packageDir = join(workingDir, "tool fixture");
  mkdirSync(packageDir);
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "station-sandbox-offline-fixture", version: "1.0.0",
    bin: { "station-sandbox-fixture-tool": "cli.cjs" },
  }));
  writeFileSync(join(packageDir, "cli.cjs"), '#!/usr/bin/env node\nconsole.log("custom-tool-global");\n', { mode: 0o755 });
  const execute = async (adapter: HostSandboxAdapter, id: string, command: string) => {
    const started = await adapter.exec(id, { command, timeoutMs: 30_000 });
    return finished(adapter, id, started.id);
  };
  const packed = await execute(host, workspace.id, "npm pack './tool fixture' --ignore-scripts --offline --json");
  assert.equal(packed.status, "completed", packed.stderr);
  const [archive] = JSON.parse(packed.stdout) as { filename: string }[];
  assert.match(archive!.filename, /^station-sandbox-offline-fixture-1\.0\.0\.tgz$/);
  const installed = await execute(host, workspace.id,
    `npm install --global --ignore-scripts --no-audit --no-fund --offline './${archive!.filename}'`);
  assert.equal(installed.status, "completed", installed.stderr);
  const globalTool = await execute(host, workspace.id, "station-sandbox-fixture-tool");
  assert.equal(globalTool.status, "completed", globalTool.stderr);
  assert.equal(globalTool.stdout.trim(), "custom-tool-global");
  assert.equal((await execute(host, other.id, "station-sandbox-fixture-tool")).exitCode, 127);
  assert.ok(readFileSync(join(rootDir, workspace.id, "home/.local/lib/node_modules/station-sandbox-offline-fixture/cli.cjs"), "utf8").includes("custom-tool-global"));
  const path = await execute(host, workspace.id, 'printf "%s" "$PATH"');
  assert.equal(path.stdout, [join(realpathSync(workingDir), "node_modules/.bin"), join(rootDir, workspace.id, "home/.local/bin"), configuredPath].join(":"));
  await host.close();
  const recovered = new HostSandboxAdapter({ rootDir, env: { PATH: configuredPath } });
  t.after(() => recovered.close());
  const retained = await execute(recovered, workspace.id, "station-sandbox-fixture-tool");
  assert.equal(retained.status, "completed", retained.stderr);
  assert.equal(retained.stdout.trim(), "custom-tool-global");
  assert.equal((await execute(recovered, other.id, "station-sandbox-fixture-tool")).exitCode, 127);

  // A workspace-local dependency wins over a tool with the same global command name.
  writeFileSync(join(workingDir, "package.json"), JSON.stringify({ name: "workspace-fixture", version: "1.0.0", private: true }));
  const localInstall = await execute(recovered, workspace.id,
    `npm install --ignore-scripts --no-audit --no-fund --offline './${archive!.filename}'`);
  assert.equal(localInstall.status, "completed", localInstall.stderr);
  writeFileSync(join(workingDir, "node_modules/station-sandbox-offline-fixture/cli.cjs"), '#!/usr/bin/env node\nconsole.log("custom-tool-local");\n');
  assert.equal((await execute(recovered, workspace.id, "station-sandbox-fixture-tool")).stdout.trim(), "custom-tool-local");
});

test("operators can override npm prefix while workspace tool paths stay first", async (t) => {
  const { host } = await fixture(t, { env: { NPM_CONFIG_PREFIX: "/operator/configured-prefix" } });
  const workspace = await host.create();
  const run = await host.exec(workspace.id, { command: 'printf "%s" "$NPM_CONFIG_PREFIX"' });
  assert.equal((await finished(host, workspace.id, run.id)).stdout, "/operator/configured-prefix");
});
