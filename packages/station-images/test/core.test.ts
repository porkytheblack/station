import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FileImageRegistry, digestBytes, manifestDigest, validateManifest, selectArtifact, resolveImageEnvironment, importImage, executeImage, TrustedLocalProcessBackend, validateBroadcastPlan, BeaconProtocolState, startImageBeacon, validateValue, validateSchema, type ImageManifest, type HostTarget } from "../src/index.js";
const protocol = "station.process/v1";
const target: HostTarget = { os: process.platform as HostTarget["os"], arch: process.arch === "arm64" ? "arm64" : "amd64", abi: process.platform === "linux" ? "glibc" : "none", runtimes: { node: Number(process.versions.node.split(".")[0]) } };
function manifest(source: Buffer | string, overrides: Partial<ImageManifest> = {}): ImageManifest {
  return { format: "station.image/v1", protocol, name: "tests/echo", version: "1.0.0", artifacts: [{ platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 20, digest: digestBytes(source), size: Buffer.byteLength(source), entrypoint: "run.mjs" }], exports: [{ name: "echo", kind: "signal" }], ...overrides };
}
async function fixture(t: TestContext, source: string | Buffer, overrides: Partial<ImageManifest> = {}) {
  const root = await mkdtemp(join(tmpdir(), "station-images-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(root);
  await registry.putBlob(Buffer.from(source));
  const image = await registry.publish(manifest(source, overrides));
  const backend = new TrustedLocalProcessBackend({ allowUnsafeHostExecution: true, target });
  return { root, registry, image, backend };
}
const echo = `let data=''; process.stdin.on('data',c=>data+=c); process.stdin.on('end',()=>{const req=JSON.parse(data); process.stdout.write(JSON.stringify({protocol:'${protocol}',type:'result',output:{input:req.input,token:process.env.API_TOKEN,hostSecret:process.env.HOST_SECRET??null}})+'\\n');});`;
const options = { exportName: "echo", input: { value: "hello; $(uname)" }, runId: "run-1", requiredIsolation: "trusted-host" as const };

test("manifest identity is canonical, immutable and validates all three kinds", async t => {
  const { registry, image } = await fixture(t, echo, { exports: [{ name: "echo", kind: "signal" }, { name: "plan", kind: "broadcast", planner: "binary" }, { name: "watch", kind: "beacon", mode: "poll", pollIntervalMs: 1000 }] });
  const reversed = Object.fromEntries(Object.entries(image.manifest).reverse()) as unknown as ImageManifest;
  assert.equal(manifestDigest(reversed), image.digest);
  assert.deepEqual(await registry.resolve("tests/echo@1.0.0"), image);
  await registry.setTag("tests/echo", "latest", image.digest);
  assert.deepEqual(await registry.resolve("tests/echo@latest"), image);
  assert.equal((await registry.list()).length, 1);
  const conflict: ImageManifest = { ...image.manifest, exports: [{ name: "changed", kind: "signal" }] };
  await assert.rejects(registry.publish(conflict), { code: "immutable_conflict" });
  await assert.rejects(registry.getManifest(manifestDigest(conflict)), { code: "not_found" });
  await assert.rejects(registry.resolve(`other/name@${image.digest}`), { code: "invalid_reference" });
});

test("rejects unsafe manifests, unsupported schemas, ambiguous targets and ungranted env", () => {
  for (const path of ["../run.js", "/tmp/run.js", "a/b.js", "run;evil.js"]) {
    const m = manifest(echo); m.artifacts[0]!.entrypoint = path;
    assert.throws(() => validateManifest(m), { code: "invalid_manifest" });
  }
  const m = manifest(echo); m.artifacts.push(m.artifacts[0]!);
  assert.throws(() => validateManifest(m), { code: "invalid_manifest" });
  assert.throws(() => validateSchema({ type: "string", pattern: ".*" }), { code: "invalid_schema" });
  assert.throws(() => validateValue({ type: "object", required: ["x"], additionalProperties: false, properties: { x: { type: "integer", minimum: 1 } } }, { x: 0 }), { code: "schema_mismatch" });
  for (const key of ["PATH", "NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD", "STATION_API_KEY"]) assert.throws(() => resolveImageEnvironment({ allowedKeys: [key], overrides: { [key]: "secret" } }), { code: "invalid_environment" });
  assert.throws(() => resolveImageEnvironment({ allowedKeys: [], overrides: { API_TOKEN: "secret" } }), { code: "environment_denied" });
  assert.throws(() => resolveImageEnvironment({ allowedKeys: ["API_TOKEN"], requiredKeys: ["API_TOKEN"] }), { code: "missing_environment" });
  assert.equal(resolveImageEnvironment({ allowedKeys: ["APP_VALUE"], defaults: { APP_VALUE: "a" }, store: { APP_VALUE: "b" }, bindings: { APP_VALUE: "c" }, overrides: { APP_VALUE: "d" } }).APP_VALUE, "d");
  const linux = manifest(echo); linux.artifacts[0]!.platform = { os: "linux", arch: "amd64", abi: "musl" }; linux.artifacts[0]!.runtime = "native"; delete linux.artifacts[0]!.runtimeMajor;
  assert.throws(() => selectArtifact(linux, { os: "linux", arch: "amd64", abi: "glibc", runtimes: {} }), { code: "incompatible_target" });
});

test("registry checks hashes, sizes, quotas and file tampering", async t => {
  const { root, registry, image } = await fixture(t, echo);
  await assert.rejects(registry.putBlob(Buffer.from("different"), image.manifest.artifacts[0]!.digest), { code: "digest_mismatch" });
  const script = { ...image.manifest, version: "2.0.0", artifacts: [{ ...image.manifest.artifacts[0]!, platform: { os: "linux" as const, arch: "amd64" as const, abi: "glibc" as const }, runtime: "native" as const, runtimeMajor: undefined }] };
  delete script.artifacts[0]!.runtimeMajor;
  await assert.rejects(registry.publish(script), { code: "incompatible_binary" });
  const invalid = { ...image.manifest, version: "2.0.0", artifacts: [{ ...image.manifest.artifacts[0]!, size: 1 }] };
  await assert.rejects(registry.publish(invalid), { code: "size_mismatch" });
  await writeFile(join(root, "blobs", image.manifest.artifacts[0]!.digest.slice(7)), "tamper");
  await assert.rejects(registry.getBlob(image.manifest.artifacts[0]!.digest), { code: "digest_mismatch" });
  const small = new FileImageRegistry(join(root, "quota"), { maxBlobBytes: 4, maxTotalBytes: 4 });
  await small.putBlob(Buffer.from("1234"));
  await assert.rejects(small.putBlob(Buffer.from("next")), { code: "registry_quota" });
  await assert.rejects(small.putBlob(Buffer.from("12345")), { code: "blob_too_large" });
});

test("import copies verified pinned dependency closure and refuses tampered source", async t => {
  const source = await fixture(t, echo);
  const dependent = manifest(echo, { name: "tests/dependent", dependencies: { upstream: { image: `tests/echo@${source.image.digest}`, export: "echo", kind: "signal" } } });
  const published = await source.registry.publish(dependent);
  const destination = new FileImageRegistry(join(source.root, "destination"));
  const result = await importImage(destination, `tests/dependent@${published.digest}`, source.registry);
  assert.equal(result.digest, published.digest);
  assert.equal((await destination.list()).length, 2);
  await assert.rejects(importImage(destination, "tests/echo@1.0.0", { resolve: async () => ({ ...source.image, digest: digestBytes("wrong") }), getBlob: source.registry.getBlob.bind(source.registry) }), { code: "digest_mismatch" });
  const wrong = manifest(echo, { name: "tests/wrong", dependencies: { upstream: { image: `tests/echo@${source.image.digest}`, export: "echo", kind: "broadcast" } } });
  await assert.rejects(source.registry.publish(wrong), { code: "invalid_dependency" });
});

test("JS protocol passes JSON params and granted env without inheriting host secrets", async t => {
  const f = await fixture(t, echo, { exports: [{ name: "echo", kind: "signal", requiredEnv: ["API_TOKEN"], outputSchema: { type: "object", required: ["input", "token"] } }] });
  process.env.HOST_SECRET = "not-for-child";
  t.after(() => { delete process.env.HOST_SECRET; });
  const result = await executeImage({ ...f, ...options, reference: f.image.digest, environment: { allowedKeys: ["API_TOKEN"], bindings: { API_TOKEN: "approved" } } });
  assert.deepEqual(result.output, { input: options.input, token: "approved", hostSecret: null });
  await assert.rejects(executeImage({ ...f, ...options, requiredIsolation: "container", reference: f.image.digest }), { code: "isolation_required" });
});

test("native executable receives stdin params and scoped environment", { skip: process.platform === "win32" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "station-native-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const code = '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(){char line[8192];if(!fgets(line,sizeof(line),stdin)||!strstr(line,"hello")||!getenv("API_TOKEN")||strcmp(getenv("API_TOKEN"),"approved"))return 2;puts("{\\"protocol\\":\\"station.process/v1\\",\\"type\\":\\"result\\",\\"output\\":{\\"native\\":true}}");return 0;}';
  await writeFile(join(dir, "test.c"), code);
  try { execFileSync("cc", [join(dir, "test.c"), "-o", join(dir, "native")], { stdio: "pipe" }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("C compiler unavailable"); return; } throw error; }
  const bytes = await readFile(join(dir, "native"));
  const f = await fixture(t, bytes, { artifacts: [{ platform: { os: target.os, arch: target.arch, abi: target.abi }, runtime: "native", digest: digestBytes(bytes), size: bytes.byteLength, entrypoint: "native" }] });
  const result = await executeImage({ ...f, ...options, reference: f.image.digest, environment: { allowedKeys: ["API_TOKEN"], bindings: { API_TOKEN: "approved" } } });
  assert.deepEqual(result.output, { native: true });
});

for (const [label, source, expected] of [
  ["duplicate result", `console.log(JSON.stringify({protocol:'${protocol}',type:'result',output:1}));console.log(JSON.stringify({protocol:'${protocol}',type:'result',output:2}));`, "duplicate_terminal"],
  ["malformed frame", `console.log('not json');`, "malformed_protocol"],
  ["wrong version", `console.log(JSON.stringify({protocol:'station.process/v2',type:'result',output:1}));`, "incompatible_protocol"],
  ["nonzero after result", `console.log(JSON.stringify({protocol:'${protocol}',type:'result',output:1}));process.exitCode=3;`, "process_exit"],
  ["application error redacted", `console.log(JSON.stringify({protocol:'${protocol}',type:'error',error:{code:'bad',message:'secret should not leak'}}));`, "application_error"],
  ["missing result", `process.stdin.resume();`, "missing_result"],
  ["oversized stdout", `process.stdout.write('x'.repeat(9000));`, "output_limit"],
  ["oversized stderr", `process.stderr.write('x'.repeat(9000));`, "stderr_limit"],
] as const) test(`rejects ${label}`, async t => {
  const f = await fixture(t, source);
  await assert.rejects(executeImage({ ...f, ...options, reference: f.image.digest, maxOutputBytes: 4096, maxStderrBytes: 4096 }), { code: expected });
});

test("deadline and cancellation stop the execution boundary", async t => {
  const f = await fixture(t, `process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  await assert.rejects(executeImage({ ...f, ...options, reference: f.image.digest, timeoutMs: 100 }), { code: "timeout" });
  const controller = new AbortController();
  const invocation = executeImage({ ...f, ...options, reference: f.image.digest, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(invocation, { code: "cancelled" });
});

test("broadcast planner output validates DAG, allowed signals and expression scope", async t => {
  const m = manifest(echo, { exports: [{ name: "echo", kind: "signal" }, { name: "plan", kind: "broadcast", planner: "binary" }] });
  const plan = { nodes: [{ name: "one", signalName: "echo", dependsOn: [], input: { kind: "ref", path: ["input"] } }, { name: "two", signalName: "echo", dependsOn: ["one"], input: { kind: "ref", path: ["upstream", "one"] } }] };
  validateBroadcastPlan(plan, m);
  assert.throws(() => validateBroadcastPlan({ nodes: [{ name: "one", signalName: "unknown", dependsOn: [] }] }, m), { code: "invalid_plan" });
  assert.throws(() => validateBroadcastPlan({ nodes: [{ name: "one", signalName: "echo", dependsOn: ["one"] }] }, m), { code: "invalid_plan" });
  assert.throws(() => validateBroadcastPlan({ nodes: [{ name: "one", signalName: "echo", dependsOn: [], input: { kind: "ref", path: ["upstream", "secret"] } }] }, m), { code: "invalid_plan" });
  const source = `console.log(JSON.stringify({protocol:'${protocol}',type:'result',output:${JSON.stringify(plan)}}));`;
  const f = await fixture(t, source, { exports: m.exports });
  const result = await executeImage({ ...f, ...options, exportName: "plan", reference: f.image.digest });
  assert.deepEqual(result.output, plan);
});

const beaconSource = `import{createInterface}from'node:readline';const send=o=>console.log(JSON.stringify({protocol:'${protocol}',...o}));let timer;createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.type==='beacon:init'){send({type:'beacon:started'});send({type:'beacon:ready'});timer=setInterval(()=>send({type:'beacon:heartbeat'}),50);}if(r.type==='beacon:poll')setTimeout(()=>send({type:'beacon:poll-completed',invocationId:r.invocationId}),20);if(r.type==='beacon:stop'){clearInterval(timer);send({type:'beacon:stopped'});process.exitCode=0;}});`;
test("beacon session provides readiness, nonoverlapping polls, heartbeats and graceful stop", async t => {
  const f = await fixture(t, beaconSource, { exports: [{ name: "watch", kind: "beacon", mode: "poll", pollIntervalMs: 1000, configSchema: { type: "object" } }] });
  const events: string[] = [];
  const session = await startImageBeacon({ ...f, reference: f.image.digest, exportName: "watch", config: {}, instanceId: "instance-1", incarnation: "generation-1", requiredIsolation: "trusted-host", onEvent: frame => events.push(String(frame.type)) });
  await session.ready;
  const poll = session.poll("poll-1");
  await assert.rejects(session.poll("poll-2"), { code: "invalid_beacon_state" });
  await poll; await session.stop(); await session.done;
  assert.deepEqual(events.filter(e => e !== "beacon:heartbeat"), ["beacon:started", "beacon:ready", "beacon:poll-completed", "beacon:stopped"]);
});

test("beacon state rejects triggers outside declared grants and mismatched polls", () => {
  const m = manifest(echo, { exports: [{ name: "watch", kind: "beacon", mode: "poll", pollIntervalMs: 1000 }] });
  const state = new BeaconProtocolState(m, "watch");
  assert.throws(() => state.accept({ protocol, type: "beacon:ready" }), { code: "invalid_beacon_state" });
  state.accept({ protocol, type: "beacon:started" }); state.accept({ protocol, type: "beacon:ready" }); state.beginPoll("poll-1");
  assert.throws(() => state.accept({ protocol, type: "beacon:poll-completed", invocationId: "wrong" }), { code: "invalid_beacon_state" });
  assert.throws(() => state.accept({ protocol, type: "trigger", id: "trigger-1", dependency: "other", input: {} }), { code: "dependency_denied" });
});

test("beacon exits on heartbeat timeout", async t => {
  const source = `console.log(JSON.stringify({protocol:'${protocol}',type:'beacon:started'}));console.log(JSON.stringify({protocol:'${protocol}',type:'beacon:ready'}));process.stdin.resume();setInterval(()=>{},1000);`;
  const f = await fixture(t, source, { exports: [{ name: "watch", kind: "beacon", mode: "run" }] });
  const session = await startImageBeacon({ ...f, reference: f.image.digest, exportName: "watch", config: {}, instanceId: "instance", incarnation: "generation", requiredIsolation: "trusted-host", heartbeatTimeoutMs: 100 });
  await session.ready;
  await assert.rejects(session.done, { code: "heartbeat_timeout" });
});

test("beacon trigger broker grants dependencies and deduplicates correlation identity", async t => {
  const upstream = await fixture(t, echo);
  const source = `import{createInterface}from'node:readline';const send=o=>console.log(JSON.stringify({protocol:'${protocol}',...o}));let timer;createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.type==='beacon:init'){send({type:'beacon:started'});send({type:'beacon:ready'});timer=setInterval(()=>send({type:'beacon:heartbeat'}),30);const req={type:'trigger',id:'request-1',dependency:'echo',input:{value:123}};send(req);send(req);}if(r.type==='beacon:stop'){clearInterval(timer);send({type:'beacon:stopped'});}});`;
  await upstream.registry.putBlob(Buffer.from(source));
  const image = await upstream.registry.publish(manifest(source, { name: "tests/beacon", exports: [{ name: "watch", kind: "beacon", mode: "run" }], dependencies: { echo: { image: `tests/echo@${upstream.image.digest}`, export: "echo", kind: "signal" } } }));
  let calls = 0, triggerEvents = 0, resolveObserved!: () => void;
  const observed = new Promise<void>(resolve => { resolveObserved = resolve; });
  const session = await startImageBeacon({ registry: upstream.registry, backend: upstream.backend, reference: image.digest, exportName: "watch", config: {}, instanceId: "instance-1", incarnation: "generation-1", requiredIsolation: "trusted-host", onEvent: frame => { if (frame.type === "trigger" && ++triggerEvents === 2) resolveObserved(); }, trigger: async req => { calls++; assert.equal(req.alias, "echo"); assert.equal(req.dependency.image, `tests/echo@${upstream.image.digest}`); assert.deepEqual(req.input, { value: 123 }); return "run-123"; } });
  await session.ready; await observed; await session.stop();
  assert.equal(calls, 1);
});

test("beacon poll timeout terminates boundary; malformed startup rejects ready", async t => {
  const source = `console.log(JSON.stringify({protocol:'${protocol}',type:'beacon:started'}));console.log(JSON.stringify({protocol:'${protocol}',type:'beacon:ready'}));process.stdin.resume();setInterval(()=>{},1000);`;
  const f = await fixture(t, source, { exports: [{ name: "watch", kind: "beacon", mode: "poll", pollIntervalMs: 1000 }] });
  const session = await startImageBeacon({ ...f, reference: f.image.digest, exportName: "watch", config: {}, instanceId: "instance", incarnation: "generation", requiredIsolation: "trusted-host", pollTimeoutMs: 50 });
  await session.ready;
  await assert.rejects(session.poll(), { code: "poll_timeout" });
  await assert.rejects(session.done, { code: "poll_timeout" });
  const bad = await fixture(t, `console.log('bad-frame');process.stdin.resume();`, { exports: [{ name: "watch", kind: "beacon", mode: "run" }] });
  const malformed = await startImageBeacon({ ...bad, reference: bad.image.digest, exportName: "watch", config: {}, instanceId: "instance", incarnation: "generation", requiredIsolation: "trusted-host" });
  await assert.rejects(malformed.ready, { code: "malformed_protocol" });
  await assert.rejects(malformed.done, { code: "malformed_protocol" });
});
