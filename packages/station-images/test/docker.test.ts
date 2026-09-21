import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DockerImageProcessBackend } from "../src/docker.js";
import type { ImageProcessSpec } from "../src/execution.js";

const image = `node@sha256:${"a".repeat(64)}`;
const target = { os: "linux" as const, arch: "amd64" as const, runtimes: { node: 22 } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "station-docker-test-"));
  const config = join(root, "engine.json"), log = join(root, "calls.jsonl");
  const executable = join(root, "docker");
  await writeFile(config, JSON.stringify({}));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const config=JSON.parse(fs.readFileSync(${JSON.stringify(config)},'utf8'));
const args=process.argv.slice(2), entry={args,env:process.env};
if(args[0]==='create') entry.fileEnvironment=fs.readFileSync(args[args.indexOf('--env-file')+1],'utf8');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(entry)+'\\n');
if(args[0]==='info') console.log(JSON.stringify({OSType:'linux',SecurityOptions:[config.unconfined?'name=seccomp,profile=unconfined':'name=seccomp,profile=builtin'],MemoryLimit:true,SwapLimit:true,PidsLimit:true,CpuCfsQuota:!config.noLimits}));
else if(args[0]==='image') console.log(JSON.stringify({Os:'linux',Architecture:'amd64',Config:{Volumes:config.volumes?{'/data':{}}:null}}));
else if(args[0]==='create') {if(config.failCreate)process.exit(1); console.log('container-id');}
else if(args[0]==='start') {process.stdin.on('data',data=>{process.stdout.write(data);});process.stdin.on('end',()=>process.exit(0));}
else if(args[0]==='inspect') {
 const previous=fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(x=>JSON.parse(x)).findLast(x=>x.args[0]==='create');
 const labels={};if(previous)for(let i=0;i<previous.args.length;i++)if(previous.args[i]==='--label'){const v=previous.args[++i],at=v.indexOf('=');labels[v.slice(0,at)]=v.slice(at+1);}
 if(config.intent)Object.assign(labels,{'station.image.execution':'true','station.image.owner':config.intent.owner,'station.image.invocation':config.intent.name,'station.image.created-at':String(config.intent.createdAt),'station.image.expires-at':String(config.intent.expiresAt)});
 if(config.wrongLabel)labels['station.image.owner']='someone-else';
 const name=config.intent?.name??(previous?previous.args[previous.args.indexOf('--name')+1]:args.at(-1));
 console.log(args.includes('{{.State.Running}}')?'false':JSON.stringify({Id:'f'.repeat(64),Name:'/'+name,State:{Running:!!config.running},Config:{Image:${JSON.stringify(image)},Labels:labels}}));
}
else if(args[0]==='ps'&&config.failRemove)console.log('still-exists');
else if(args[0]==='rm'&&config.failRemove)process.exit(1);
`, { mode: 0o755 });
  const directory = join(root, "source"); await mkdir(directory);
  const executablePath = join(directory, "entry.mjs");
  const bytes = Buffer.from("// verified artifact\n"); await writeFile(executablePath, bytes);
  const spec: ImageProcessSpec = {
    directory, executablePath,
    artifact: { runtime: "node", runtimeMajor: 22, platform: { os: "any", arch: "any" }, entrypoint: "entry.mjs", size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
    env: { APPLICATION_TOKEN: "approved-secret" },
  };
  const options = { image, target, executable, rootDir: join(root, "staging") };
  return { root, config, log, spec, options,
    calls: async () => (await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("Docker requires digest pinning, Linux target, non-root and bounded resources", () => {
  const options = { image, target, rootDir: "/tmp/station-policy-test" };
  for (const patch of [{ image: "node:latest" }, { user: "0:0" }, { memoryMb: 0 }, { cpus: Number.NaN }, { pidsLimit: -1 }, { target: { ...target, os: "darwin" as const } }, { socketPath: "tcp://remote:2375" }]) {
    assert.throws(() => new DockerImageProcessBackend({ ...options, ...patch }));
  }
});

test("Docker isolates artifact-only execution, enforces limits, and does not inherit host secrets", async () => {
  const f = await fixture(); process.env.STATION_DOCKER_TEST_SECRET = "host-only-secret";
  try {
    const backend = new DockerImageProcessBackend(f.options);
    const processBoundary = await backend.spawn(f.spec);
    const invocation = (await readdir(f.options.rootDir)).find(name => name.startsWith("invocation-"))!;
    const intent = JSON.parse(await readFile(join(f.options.rootDir, invocation, "container.json"), "utf8"));
    assert.equal(intent.format, "station.image-invocation/v1");
    assert.equal(intent.expiresAt - intent.createdAt, 300000);
    assert.match(intent.owner, /^[a-f0-9]{64}$/);
    let output = ""; processBoundary.stdout.on("data", b => { output += b.toString(); });
    processBoundary.stdin.end("{\"protocol\":\"station.process/v1\"}\n");
    assert.equal((await processBoundary.exited).code, 0);
    assert.match(output, /station.process/);
    await processBoundary.dispose(); await processBoundary.dispose();
    const calls = await f.calls(), create = calls.find(c => c.args[0] === "create");
    assert.equal(backend.isolation, "container");
    for (const [flag, value] of Object.entries({ "--network":"none", "--user":"1000:1000", "--cap-drop":"ALL", "--security-opt":"no-new-privileges", "--memory":"256m", "--memory-swap":"256m", "--cpus":"1", "--pids-limit":"64", "--pull":"never", "--log-driver":"none", "--entrypoint":"/usr/bin/timeout" })) {
      assert.equal(create.args[create.args.indexOf(flag)+1], value, flag);
    }
    assert.ok(create.args.includes("--read-only"));
    assert.equal(create.args.filter((a: string) => a === "--mount").length, 1);
    assert.match(create.args[create.args.indexOf("--mount")+1], /target=\/station\/entry.mjs,readonly$/);
    assert.ok(create.args.includes("/usr/local/bin/node"));
    assert.equal(create.args.at(-1), "/station/entry.mjs");
    assert.ok(create.args.includes("300s"));
    assert.match(create.fileEnvironment, /APPLICATION_TOKEN=approved-secret/);
    for (const call of calls) {
      assert.equal(call.env.STATION_DOCKER_TEST_SECRET, undefined);
      assert.equal(call.env.APPLICATION_TOKEN, undefined);
      assert.ok(!call.args.join(" ").includes("approved-secret"));
    }
    assert.equal(calls.filter(c=>c.args[0]==="rm").length, 1);
    assert.deepEqual((await readdir(f.options.rootDir)).filter(n=>n.startsWith("invocation-")), []);
  } finally { delete process.env.STATION_DOCKER_TEST_SECRET; await f.cleanup(); }
});

test("Docker rejects unsupported limits, writable image volumes, altered artifacts and multiline secrets", async () => {
  const f = await fixture();
  try {
    await writeFile(f.config, JSON.stringify({ noLimits: true }));
    await assert.rejects(new DockerImageProcessBackend(f.options).ready(), /enforce memory/);
    await writeFile(f.config, JSON.stringify({ volumes: true }));
    await assert.rejects(new DockerImageProcessBackend(f.options).ready(), /writable volumes/);
    await writeFile(f.config, "{}");
    const backend = new DockerImageProcessBackend(f.options);
    await assert.rejects(backend.spawn({ ...f.spec, env: { TOKEN: "a\nb" } }), /single-line/);
    await assert.rejects(backend.spawn({ ...f.spec, artifact: { ...f.spec.artifact, digest: `sha256:${"b".repeat(64)}` } }), /digest/);
    assert.equal((await f.calls()).filter(c=>c.args[0]==="create").length, 0);
  } finally { await f.cleanup(); }
});

test("Docker cancellation targets container, admission is bounded and cleanup failures close admission", async () => {
  const f = await fixture();
  try {
    const backend = new DockerImageProcessBackend({ ...f.options, maxConcurrent: 1 });
    const boundary = await backend.spawn(f.spec);
    await assert.rejects(backend.spawn(f.spec), /capacity/);
    await boundary.terminate(false); await boundary.terminate(true);
    await writeFile(f.config, JSON.stringify({ failRemove: true }));
    await assert.rejects(boundary.dispose(), /reconciliation/);
    await assert.rejects(backend.spawn(f.spec), /reconciliation/);
    await boundary.exited;
    const calls = await f.calls();
    assert.ok(calls.some(c=>c.args[0]==="stop"&&c.args[1]==="--time"));
    assert.ok(calls.some(c=>c.args[0]==="kill"));
    assert.equal((await readdir(f.options.rootDir)).filter(n=>n.startsWith("invocation-")).length, 1);
  } finally { await f.cleanup(); }
});

test("Docker reconciles only stopped matching containers and preserves running journals", async () => {
  const f = await fixture();
  try {
    const backend = new DockerImageProcessBackend(f.options); await backend.ready();
    const dir = join(f.options.rootDir, "invocation-orphan"); await mkdir(dir);
    const intent = { format: "station.image-invocation/v1", name: "station-image-11111111-1111-4111-8111-111111111111", image, owner: createHash("sha256").update(`${f.options.rootDir}\0${image}`).digest("hex"), createdAt: 1000, expiresAt: 2000 };
    await writeFile(join(dir,"container.json"), JSON.stringify(intent));
    await writeFile(f.config, JSON.stringify({ running: true, intent }));
    assert.deepEqual(await backend.reconcile(), { removed: 0, retained: 1 });
    await writeFile(f.config, JSON.stringify({ intent }));
    assert.deepEqual(await backend.reconcile(), { removed: 1, retained: 0 });
  } finally { await f.cleanup(); }
});

async function journal(f: Awaited<ReturnType<typeof fixture>>, expiresAt = 2000) {
  const directory = join(f.options.rootDir, 'invocation-persisted');
  await mkdir(directory, { recursive: true });
  const intent = { format: 'station.image-invocation/v1', name: 'station-image-11111111-1111-4111-8111-111111111111', image, owner: createHash('sha256').update(`${f.options.rootDir}\0${image}`).digest('hex'), createdAt: 1000, expiresAt };
  await writeFile(join(directory, 'container.json'), JSON.stringify(intent));
  return { directory, intent };
}

test('independent reaper preserves live leases and force-removes expired running containers by immutable ID', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const { directory, intent } = await journal(f);
  await writeFile(f.config, JSON.stringify({ running: true, intent }));
  // A new process/backend object needs no live controller state or preloaded runtime image.
  const reaper = new DockerImageProcessBackend(f.options);
  assert.deepEqual(await reaper.reapExpired(1999), { removed: 0, retained: 1 });
  assert.deepEqual(await reaper.reapExpired(2000), { removed: 1, retained: 0 });
  assert.equal((await f.calls()).some(call => call.args[0] === 'image' || call.args[0] === 'info'), false);
  const removal = (await f.calls()).find(call => call.args[0] === 'rm');
  assert.deepEqual(removal.args, ['rm', '--force', 'f'.repeat(64)]);
  await assert.rejects(readFile(join(directory, 'container.json')), { code: 'ENOENT' });
});

test('reaper retains wrong ownership, unmatched container labels and legacy journals', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const { directory, intent } = await journal(f);
  const reaper = new DockerImageProcessBackend(f.options);
  await writeFile(f.config, JSON.stringify({ running: true, intent, wrongLabel: true }));
  assert.deepEqual(await reaper.reapExpired(3000), { removed: 0, retained: 1 });
  await writeFile(join(directory, 'container.json'), JSON.stringify({ ...intent, owner: 'other-root' }));
  assert.deepEqual(await reaper.reapExpired(3000), { removed: 0, retained: 1 });
  await writeFile(join(directory, 'container.json'), JSON.stringify({ name: intent.name, image }));
  assert.deepEqual(await reaper.reapExpired(3000), { removed: 0, retained: 1 });
  assert.equal((await f.calls()).some(call => call.args[0] === 'rm'), false);
});

test('standalone reaper CLI removes persisted expired invocations without a daemon', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const { intent } = await journal(f);
  await writeFile(f.config, JSON.stringify({ running: true, intent }));
  const configPath = join(f.root, 'reaper.json');
  await writeFile(configPath, JSON.stringify(f.options), { mode: 0o600 });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/reaper-cli.ts', import.meta.url)), '--config', configPath, '--once']);
  assert.equal(stderr, ''); assert.deepEqual(JSON.parse(stdout), { type: 'station.image-reaper', removed: 1, retained: 0 });
});

test('explicit deny-default seccomp protects containers when engine default is unconfined', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(f.config, JSON.stringify({ unconfined: true }));
  await assert.rejects(new DockerImageProcessBackend(f.options).ready(), /seccomp/);
  const profile = join(f.root, 'seccomp.json');
  await writeFile(profile, JSON.stringify({ defaultAction: 'SCMP_ACT_ALLOW', syscalls: [] }), { mode: 0o600 });
  await assert.rejects(new DockerImageProcessBackend({ ...f.options, seccompProfile: profile }).ready(), /deny by default/);
  await writeFile(profile, JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [{ names: ['read', 'write'], action: 'SCMP_ACT_ALLOW' }] }));
  const boundary = await new DockerImageProcessBackend({ ...f.options, seccompProfile: profile }).spawn(f.spec);
  boundary.stdin.end(); await boundary.exited; await boundary.dispose();
  const creation = (await f.calls()).find(call => call.args[0] === 'create');
  assert.ok(creation.args.some((arg: string) => /^seccomp=.*seccomp-[a-f0-9]{64}\.json$/.test(arg)));
  const invocationLabel = creation.args.find((arg: string) => arg.startsWith('station.image.expires-at='));
  assert.ok(Number(invocationLabel.split('=')[1]) > Date.now());
});
