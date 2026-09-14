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
if (!image) throw new Error("Set STATION_BROWSER_CONTAINER_IMAGE to the locally built test image.");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("container browsers enforce runtime flags, isolate sessions, persist profiles and recover recordings", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "station-container-browser-integration-"));
  const options = { engine, executable: process.env.STATION_CONTAINER_EXECUTABLE, image, tenantId: "tenant-a", rootDir: join(root, "owner"), workerPath: "/opt/station/container-fixture.mjs", timeoutMs: 30_000, maxProfiles: 1 } as const;
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
    for (const name of names) {
      const container = JSON.parse(execFileSync(engine, ["inspect", name], { encoding: "utf8" }))[0];
      assert.equal(container.HostConfig.LogConfig.Type, "none");
      assert.equal(container.Config.User, "1000:1000"); assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.HostConfig.NetworkMode, "none"); assert.ok(container.HostConfig.SecurityOpt.some((value: string) => value.startsWith("no-new-privileges")));
      assert.ok(container.HostConfig.Memory > 0); assert.ok(container.HostConfig.PidsLimit > 0);
      assert.ok(container.HostConfig.CpuQuota > 0 || container.HostConfig.NanoCpus > 0);
      const effectiveCaps = execFileSync(engine, ["exec", name, "node", "-e", "process.stdout.write(require(\"node:fs\").readFileSync(\"/proc/self/status\",\"utf8\").match(/^CapEff:\\s*(.*)$/m)[1])"], { encoding: "utf8" }).trim();
      assert.match(effectiveCaps, /^0+$/);
      assert.ok(container.Mounts.every((mount: any) => mount.Type !== "bind"));
    }
    await first.perform(session.id, "navigate", "http://127.0.0.1:8765/");
    await first.perform(other.id, "navigate", "http://127.0.0.1:8765/");
    await first.perform(session.id, "evaluate", "document.cookie='station=kept; max-age=3600; path=/'");
    assert.equal(await first.perform(other.id, "evaluate", "document.cookie"), "");
    await assert.rejects(first.open({ profileId: "persistent" }), { code: "busy" });
    await assert.rejects(first.open({ profileId: "overflow" }), { code: "capacity" });
    await first.execute(session.id, { op: "fill", selector: "#name", value: "container workflow" });
    await first.perform(session.id, "click", "button");
    assert.equal(await first.perform(session.id, "evaluate", "document.querySelector('#result').textContent"), "container workflow");
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
