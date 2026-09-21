import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SignalRunner } from "station-signal";
import { FileImageRegistry, ImageRegistry, MemoryRegistryBlobAdapter, MemoryRegistryMetadataAdapter, type ImageManifest } from "station-images";
import { ImageRuntime, imageSignalName, type ImageBackendConfig } from "../../src/images/runtime.js";
const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
const abi = process.platform === "linux" ? report.header?.glibcVersionRuntime ? "glibc" as const : "musl" as const : "none" as const;
const target = { abi, os: process.platform as "linux" | "darwin", arch: process.arch === "arm64" ? "arm64" as const : "amd64" as const, runtimes: { node: Number(process.versions.node.split(".")[0]) } };
const backend: ImageBackendConfig = { kind: "trusted-local", allowUnsafeHostExecution: true, target };
const javascript = Buffer.from(`let text='';for await(const part of process.stdin)text+=part;const r=JSON.parse(text);console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{input:r.input,value:process.env.IMAGE_ALLOWED,leaked:process.env.IMAGE_HOST_SECRET??null,runId:r.runId,attempt:r.attempt}}));`);
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "station-image-runtime-")); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, "registry"));
  const artifact = await registry.putBlob(javascript);
  const manifest: ImageManifest = { format: "station.image/v1", protocol: "station.process/v1", name: "test/echo", version: "1.0.0", artifacts: [{ ...artifact, platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 20, entrypoint: "echo.mjs" }], exports: [{ name: "echo", kind: "signal", inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string" } }, additionalProperties: false }, requiredEnv: ["IMAGE_ALLOWED"] }] };
  await registry.publish(manifest); return { root, registry, manifest };
}
test("registered JS image signals execute real queued runs with approved env and original run identity", { timeout: 15_000 }, async (t) => {
  const { root, registry } = await setup(t);
  const old = process.env.IMAGE_HOST_SECRET; process.env.IMAGE_HOST_SECRET = "must-not-inherit";
  t.after(() => { if (old === undefined) delete process.env.IMAGE_HOST_SECRET; else process.env.IMAGE_HOST_SECRET = old; });
  const runner = new SignalRunner({ pollIntervalMs: 20, envProvider: { resolveFor: async () => ({ IMAGE_ALLOWED: "from-store", IMAGE_DENIED: "not-granted" }) } });
  const runtime = new ImageRuntime({ registry, signalRunner: runner, stateDir: join(root, "runtime"), backend, allowedEnv: ["IMAGE_ALLOWED"] });
  const installation = await runtime.install("test/echo@1.0.0"), name = imageSignalName(installation.image.digest, "echo");
  assert.ok(installation.signals[name]);
  const started = runner.start();
  try {
    const id = await runner.triggerSignal(name, { message: "hello" });
    const run = await runner.waitForRun(id, { timeoutMs: 10_000 });
    assert.equal(run?.status, "completed", run?.error);
    assert.deepEqual(JSON.parse(run?.output ?? "null"), { input: { message: "hello" }, value: "from-store", leaked: null, runId: id, attempt: 1 });
    await assert.rejects(runner.triggerSignal(name, { invalid: true }), /does not match its declared schema/);
  } finally { await runner.stop(); await started; }
});
test("native executable images run through the same queue and protocol", { timeout: 15_000 }, async (t) => {
  const { root, registry, manifest } = await setup(t);
  // Compile a tiny real native program, no shell or interpreter masquerading as native.
  const source = join(root, "echo.c"), executable = join(root, "echo-native");
  await writeFile(source, '#include <stdio.h>\nint main(void){char input[8192]; if(!fgets(input,sizeof(input),stdin))return 1; puts("{\\"protocol\\":\\"station.process/v1\\",\\"type\\":\\"result\\",\\"output\\":{\\"native\\":true}}"); return 0;}\n');
  execFileSync("cc", [source, "-o", executable]);
  const artifact = await registry.putBlob(await readFile(executable));
  const native = await registry.publish({ ...manifest, name: "test/native", artifacts: [{ ...artifact, platform: { os: target.os, arch: target.arch, abi: target.abi }, runtime: "native", entrypoint: "native" }], exports: [{ name: "execute", kind: "signal" }] });
  const runner = new SignalRunner({ pollIntervalMs: 20 });
  const runtime = new ImageRuntime({ registry, signalRunner: runner, stateDir: join(root, "native-runtime"), backend });
  const installed = await runtime.install(native.digest), name = imageSignalName(installed.image.digest, "execute");
  const started = runner.start();
  try { const id = await runner.triggerSignal(name, {}); const run = await runner.waitForRun(id, { timeoutMs: 10_000 }); assert.equal(run?.status, "completed", run?.error); assert.deepEqual(JSON.parse(run?.output ?? "null"), { native: true }); }
  finally { await runner.stop(); await started; }
});
test("activation restores immutable names and rejects changed execution grants", async (t) => {
  const { root, registry } = await setup(t); const stateDir = join(root, "runtime");
  const first = new ImageRuntime({ registry, signalRunner: new SignalRunner(), stateDir, backend, allowedEnv: ["IMAGE_ALLOWED"] });
  const installed = await first.install("test/echo@1.0.0");
  const secondRunner = new SignalRunner(); const restored = await new ImageRuntime({ registry, signalRunner: secondRunner, stateDir, backend, allowedEnv: ["IMAGE_ALLOWED"] }).restore();
  assert.equal(restored[0].image.digest, installed.image.digest); assert.equal(secondRunner.hasSignal(imageSignalName(installed.image.digest, "echo")), true);
  await assert.rejects(new ImageRuntime({ registry, signalRunner: new SignalRunner(), stateDir, backend, allowedEnv: [] }).restore(), /configuration changed/);
  assert.equal((await readFile(join(stateDir, "active.json"), "utf8")).includes("from-store"), false);
});
test("activation denies missing environment grants and host backends without explicit opt-in", async (t) => {
  const { root, registry } = await setup(t);
  await assert.rejects(new ImageRuntime({ registry, signalRunner: new SignalRunner(), stateDir: join(root, "runtime"), backend }).install("test/echo@1.0.0"), /outside its operator grant/);
  assert.throws(() => new ImageRuntime({ registry, signalRunner: new SignalRunner(), stateDir: join(root, "runtime"), backend: { ...backend, allowUnsafeHostExecution: false } as unknown as ImageBackendConfig }), /explicitly enabled/);
});
test("broadcast exports execute as immutable planner signals and retain validated dependency names", { timeout: 15_000 }, async (t) => {
  const { root, registry, manifest } = await setup(t);
  const plannerCode = Buffer.from(`let t='';for await(const x of process.stdin)t+=x;const r=JSON.parse(t);console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{nodes:[{name:'first',signalName:'echo',dependsOn:[],input:{kind:'lit',value:r.input}}]}}));`);
  const artifact = await registry.putBlob(plannerCode);
  const image = await registry.publish({ ...manifest, name: "test/planner", artifacts: [{ ...artifact, platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 20, entrypoint: "planner.mjs" }], exports: [{ name: "workflow.v1", kind: "broadcast", planner: "binary" }, { name: "echo", kind: "signal" }] });
  const runner = new SignalRunner({ pollIntervalMs: 20 });
  const runtime = new ImageRuntime({ registry, signalRunner: runner, stateDir: join(root, "planner-runtime"), backend });
  const installed = await runtime.install(image.digest), name = imageSignalName(installed.image.digest, "workflow.v1");
  assert.match(name, /^[a-zA-Z][a-zA-Z0-9_-]*$/);
  const started = runner.start();
  try { const id = await runner.triggerSignal(name, { message: "hello" }); const run = await runner.waitForRun(id, { timeoutMs: 10_000 }); assert.equal(run?.status, "completed", run?.error); assert.equal(JSON.parse(run?.output ?? "null").nodes[0].signalName, "echo"); }
  finally { await runner.stop(); await started; }
});
test("cancelling an image run terminates its external process boundary", { timeout: 15_000 }, async (t) => {
  const { root, registry, manifest } = await setup(t);
  const marker = join(root, "child.pid");
  const artifact = await registry.putBlob(Buffer.from(`import{writeFileSync}from'node:fs';let t='';for await(const x of process.stdin)t+=x;writeFileSync(JSON.parse(t).input.pidFile,String(process.pid));setInterval(()=>{},1000);`));
  const image = await registry.publish({ ...manifest, name: "test/cancel", artifacts: [{ ...artifact, platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 20, entrypoint: "wait.mjs" }], exports: [{ name: "wait", kind: "signal" }] });
  const runner = new SignalRunner({ pollIntervalMs: 20, killGraceMs: 2_000 });
  const runtime = new ImageRuntime({ registry, signalRunner: runner, stateDir: join(root, "cancel-runtime"), backend });
  await runtime.install(image.digest); const started = runner.start();
  try {
    const id = await runner.triggerSignal(imageSignalName(image.digest, "wait"), { pidFile: marker });
    let pid = 0; const readyBy = Date.now() + 5_000;
    while (!pid && Date.now() < readyBy) { try { pid = Number(await readFile(marker, "utf8")); } catch {} if (!pid) await new Promise(r => setTimeout(r, 20)); }
    assert.ok(pid > 0, "external executable started");
    assert.equal(await runner.cancel(id), true);
    let alive = true; const stoppedBy = Date.now() + 5_000;
    while (alive && Date.now() < stoppedBy) { try { process.kill(pid, 0); } catch { alive = false; } if (alive) await new Promise(r => setTimeout(r, 20)); }
    assert.equal(alive, false, "external executable reaped after cancellation");
    assert.equal((await runner.getRun(id))?.status, "cancelled");
  } finally { await runner.stop(); await started; }
});


test("custom registry storage stages verified local artifacts and recovers pinned activations offline", { timeout: 15_000 }, async t => {
  const { root, registry: original, manifest } = await setup(t);
  const metadata = new MemoryRegistryMetadataAdapter(), blobs = new MemoryRegistryBlobAdapter();
  Object.assign(metadata, { privateCredential: "do-not-copy-adapter-secret" });
  const registry = new ImageRegistry({ storage: { id: "remote-test-registry", metadata, blobs } });
  await registry.putBlob(await original.getBlob(manifest.artifacts[0]!.digest));
  const image = await registry.publish(manifest);
  await registry.setTag(manifest.name, "latest", image.digest);
  const stateDir = join(root, "custom-runtime"), cacheDir = join(root, "verified-cache");
  const firstRunner = new SignalRunner({ maxConcurrent: 0 });
  const runtime = new ImageRuntime({ registry, signalRunner: firstRunner, stateDir, cacheDir, backend, allowedEnv: ["IMAGE_ALLOWED"] });
  await runtime.install(`${manifest.name}@latest`);
  const name = imageSignalName(image.digest, "echo");
  assert.equal((await new FileImageRegistry(cacheDir).getManifest(image.digest)).digest, image.digest);
  const shim = await readFile(join(stateDir, `${name}.mjs`), "utf8");
  assert.ok(shim.includes(cacheDir));
  assert.ok(!shim.includes("do-not-copy-adapter-secret"));
  assert.ok(!shim.includes("remote-test-registry"));
  metadata.read = async () => { throw new Error("storage unavailable"); };
  blobs.read = async () => { throw new Error("storage unavailable"); };
  const runner = new SignalRunner({ pollIntervalMs: 20, envProvider: { resolveFor: async () => ({ IMAGE_ALLOWED: "cached" }) } });
  const restored = new ImageRuntime({ registry, signalRunner: runner, stateDir, cacheDir, backend, allowedEnv: ["IMAGE_ALLOWED"] });
  assert.equal((await restored.restore()).length, 1);
  await restored.install(image.digest);
  await restored.install(`${manifest.name}@${image.digest}`);
  await assert.rejects(restored.install(`${manifest.name}@latest`), /storage unavailable/);
  const loop = runner.start();
  try {
    const id = await runner.triggerSignal(name, { message: "offline" });
    const run = await runner.waitForRun(id, { timeoutMs: 10_000 });
    assert.equal(run?.status, "completed", run?.error);
    assert.equal(JSON.parse(run!.output!).value, "cached");
  } finally { await runner.stop(); await loop; }
  const changed = new ImageRuntime({ registry: new ImageRegistry({ storage: { id: "different-authority", metadata, blobs } }), signalRunner: firstRunner, stateDir, cacheDir, backend, allowedEnv: ["IMAGE_ALLOWED"] });
  await assert.rejects(changed.restore(), { code: "incompatible_state" });
});
