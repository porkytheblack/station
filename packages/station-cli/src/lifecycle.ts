import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { open, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { defaultHome, privateDirectory, validateName, writePrivate } from "./store.js";
export interface LaunchSpec {
  kind: "daemon" | "dashboard"; instance: string; entrypoint: string; args: string[];
  cwd: string; endpoint: string; env?: Record<string, string>; home?: string;
}
interface InstanceState { token: string; fingerprint: string; controlPort?: number; pid?: number; status: "starting" | "running" | "stopped" | "failed"; endpoint: string; startedAt: string; exitCode?: number | null }
export interface LocalStatus { instance: string; kind: string; status: string; endpoint?: string; apiReady?: boolean; pid?: number; logPath: string }
function directory(kind: LaunchSpec["kind"], instance: string, home = defaultHome()) { return join(home, "processes", `${kind}-${validateName(instance)}`); }
function fingerprint(spec: LaunchSpec) { return createHash("sha256").update(JSON.stringify({ entrypoint: spec.entrypoint, args: spec.args, cwd: spec.cwd, endpoint: spec.endpoint, env: spec.env ?? {} })).digest("hex"); }
async function readState(dir: string): Promise<InstanceState | undefined> {
  try { return JSON.parse(await readFile(join(dir, "state.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Invalid local instance state; refusing process management."); }
}
async function control(state: InstanceState, action: "status" | "stop"): Promise<{ status: string; pid?: number }> {
  if (!state.controlPort || !state.token) throw new Error("Instance has no authenticated control endpoint.");
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: state.controlPort, path: `/${action}`, method: action === "stop" ? "POST" : "GET", headers: { authorization: `Bearer ${state.token}` }, timeout: 1_000 }, (res) => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; if (body.length > 8192) req.destroy(new Error("Invalid control response.")); });
      res.on("end", () => { try { if (res.statusCode !== 200) throw new Error("Instance control authentication failed."); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on("timeout", () => req.destroy(new Error("Instance control endpoint unavailable."))); req.on("error", reject); req.end();
  });
}
async function ready(endpoint: string, kind: LaunchSpec["kind"]): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}${kind === "daemon" ? "/api/v1/health" : "/"}`, { signal: AbortSignal.timeout(1000), redirect: "manual" });
    if (kind === "dashboard") { await response.body?.cancel(); return response.status >= 200 && response.status < 400; }
    const body = await response.json() as { data?: { ok?: boolean } };
    return response.ok && body.data?.ok === true;
  } catch { return false; }
}
export async function localStatus(kind: LaunchSpec["kind"], instance: string, home = defaultHome()): Promise<LocalStatus> {
  const dir = directory(kind, instance, home), state = await readState(dir);
  const result: LocalStatus = { instance, kind, status: state?.status ?? "absent", endpoint: state?.endpoint, logPath: join(dir, "output.log") };
  if (!state || ["stopped", "failed"].includes(state.status)) return result;
  try { const owned = await control(state, "status"); return { ...result, ...owned, apiReady: await ready(state.endpoint, kind) }; }
  catch { return { ...result, status: "unreachable", apiReady: false }; }
}
async function assertPortFree(endpoint: string) {
  const url = new URL(endpoint);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Local managed services must use a loopback endpoint.");
  await new Promise<void>((resolve, reject) => {
    const server = createNetServer(); server.once("error", () => reject(new Error("Local service port is already in use. Choose another --port.")));
    server.listen(Number(url.port), url.hostname === "[::1]" ? "::1" : url.hostname, () => server.close(() => resolve()));
  });
}
export async function startLocal(spec: LaunchSpec): Promise<LocalStatus> {
  if (process.platform === "win32") throw new Error("Detached local service management currently requires Unix. Run stationd directly on Windows.");
  const dir = directory(spec.kind, spec.instance, spec.home), lock = join(dir, "lock");
  await privateDirectory(spec.home ?? defaultHome()); await privateDirectory(join(spec.home ?? defaultHome(), "processes")); await privateDirectory(dir);
  const previous = await localStatus(spec.kind, spec.instance, spec.home);
  if (previous.status === "running") {
    if ((await readState(dir))?.fingerprint !== fingerprint(spec)) throw new Error("Instance already runs on a different launch configuration. Stop it before changing configuration.");
    return previous;
  }
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("Instance is starting or its controller is unreachable. Inspect status and logs; stale PIDs are never signalled."); }
  let launched = false;
  try {
    await assertPortFree(spec.endpoint);
    const token = randomBytes(32).toString("hex");
    await writePrivate(join(dir, "launch.json"), spec);
    await writePrivate(join(dir, "state.json"), { token, fingerprint: fingerprint(spec), endpoint: spec.endpoint, status: "starting", startedAt: new Date().toISOString() });
    const log = await open(join(dir, "output.log"), "a", 0o600);
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./supervisor.js", import.meta.url)), dir], { detached: true, stdio: ["ignore", log.fd, log.fd] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref(); launched = true;
    } finally { await log.close(); }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const status = await localStatus(spec.kind, spec.instance, spec.home);
      if (status.status === "running" && status.apiReady) return status;
      if (["failed", "stopped"].includes(status.status)) throw new Error(`Service exited during startup. Inspect ${status.logPath}.`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("Service started but did not become ready within 20 seconds. It remains independently managed; inspect daemon/dashboard status and logs.");
  } finally { if (!launched) await rm(lock, { recursive: true, force: true }); }
}
export async function stopLocal(kind: LaunchSpec["kind"], instance: string, home = defaultHome()): Promise<LocalStatus> {
  const dir = directory(kind, instance, home), state = await readState(dir);
  if (!state || ["stopped", "failed"].includes(state.status)) return localStatus(kind, instance, home);
  try { await control(state, "stop"); }
  catch { throw new Error("Cannot authenticate the instance controller. No process was signalled; inspect local state and logs."); }
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const status = await localStatus(kind, instance, home);
    if (["stopped", "failed"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Graceful stop is still pending; inspect local status.");
}
/** Dedicated detached owner: it alone holds the child handle and receives authenticated stop requests. */
export async function supervise(dir: string) {
  const spec: LaunchSpec = JSON.parse(await readFile(join(dir, "launch.json"), "utf8"));
  const state = await readState(dir); if (!state) throw new Error("Missing launch state.");
  await rm(join(dir, "launch.json"), { force: true });
  let child: ChildProcess | undefined; let stopping = false; let exited = false;
  let persistence: Promise<void> = Promise.resolve();
  const save = () => { const snapshot = structuredClone(state); persistence = persistence.then(() => writePrivate(join(dir, "state.json"), snapshot)); return persistence; };
  const server = createHttpServer((req, res) => {
    const expected = Buffer.from(`Bearer ${state.token}`), supplied = Buffer.from(req.headers.authorization ?? "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) { res.writeHead(401).end(); return; }
    if (req.url === "/status" && req.method === "GET") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: state.status, pid: child?.pid })); return; }
    if (req.url === "/stop" && req.method === "POST") { res.end(JSON.stringify({ status: "stopping" })); stop(); return; }
    res.writeHead(404).end();
  });
  const signalGroup = (signal: NodeJS.Signals) => { if (child?.pid && !exited) { try { process.kill(-child.pid, signal); } catch { /* Process exited between checks. */ } } };
  const stop = () => {
    if (stopping) return; stopping = true; signalGroup("SIGTERM");
    const timer = setTimeout(() => signalGroup("SIGKILL"), 8_000); timer.unref();
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Control endpoint unavailable.");
  state.controlPort = address.port;
  const finish = async (code: number | null) => {
    if (exited) return; exited = true;
    state.status = stopping || code === 0 ? "stopped" : "failed"; state.exitCode = code;
    await save();
    await rm(join(dir, "lock"), { recursive: true, force: true });
    server.close();
  };
  child = spawn(process.execPath, [spec.entrypoint, ...spec.args], { cwd: spec.cwd, env: { ...process.env, ...spec.env }, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  child.once("error", () => { void finish(1); });
  child.once("exit", (code) => { void finish(code); });
  await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
  if (!exited) { state.pid = child.pid; state.status = "running"; await save(); }
}
