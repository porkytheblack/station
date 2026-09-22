// Station bootstrap microbenchmark, not a fleet throughput benchmark.
// Run after building station-signal. Requires node and bun on PATH.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "station-runtime-bench-"));
writeFileSync(join(dir, "package.json"), JSON.stringify({type:"module"}));
const bootstrap = join(root, "packages/station-signal/dist/bootstrap.js");
const moduleURL = pathToFileURL(join(root, "packages/station-signal/dist/index.js")).href;
const fixture = `import { signal, z } from ${JSON.stringify(moduleURL)};
export const probe = signal("runtime-probe").input(z.object({delayMs:z.number()})).run(async ({delayMs}) => {
  if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  return { ok:true, rss:process.memoryUsage().rss, runtime:process.versions.bun ? "bun" : "node", version:process.versions.bun ?? process.versions.node };
});`;
for (const ext of ["mjs", "ts"]) writeFileSync(join(dir, `probe.${ext}`), fixture);
// Send init only after bootstrap attaches its listener. This avoids counting
// an early-IPC delivery race as runtime speed; both runtimes use this wrapper.
const entry = join(dir, "entry.mjs");
writeFileSync(entry, `process.on("newListener", event => {
  if (event === "message") queueMicrotask(() => process.send({type:"benchmark:ready"}));
});
await import(${JSON.stringify(pathToFileURL(bootstrap).href)});`);
const cases = [
  { name: "Node / JavaScript", executable: "node", args: [entry], ext: "mjs" },
  { name: "Node + tsx / TypeScript", executable: "node", args: ["--import", import.meta.resolve("tsx"), entry], ext: "ts" },
  { name: "Bun / JavaScript", executable: "bun", args: [entry], ext: "mjs" },
  { name: "Bun / TypeScript", executable: "bun", args: [entry], ext: "ts" },
];
const samples = Number(process.env.STATION_BENCH_SAMPLES ?? 20);
const delayMs = Number(process.env.STATION_BENCH_DELAY_MS ?? 0);
if (!Number.isInteger(samples) || samples < 1 || samples > 200 || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error("Invalid benchmark settings.");
async function run(c) {
  return new Promise((resolveRun, reject) => {
    const start = performance.now();
    const child = spawn(c.executable, c.args, { stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "json" });
    let result;
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${c.name}: timed out ${stderr}`)); }, 10_000);
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("message", message => {
      if (process.env.STATION_BENCH_DEBUG) console.error(c.name, message.type);
      if (message.type === "benchmark:ready") {
        child.send({ type: "job:init", data: { runId: "benchmark", signalName: "runtime-probe", signalFile: pathToFileURL(join(dir, `probe.${c.ext}`)).href, input: JSON.stringify({delayMs}) } });
      }
      if (message.type === "run:completed") {
        result = { ms: performance.now() - start, ...JSON.parse(message.data.output) };
        child.kill("SIGTERM");
      } else if (message.type === "run:failed") {
        child.kill(); reject(new Error(JSON.stringify(message)));
      }
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (!result?.ok) reject(new Error(`${c.name}: ${code} ${stderr}`));
      else resolveRun(result);
    });
  });
}
try {
  const values = new Map(cases.map(c => [c.name, []]));
  for (let i = 0; i < samples + 3; i++) {
    // Alternate order to reduce systematic warm-cache/order bias.
    for (const c of i % 2 ? [...cases].reverse() : cases) {
      const result = await run(c);
      if (i >= 3) values.get(c.name).push(result);
    }
  }
  const percentile = (xs, p) => [...xs].sort((a,b) => a-b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  const summary = cases.map(c => {
    const runs = values.get(c.name);
    return { case: c.name, version: runs[0].version, medianMs: +percentile(runs.map(r=>r.ms),0.5).toFixed(1), p95Ms: +percentile(runs.map(r=>r.ms),0.95).toFixed(1), medianHandlerRssMiB: +(percentile(runs.map(r=>r.rss),0.5)/1024/1024).toFixed(1) };
  });
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, samples, delayMs, scope: "Fresh process through real Station bootstrap, in-memory adapter, trivial signal, JSON IPC. Parent reaps child after completion; excludes natural process drain, queue polling, durable DB, concurrent fleet load and browser processes. RSS is sampled inside handler, not peak/tree memory.", results: summary }, null, 2));
} finally { rmSync(dir, {recursive:true,force:true}); }
