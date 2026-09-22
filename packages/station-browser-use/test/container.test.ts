import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerBrowserAdapter } from "../src/container.js";
test("container browser refuses unsafe host configuration", () => {
  for (const options of [{ image: "--privileged" }, { network: "host" }, { network: "container:other" }, { network: "bridge", networkRestricted: true }, { network: "podman", networkRestricted: true }, { network: "default", networkRestricted: true }, { user: "0:0" }, { user: "root" }, { cpus: 0 }, { memoryMb: 0 }, { pidsLimit: 0 }, { workerPath: "relative.js" }]) {
    assert.throws(() => new ContainerBrowserAdapter({ rootDir: "/tmp/station-browser-invalid", image: "fixture", ...options }), { code: "invalid_input" });
  }
});
test("unavailable engine fails closed and releases browser metadata ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-container-"));
  try {
    const options = { rootDir: root, image: "fixture", executable: join(root, "missing") };
    const adapter = new ContainerBrowserAdapter(options);
    assert.equal(adapter.capabilities.isolated, true); assert.equal(adapter.capabilities.networkRestricted, true);
    assert.throws(() => new ContainerBrowserAdapter(options), { code: "busy" });
    await assert.rejects(adapter.ready(), { code: "unavailable" });
    await assert.rejects(adapter.open(), { code: "unavailable" });
    const replacement = new ContainerBrowserAdapter(options); await assert.rejects(replacement.ready());
    await Promise.all([adapter.close(), replacement.close()]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
