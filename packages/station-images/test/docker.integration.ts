/** Opt in with STATION_IMAGE_DOCKER_IMAGE=repo@sha256:... (preinstalled Node + GNU timeout image).
 * If the engine default is unconfined, set STATION_IMAGE_DOCKER_SECCOMP to a reviewed deny-default profile.
 * Official matching test profile: https://raw.githubusercontent.com/moby/moby/v27.5.1/profiles/seccomp/default.json
 * node --import tsx --test packages/station-images/test/docker.integration.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerImageProcessBackend } from "../src/docker.js";
import { FileImageRegistry, executeImage } from "../src/index.js";

test("real Docker image uses non-root, read-only filesystem and bounded cgroups without host credentials", {
  skip: !process.env.STATION_IMAGE_DOCKER_IMAGE,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "station-docker-live-"));
  const artifact = join(root, "entry.mjs");
  const bytes = Buffer.from(`import fs from 'node:fs';import os from 'node:os';
let rootReadOnly=false;
try { fs.writeFileSync('/station-escape','x'); } catch { rootReadOnly=true; }
const value={interfaces:Object.keys(os.networkInterfaces()),uid:process.getuid(),rootReadOnly,socket:fs.existsSync('/var/run/docker.sock'),hostSecret:process.env.STATION_DOCKER_TEST_SECRET,token:process.env.APPLICATION_TOKEN,memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),status:fs.readFileSync('/proc/self/status','utf8')};
process.stdin.resume(); process.stdin.once('end',()=>console.log(JSON.stringify(value)));
`);
  await writeFile(artifact, bytes);
  process.env.STATION_DOCKER_TEST_SECRET = "must-not-cross-boundary";
  const backend = new DockerImageProcessBackend({
    image: process.env.STATION_IMAGE_DOCKER_IMAGE!, rootDir: join(root, "backend"),
    target: { os: "linux", arch: process.env.STATION_IMAGE_DOCKER_ARCH === "amd64" ? "amd64" : process.arch === "arm64" ? "arm64" : "amd64", runtimes: { node: 22 } },
    socketPath: process.env.STATION_IMAGE_DOCKER_SOCKET,
    seccompProfile: process.env.STATION_IMAGE_DOCKER_SECCOMP,
  });
  let boundary;
  try {
    boundary = await backend.spawn({ directory: root, executablePath: artifact,
      artifact: { platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 22, entrypoint: "entry.mjs", size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
      env: { APPLICATION_TOKEN: "approved-value" },
    });
    let stdout = "", stderr = "";
    boundary.stdout.on("data", data => { stdout += data.toString(); });
    boundary.stderr.on("data", data => { stderr += data.toString(); });
    boundary.stdin.end();
    assert.equal((await boundary.exited).code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.uid, 1000);
    assert.deepEqual(result.interfaces, ["lo"]);
    assert.equal(result.rootReadOnly, true);
    assert.equal(result.socket, false);
    assert.equal(result.hostSecret, undefined);
    assert.equal(result.token, "approved-value");
    assert.equal(result.memory, String(256 * 1024 * 1024));
    assert.equal(result.pids, "64");
    assert.match(result.status, /CapEff:\s+0000000000000000/);
    assert.match(result.status, /NoNewPrivs:\s+1/);
    assert.match(result.status, /Seccomp:\s+2/);
    await boundary.dispose(); boundary = undefined;
    assert.deepEqual((await readdir(join(root, "backend"))).filter(name=>name.startsWith("invocation-")), []);
  } finally {
    delete process.env.STATION_DOCKER_TEST_SECRET;
    await boundary?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});


// Native fixture preparation (Go is optional; no registry/model/provider credentials):
// GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o /tmp/station-native test/fixtures/docker-native.go
// Set STATION_IMAGE_DOCKER_NATIVE=/tmp/station-native alongside the pinned image.
for (const runtime of ["node", "native"] as const) {
  test(`real Docker executes ${runtime} Station images through verified registry and NDJSON protocol`, {
    skip: !process.env.STATION_IMAGE_DOCKER_IMAGE || runtime === "native" && !process.env.STATION_IMAGE_DOCKER_NATIVE,
    timeout: 30000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "station-docker-image-e2e-"));
    const arch = process.env.STATION_IMAGE_DOCKER_ARCH === "amd64" ? "amd64" as const : process.arch === "arm64" ? "arm64" as const : "amd64" as const;
    try {
      const bytes = runtime === "native" ? await readFile(process.env.STATION_IMAGE_DOCKER_NATIVE!) : Buffer.from(`let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{const request=JSON.parse(input);console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{input:request.input,token:process.env.APPLICATION_TOKEN,uid:process.getuid()}}));});`);
      const registry = new FileImageRegistry(join(root,"registry"));
      const blob = await registry.putBlob(bytes);
      const image = await registry.publish({ format:"station.image/v1", protocol:"station.process/v1", name:`test/docker-${runtime}`, version:"1.0.0",
        artifacts: [{platform: runtime === "native" ? {os:"linux",arch,abi:"none"} : {os:"any",arch:"any"},runtime,...(runtime === "node" ? {runtimeMajor:22}:{}),digest:blob.digest,size:bytes.length,entrypoint:runtime === "native" ? "native-runner":"runner.mjs"}],
        exports:[{kind:"signal",name:"echo",requiredEnv:["APPLICATION_TOKEN"],inputSchema:{type:"object",properties:{value:{type:"integer"}},required:["value"],additionalProperties:false}}],
      });
      const backend = new DockerImageProcessBackend({image:process.env.STATION_IMAGE_DOCKER_IMAGE!,rootDir:join(root,"backend"),target:{os:"linux",arch,runtimes:{node:22}},socketPath:process.env.STATION_IMAGE_DOCKER_SOCKET,seccompProfile:process.env.STATION_IMAGE_DOCKER_SECCOMP});
      const result = await executeImage({registry,reference:image.digest,exportName:"echo",input:{value:42},runId:`docker-${runtime}-test`,backend,environment:{allowedKeys:["APPLICATION_TOKEN"],store:{APPLICATION_TOKEN:"test-only-token"}}});
      assert.deepEqual(result.output,{input:{value:42},token:"test-only-token",uid:1000});
      assert.equal(result.image.digest,image.digest);
      assert.deepEqual((await readdir(join(root,"backend"))).filter(name=>name.startsWith("invocation-")),[]);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
}

test("real Docker timeout removes the complete execution boundary", {
  skip: !process.env.STATION_IMAGE_DOCKER_IMAGE, timeout: 30000,
}, async () => {
  const root=await mkdtemp(join(tmpdir(),"station-docker-timeout-"));
  try {
    const registry=new FileImageRegistry(join(root,"registry"));
    const bytes=Buffer.from("setInterval(()=>{},1000);");
    const blob=await registry.putBlob(bytes);
    const image=await registry.publish({format:"station.image/v1",protocol:"station.process/v1",name:"test/docker-timeout",version:"1.0.0",artifacts:[{platform:{os:"any",arch:"any"},runtime:"node",runtimeMajor:22,entrypoint:"wait.mjs",digest:blob.digest,size:bytes.length}],exports:[{name:"wait",kind:"signal",timeoutMs:150}]});
    const backend=new DockerImageProcessBackend({image:process.env.STATION_IMAGE_DOCKER_IMAGE!,rootDir:join(root,"backend"),target:{os:"linux",arch:process.env.STATION_IMAGE_DOCKER_ARCH==="amd64"?"amd64":process.arch==="arm64"?"arm64":"amd64",runtimes:{node:22}},socketPath:process.env.STATION_IMAGE_DOCKER_SOCKET,seccompProfile:process.env.STATION_IMAGE_DOCKER_SECCOMP});
    await assert.rejects(executeImage({registry,reference:image.digest,exportName:"wait",input:{},runId:"timeout",backend}),{code:"timeout"});
    assert.deepEqual((await readdir(join(root,"backend"))).filter(name=>name.startsWith("invocation-")),[]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("an independent reaper removes an expired running Docker invocation", {
  skip: !process.env.STATION_IMAGE_DOCKER_IMAGE, timeout: 30000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "station-docker-reaper-"));
  const artifact = join(root, "wait.mjs");
  const bytes = Buffer.from("setInterval(()=>{},1000);");
  const options = {
    image: process.env.STATION_IMAGE_DOCKER_IMAGE!, rootDir: join(root, "backend"),
    target: { os: "linux" as const, arch: process.env.STATION_IMAGE_DOCKER_ARCH === "amd64" ? "amd64" as const : process.arch === "arm64" ? "arm64" as const : "amd64" as const, runtimes: { node: 22 } },
    socketPath: process.env.STATION_IMAGE_DOCKER_SOCKET,
    seccompProfile: process.env.STATION_IMAGE_DOCKER_SECCOMP,
  };
  let boundary;
  try {
    await writeFile(artifact, bytes);
    boundary = await new DockerImageProcessBackend(options).spawn({
      directory: root, executablePath: artifact,
      artifact: { platform: { os: "any", arch: "any" }, runtime: "node", runtimeMajor: 22, entrypoint: "wait.mjs", size: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
      env: {},
    });
    boundary.stdout.resume(); boundary.stderr.resume(); boundary.stdin.end();
    const [invocation] = (await readdir(options.rootDir)).filter(name => name.startsWith("invocation-"));
    const journal = JSON.parse(await readFile(join(options.rootDir, invocation, "container.json"), "utf8"));
    const reaper = new DockerImageProcessBackend(options);
    assert.deepEqual(await reaper.reapExpired(journal.expiresAt - 1), { removed: 0, retained: 1 });
    // Advance the reaper's operator-only clock without waiting five minutes. The
    // original controller takes no part in removing this still-running container.
    assert.deepEqual(await reaper.reapExpired(journal.expiresAt), { removed: 1, retained: 0 });
    await boundary.exited;
    await boundary.dispose(); boundary = undefined;
    assert.deepEqual((await readdir(options.rootDir)).filter(name => name.startsWith("invocation-")), []);
    assert.deepEqual(await reaper.reapExpired(journal.expiresAt), { removed: 0, retained: 0 });
  } finally {
    await boundary?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
