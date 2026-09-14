import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { FILE_SCRIPT } from "../src/container-engine.js";
import { ContainerSandboxAdapter } from "../src/container.js";

test("container configuration refuses root users, injected images and invalid limits", () => {
  const rootDir = join(tmpdir(), "station-container-invalid-config");
  for (const options of [{ user: "0:0" }, { user: "root" }, { image: "--privileged" }, { cpus: 0 }, { memoryMb: 0 }, { pidsLimit: -1 }, { network: "host" }, { network: "container:abc" }, { network: "bridge", networkRestricted: true }, { network: "none", networkRestricted: true }, { env: { "A=B": "value" } }]) {
    assert.throws(() => new ContainerSandboxAdapter({ rootDir, image: "node", ...options } as any));
  }
});

test("missing container engine fails closed and releases the metadata owner lock", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "station-container-unavailable-"));
  try {
    const options = { rootDir, image: "node", executable: join(rootDir, "not-an-engine") };
    const first = new ContainerSandboxAdapter(options);
    await assert.rejects(first.ready(), /container engine/);
    await assert.rejects(first.create(), /container engine/);
    const next = new ContainerSandboxAdapter(options);
    await assert.rejects(next.ready(), /container engine/);
    await first.close(); await next.close();
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("container constructor binds tenant ownership before engine access or reconciliation", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "station-container-tenant-"));
  const options = { rootDir, image: "node", executable: join(rootDir, "not-an-engine"), tenantId: "customer-a" };
  try {
    const first = new ContainerSandboxAdapter(options);
    await assert.rejects(first.ready());
    assert.throws(() => new ContainerSandboxAdapter({ ...options, tenantId: "customer-b" }), /different tenant/);
    assert.throws(() => new ContainerSandboxAdapter({ ...options, tenantId: undefined }), /different tenant/);
    const same = new ContainerSandboxAdapter(options);
    await assert.rejects(same.ready());
    await first.close(); await same.close();
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});


test("container file helper emits typed sanitized failures without leaking filesystem diagnostics", () => {
  for (const [system, expected] of [["ENOENT", "not_found"], ["ENOTDIR", "invalid_input"], ["ELOOP", "invalid_input"], ["EACCES", "invalid_input"], ["ENOSPC", "capacity"], ["EDQUOT", "capacity"], ["EIO", "unavailable"]]) {
    let output = "";
    const fs = {
      readFileSync: () => JSON.stringify({ method: "read", path: "secret.txt" }),
      lstatSync: () => { throw Object.assign(new Error("private filesystem diagnostic /private/secret-token"), { code: system }); },
    };
    runInNewContext(FILE_SCRIPT, { require: (id: string) => id === "node:fs" ? fs : {}, process: { stdout: { write: (text: string) => { output += text; } } } });
    assert.deepEqual(JSON.parse(output), { error: { code: expected } });
    assert.ok(!output.includes("private"));
  }
});
