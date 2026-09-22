#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DockerImageProcessBackend, type DockerImageOptions } from "./docker.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | undefined, once = false, intervalMs = 5000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") configPath = args[++i];
    else if (args[i] === "--once") once = true;
    else if (args[i] === "--interval-ms") intervalMs = Number(args[++i]);
    else if (args[i] === "--help") { process.stdout.write("Usage: station-image-reaper --config /absolute/operator-docker.json [--once] [--interval-ms 5000]\nRuns independently of stationd; never starts workloads or reads image manifests.\n"); return; }
    else throw new Error("Unknown reaper argument; use --help");
  }
  if (!configPath || !isAbsolute(configPath)) throw new Error("An absolute --config file is required");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error("Reaper interval must be 100–60000 milliseconds");
  const handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config: DockerImageOptions;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o022) !== 0) throw new Error("Reaper configuration must be a bounded regular file without group/world write access");
    try { config = JSON.parse(await handle.readFile("utf8")); } catch { throw new Error("Invalid reaper configuration JSON"); }
  } finally { await handle.close(); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Reaper configuration must be a Docker backend options object");
  const known = new Set(["image", "rootDir", "target", "executable", "user", "memoryMb", "cpus", "pidsLimit", "tmpfsMb", "maxConcurrent", "maxRuntimeMs", "nodeExecutable", "bunExecutable", "socketPath", "seccompProfile"]);
  if (Object.keys(config).some(key => !known.has(key))) throw new Error("Unknown reaper configuration field");
  if (typeof config.rootDir !== "string" || !isAbsolute(config.rootDir)) throw new Error("Reaper rootDir must be an absolute operator-owned staging directory");
  const backend = new DockerImageProcessBackend(config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    do {
      const result = await backend.reapExpired(Date.now(), controller.signal);
      if (once || result.removed) process.stdout.write(JSON.stringify({ type: "station.image-reaper", ...result }) + "\n");
      if (once || controller.signal.aborted) break;
      await new Promise<void>(resolve => {
        const finished = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finished); resolve(); };
        const timer = setTimeout(finished, intervalMs);
        controller.signal.addEventListener("abort", finished, { once: true });
        if (controller.signal.aborted) finished();
      });
    } while (!controller.signal.aborted);
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
void main().catch(() => { process.stderr.write("Station image reaper failed; verify operator configuration and Docker access. No workload credentials were logged.\n"); process.exitCode = 1; });
