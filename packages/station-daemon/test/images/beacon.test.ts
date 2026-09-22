import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BeaconRunner, BeaconMemoryAdapter } from "station-beacon";
import { FileImageRegistry, type ImageManifest } from "station-images";
import { createImageBeacon } from "../../src/images/beacon-shim.js";
import { imageSignalName, type ImageSignalConfig } from "../../src/images/runtime.js";
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve("tsx"));
async function waitUntil(predicate: () => Promise<boolean>, label: string, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`Timed out waiting for ${label}`);
}

test("image beacon runs in the real supervisor with env grants, polls, brokered trigger and clean stop", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "station-beacon-image-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, "registry"));
  const dependencyBytes = Buffer.from("process.exit(0)");
  const dep = await registry.putBlob(dependencyBytes);
  const dependency = await registry.publish({ format: "station.image/v1", protocol: "station.process/v1", name: "test/dependency", version: "1.0.0", artifacts: [{ ...dep, platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 20, entrypoint: "dep.mjs" }], exports: [{ name: "echo", kind: "signal" }] });
  const source = Buffer.from(`import{createInterface}from'node:readline';import{writeFileSync}from'node:fs';const send=o=>console.log(JSON.stringify({protocol:'station.process/v1',...o}));let config,timer,polls=0;createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.type==='beacon:init'){config=r.config;writeFileSync(config.observed,JSON.stringify({config,token:process.env.IMAGE_TOKEN,leaked:process.env.IMAGE_HOST_ONLY??null,instance:r.instanceId,incarnation:r.incarnation}));send({type:'beacon:started'});send({type:'beacon:ready'});timer=setInterval(()=>send({type:'beacon:heartbeat'}),40);}if(r.type==='beacon:poll'){polls++;writeFileSync(config.polls,String(polls));if(polls===1)send({type:'trigger',id:'trigger-1',dependency:'echo',input:{message:config.message}});send({type:'beacon:poll-completed',invocationId:r.invocationId});}if(r.type==='trigger:result')writeFileSync(config.trigger,JSON.stringify(r));if(r.type==='beacon:stop'){clearInterval(timer);writeFileSync(config.stopped,'graceful');send({type:'beacon:stopped'});}});`);
  const artifact = await registry.putBlob(source);
  const manifest: ImageManifest = { format: "station.image/v1", protocol: "station.process/v1", name: "test/beacon", version: "1.0.0", artifacts: [{ ...artifact, platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 20, entrypoint: "watch.mjs" }], exports: [{ name: "watch", kind: "beacon", mode: "poll", pollIntervalMs: 25, startMode: "on-demand", requiredEnv: ["IMAGE_TOKEN"], configSchema: { type: "object", required: ["message"] } }], dependencies: { echo: { image: `test/dependency@${dependency.digest}`, export: "echo", kind: "signal" } } };
  const image = await registry.publish(manifest);
  const definitionName = imageSignalName(image.digest, "watch");
  const config: ImageSignalConfig = { registryRoot: registry.root, digest: image.digest, name: definitionName, definition: manifest.exports[0]!, allowedEnv: ["IMAGE_TOKEN"], backend: { kind: "trusted-local", allowUnsafeHostExecution: true, target: { os: process.platform as "darwin" | "linux", arch: process.arch === "arm64" ? "arm64" : "amd64", runtimes: { node: Number(process.versions.node.split(".")[0]) } } } };
  const wrapper = join(root, "wrapper.mjs");
  const shim = pathToFileURL(fileURLToPath(new URL("../../src/images/beacon-shim.ts", import.meta.url))).href;
  await writeFile(wrapper, `import { createImageBeacon } from ${JSON.stringify(shim)};export const imageBeacon = createImageBeacon(${JSON.stringify(config)});`);
  const old = process.env.IMAGE_HOST_ONLY; process.env.IMAGE_HOST_ONLY = "not-inherited";
  t.after(() => { if (old === undefined) delete process.env.IMAGE_HOST_ONLY; else process.env.IMAGE_HOST_ONLY = old; });
  const errors: string[] = [], calls: unknown[] = [];
  const runner = new BeaconRunner({ adapter: new BeaconMemoryAdapter(), pollIntervalMs: 20, envProvider: { resolveFor: async () => ({ IMAGE_TOKEN: "approved", IMAGE_NOT_GRANTED: "not-forwarded" }) }, subscribers: [{ onBeaconErrored: event => { errors.push(JSON.stringify(event)); } }] });
  runner.setDependencyTrigger(async request => { calls.push(request); return "signal-run-123"; });
  runner.register(createImageBeacon(config), wrapper);
  const running = runner.start();
  const observed = join(root, "observed.json"), polls = join(root, "polls"), trigger = join(root, "trigger.json"), stopped = join(root, "stopped");
  try {
    await runner.whenReady();
    const instance = await runner.createInstance(definitionName, { id: "image-instance", config: { message: "hello", observed, polls, trigger, stopped } });
    await waitUntil(async () => Boolean((await runner.getInstance(instance.id))?.readyAt), "image beacon readiness");
    await waitUntil(async () => { try { return JSON.parse(await readFile(trigger, "utf8")).runId === "signal-run-123"; } catch { return false; } }, "brokered dependency response");
    const result = JSON.parse(await readFile(observed, "utf8"));
    assert.equal(result.token, "approved"); assert.equal(result.leaked, null); assert.equal(result.instance, instance.id); assert.equal(result.config.message, "hello");
    assert.ok(Number(await readFile(polls, "utf8")) >= 1);
    assert.equal(calls.length, 1); assert.equal((calls[0] as { alias: string }).alias, "echo");
    await runner.stopInstance(instance.id);
    await waitUntil(async () => (await runner.getInstance(instance.id))?.status === "stopped", "clean image stop");
    assert.equal(await readFile(stopped, "utf8"), "graceful");
    assert.deepEqual(errors, []);
    assert.equal((await runner.getInstance(instance.id))?.lastExitReason, "stopped");
  } finally { await runner.stop({ graceful: true, timeoutMs: 5000 }); await running; }
});
