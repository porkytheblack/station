import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ContainerBrowserAdapter } from "../dist/container.js";
import { BrowserSessionManager } from "../dist/manager.js";
import type { BrowserPage, BrowserArtifact } from "../src/commands.js";
const engine = process.env.STATION_CONTAINER_ENGINE === "docker" ? "docker" : "podman";
const image = process.env.STATION_BROWSER_CONTAINER_IMAGE;
const profileStorageRoot = process.env.STATION_BROWSER_PROFILE_STORAGE_ROOT;
const network = process.env.STATION_BROWSER_CONTAINER_NETWORK ?? "none";
const proxy = process.env.STATION_BROWSER_CONTAINER_PROXY;
if (!image) throw new Error("Set STATION_BROWSER_CONTAINER_IMAGE to the locally built test image.");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("container browsers enforce runtime flags, isolate sessions, persist profiles and recover recordings", { timeout: 120_000 }, async (t) => {
  t.diagnostic(profileStorageRoot ? "Profile mode: local Linux bind directory with quota guard" : "Profile mode: managed named volume");
  const root = mkdtempSync(join(tmpdir(), "station-container-browser-integration-"));
  const options = { engine, executable: process.env.STATION_CONTAINER_EXECUTABLE, seccompProfile: process.env.STATION_CONTAINER_SECCOMP, image, profileStorageRoot, tenantId: "tenant-a", rootDir: join(root, "owner"), workerPath: "/opt/station/container-fixture.mjs", timeoutMs: 30_000, maxProfiles: 1 } as const;
  const first = new BrowserSessionManager(new ContainerBrowserAdapter(options), 3, { tenantId: "tenant-a", recordingRootDir: join(root, "recordings"), intervalMs: 100 });
  let second: BrowserSessionManager | undefined;
  try {
    await first.bindTenant("tenant-a");
    await assert.rejects(first.bindTenant("tenant-b"), { code: "invalid_state" });
    await assert.rejects(first.bindTenant(), { code: "invalid_state" });
    const session = await first.open({ profileId: "persistent" });
    const other = await first.open();
    const names = execFileSync(engine, ["ps", "--filter", "label=station.browser.session", "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n");
    assert.ok(names.length >= 2);
    let persistentBinds = 0;
    for (const name of names) {
      const container = JSON.parse(execFileSync(engine, ["inspect", name], { encoding: "utf8" }))[0];
      assert.equal(container.HostConfig.LogConfig.Type, "none");
      assert.equal(container.Config.User, "1000:1000"); assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.HostConfig.NetworkMode, "none"); assert.ok(container.HostConfig.SecurityOpt.some((value: string) => value.startsWith("no-new-privileges")));
      assert.ok(container.HostConfig.Memory > 0); assert.ok(container.HostConfig.PidsLimit > 0);
      assert.ok(container.HostConfig.CpuQuota > 0 || container.HostConfig.NanoCpus > 0);
      const effectiveCaps = execFileSync(engine, ["exec", name, "node", "-e", "process.stdout.write(require(\"node:fs\").readFileSync(\"/proc/self/status\",\"utf8\").match(/^CapEff:\\s*(.*)$/m)[1])"], { encoding: "utf8" }).trim();
      assert.match(effectiveCaps, /^0+$/);
      const seccomp = execFileSync(engine, ["exec", name, "node", "-e", "process.stdout.write(require(\"node:fs\").readFileSync(\"/proc/self/status\",\"utf8\").match(/^Seccomp:\\s*(.*)$/m)[1])"], { encoding: "utf8" }).trim();
      assert.equal(seccomp, "2", "kernel seccomp filter must actually be active");
      const binds = container.Mounts.filter((mount: any) => mount.Type === "bind");
      if (profileStorageRoot) {
        assert.ok(binds.length <= 1);
        persistentBinds += binds.length;
        for (const mount of binds) { assert.equal(mount.Destination, "/home/node"); assert.ok(mount.Source.startsWith(profileStorageRoot + "/station-browser-profile-")); }
        assert.deepEqual(container.Config.Entrypoint, ["/usr/local/bin/station-quota-guard"]);
        // Inspect the actual launched worker, not a fresh docker-exec process
        // (which would not inherit the entrypoint's additional seccomp filter).
        const filters = execFileSync(engine, ["exec", name, "node", "-e", 'const fs=require("node:fs");for(const id of fs.readdirSync("/proc")){if(!/^\\d+$/.test(id))continue;try{const cmd=fs.readFileSync(`/proc/${id}/cmdline`,"utf8").split("\\0");if(cmd[1]==="/opt/station/container-fixture.mjs")process.stdout.write(fs.readFileSync(`/proc/${id}/status`,"utf8").match(/^Seccomp_filters:\\s*(\\d+)$/m)[1]);}catch{}}'], { encoding: "utf8" }).trim();
        assert.ok(Number(filters) >= 2, "actual browser worker must inherit the engine and quota seccomp filters");
      } else assert.equal(binds.length, 0);
    }
    if (profileStorageRoot) assert.equal(persistentBinds, 1, "the persistent session must use the provisioned profile directory");
    await first.perform(session.id, "navigate", "http://127.0.0.1:8765/");
    await first.perform(other.id, "navigate", "http://127.0.0.1:8765/");
    await first.perform(session.id, "evaluate", "document.cookie='station=kept; max-age=3600; path=/'");
    assert.equal(await first.perform(other.id, "evaluate", "document.cookie"), "");
    await assert.rejects(first.open({ profileId: "persistent" }), { code: "busy" });
    await assert.rejects(first.open({ profileId: "overflow" }), { code: "capacity" });
    await first.execute(session.id, { op: "fill", target: { by: "selector", value: "#name" }, value: "container workflow" });
    await first.perform(session.id, "click", "button");
    assert.equal(await first.perform(session.id, "evaluate", "document.querySelector('#result').textContent"), "container workflow");
    const inspection = await first.execute(session.id, { op: "inspect", target: { by: "role", role: "button", name: "Apply" } }) as { elements: { tag: string }[] };
    assert.equal(inspection.elements[0].tag, "button");
    const aria = await first.execute(session.id, { op: "accessibility" }) as { snapshot: string }; assert.match(aria.snapshot, /button "Apply"/);
    await first.execute(session.id, { op: "traceStart" });
    await first.execute(session.id, { op: "click", target: { by: "role", role: "button", name: "Apply" } });
    const trace = await first.execute(session.id, { op: "traceStop" }) as BrowserArtifact;
    assert.equal(trace.mimeType, "application/zip");
    const traceData = await first.execute(session.id, { op: "downloadRead", artifactId: trace.id }) as { base64: string };
    assert.equal(Buffer.from(traceData.base64, "base64").subarray(0, 4).toString("hex"), "504b0304");
    await first.execute(session.id, { op: "downloadDelete", artifactId: trace.id });
    const diagnostics = await first.execute(session.id, { op: "diagnostics" }) as { events: unknown[] }; assert.ok(diagnostics.events.length > 0);
    const page = await first.execute(session.id, { op: "newPage", url: "http://127.0.0.1:8765/second" }) as BrowserPage;
    assert.equal((await first.execute(session.id, { op: "pages" }) as BrowserPage[]).length, 2);
    await first.execute(session.id, { op: "upload", selector: "#file", files: [{ name: "fixture.txt", mimeType: "text/plain", base64: Buffer.from("container upload").toString("base64") }] });
    await first.perform(session.id, "evaluate", "new Promise(resolve=>{const tick=()=>document.querySelector('#uploaded').textContent?resolve(true):setTimeout(tick,10);tick()})");
    assert.equal(await first.perform(session.id, "evaluate", "document.querySelector('#uploaded').textContent"), "container upload");
    const artifact = await first.execute(session.id, { op: "download", selector: "#download" }) as BrowserArtifact;
    const data = await first.execute(session.id, { op: "downloadRead", artifactId: artifact.id }) as { base64: string };
    assert.equal(Buffer.from(data.base64, "base64").toString(), "container artifact");
    await first.execute(session.id, { op: "downloadDelete", artifactId: artifact.id });
    await first.execute(session.id, { op: "closePage", pageId: page.id });
    const shot = await first.perform(session.id, "screenshot") as { base64: string }; assert.match(shot.base64, /^iVBOR/);
    const recording = first.startRecording(session.id);
    const deadline = Date.now() + 5000; while (first.getRecording(recording.id).frames.length < 2 && Date.now() < deadline) await wait(50);
    assert.ok(first.getRecording(recording.id).frames.length >= 2);
    await first.stopRecording(recording.id);
    const pending = first.perform(other.id, "evaluate", "new Promise(()=>{})"); const rejection = assert.rejects(pending);
    await wait(100); await first.closeSession(other.id); await rejection;
    await first.close();
    second = new BrowserSessionManager(new ContainerBrowserAdapter(options), 3, { tenantId: "tenant-a", recordingRootDir: join(root, "recordings") });
    assert.match(second.recordingFrame(recording.id, second.getRecording(recording.id).frames[0].id).base64, /^iVBOR/);
    await second.bindTenant("tenant-a");
    const reopened = await second.open({ profileId: "persistent" });
    await second.perform(reopened.id, "navigate", "http://127.0.0.1:8765/");
    assert.equal(await second.perform(reopened.id, "evaluate", "document.cookie"), "station=kept");
    await second.closeSession(reopened.id); await second.deleteProfile("persistent"); assert.deepEqual(await second.listProfiles(), []);
    await second.deleteRecording(recording.id);
  } finally {
    await Promise.allSettled([first.close(), second?.close()]);
    // Failed assertions must also remove this fixture's retained named volumes.
    const cleanup = new ContainerBrowserAdapter(options);
    try { await cleanup.ready(); for (const profile of await cleanup.listProfiles()) await cleanup.deleteProfile(profile.id); }
    finally { await cleanup.close(); rmSync(root, { recursive: true, force: true }); }
  }
});

if (proxy) test("real container browser uses the enforced HTTPS proxy and rejects metadata access", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-proxy-integration-"));
  const manager = new BrowserSessionManager(new ContainerBrowserAdapter({ engine, image, executable: process.env.STATION_CONTAINER_EXECUTABLE, seccompProfile: process.env.STATION_CONTAINER_SECCOMP, rootDir: root, profileStorageRoot, network, proxy: { server: proxy } }));
  try {
    const session = await manager.open();
    await manager.perform(session.id, "navigate", "https://example.com/");
    assert.match(String(await manager.perform(session.id, "evaluate", "document.title")), /Example Domain/);
    assert.match((await manager.perform(session.id, "screenshot") as { base64: string }).base64, /^iVBOR/);
    await assert.rejects(manager.perform(session.id, "navigate", "https://169.254.169.254/"));
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
