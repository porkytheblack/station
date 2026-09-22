import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareContainerSeccomp } from "../src/container-seccomp.js";
const unconfined = { SecurityOptions: ["name=seccomp,profile=unconfined"] };
const policy = { defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["read", "write"], action: "SCMP_ACT_ALLOW" }] };
test("container seccomp requires a verified engine default or explicit policy", () => {
  const root = mkdtempSync(join(tmpdir(), "station-seccomp-"));
  try {
    assert.deepEqual(prepareContainerSeccomp(root, undefined, { SecurityOptions: ["name=seccomp,profile=builtin"] }, "docker"), { fingerprint: "builtin" });
    assert.throws(() => prepareContainerSeccomp(root, undefined, unconfined, "docker"), /unconfined/);
    assert.throws(() => prepareContainerSeccomp(root, undefined, {}, "docker"), /support/);
    assert.throws(() => prepareContainerSeccomp(root, undefined, { host: { security: { seccompEnabled: true } } }, "podman"), /unverifiable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("container seccomp pins an explicit deny-default policy and detects corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "station-seccomp-"));
  try {
    const source = join(root, "source.json"); writeFileSync(source, JSON.stringify(policy), { mode: 0o600 });
    const result = prepareContainerSeccomp(root, source, unconfined, "docker");
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/); assert.equal(readFileSync(result.path!, "utf8"), JSON.stringify(policy));
    assert.deepEqual(prepareContainerSeccomp(root, source, unconfined, "docker"), result);
    writeFileSync(result.path!, "corrupt");
    assert.throws(() => prepareContainerSeccomp(root, source, unconfined, "docker"), /integrity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("container seccomp rejects permissive, wildcard, writable and symlink policies", () => {
  const root = mkdtempSync(join(tmpdir(), "station-seccomp-"));
  try {
    const source = join(root, "source.json"); writeFileSync(source, JSON.stringify({ ...policy, defaultAction: "SCMP_ACT_ALLOW" }), { mode: 0o600 });
    assert.throws(() => prepareContainerSeccomp(root, source, unconfined, "docker"), /deny by default/);
    writeFileSync(source, JSON.stringify({ ...policy, syscalls: [{ names: ["*"], action: "SCMP_ACT_ALLOW" }] }));
    assert.throws(() => prepareContainerSeccomp(root, source, unconfined, "docker"), /explicit syscall/);
    writeFileSync(source, JSON.stringify(policy)); chmodSync(source, 0o666);
    assert.throws(() => prepareContainerSeccomp(root, source, unconfined, "docker"), /write access/);
    chmodSync(source, 0o600); const link = join(root, "link.json"); symlinkSync(source, link);
    assert.throws(() => prepareContainerSeccomp(root, link, unconfined, "docker"), /regular file/);
    assert.throws(() => prepareContainerSeccomp(root, source, {}, "docker"), /support/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
