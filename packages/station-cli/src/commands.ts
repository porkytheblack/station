import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { StationClient, type ExecutionRequest } from "station-client";
import { ContextStore, defaultHome } from "./store.js";
import { localStatus, startLocal, stopLocal } from "./lifecycle.js";
import { tui } from "./tui.js";
export const HELP = `Station 3 — client for local and remote daemons

station context add NAME --url URL [--token-stdin] [--identity ID] [--tenant]
station context use NAME | context ls | context remove NAME
station init DIRECTORY [--role standalone|headquarters|station]
station daemon start [--instance local] [--config FILE] [--port 4400]
station daemon status|stop|logs [--instance local]
station dashboard start [--instance local] [--port 4401] [--context NAME]
station dashboard status|stop|logs [--instance local]
station status | ps | signals | broadcasts | beacons | runs
station signal run NAME [--input JSON|@FILE]
station broadcast run NAME [--input JSON|@FILE]
station beacon get|create|start|stop|restart NAME [--id ID] [--json JSON|@FILE]
station sandbox METHOD [ID] --station ID [--json JSON|@FILE]
station sandbox exec ID --station ID --command 'git status'
station browser METHOD [ID] --station ID [--json JSON|@FILE]
station browser execute ID --station ID --json '{"command":{"op":"pages"}}'
station images list | images inspect REFERENCE
station images pull|install REFERENCE
station images run REFERENCE EXPORT [--input JSON|@FILE] [--station ID]
station images publish MANIFEST --artifacts-dir DIRECTORY
station images tag NAME --tag TAG --digest SHA256
station api METHOD /PATH [--json JSON|@FILE]
station events | tui

All remote commands accept --context NAME. API paths are relative to /api/v1.
JSON may be '-' to read stdin. All execution methods use the daemon's own
validation and authorization; tenant contexts use its restricted gateway.
No command implicitly starts a daemon. Install station-daemon or
station-dashboard separately to manage local services. Local service
management is Unix-only. Browser and sandbox work stays on --station.
`;
export interface ParsedArgs { words: string[]; flags: Record<string, string | true> }
const booleans = new Set(["help", "token-stdin", "tenant", "follow"]);
export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { words: [], flags: Object.create(null) };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h") { result.flags.help = true; continue; }
    if (!arg.startsWith("--")) { result.words.push(arg); continue; }
    const [key, ...rest] = arg.slice(2).split("=");
    if (!["help", "token-stdin", "tenant", "follow", "url", "identity", "role", "instance", "config", "port", "context", "json", "input", "station", "id", "command", "artifacts-dir", "tag", "digest"].includes(key)) throw new Error(`Unknown option --${key}.`);
    if (Object.hasOwn(result.flags, key)) throw new Error(`Duplicate --${key}.`);
    if (booleans.has(key)) { if (rest.length) throw new Error(`--${key} does not take a value.`); result.flags[key] = true; }
    else { const value = rest.length ? rest.join("=") : args[++i]; if (!value || value.startsWith("--")) throw new Error(`--${key} needs a value.`); result.flags[key] = value; }
  }
  return result;
}
function value(args: ParsedArgs, key: string) { const v = args.flags[key]; return typeof v === "string" ? v : undefined; }
function required(input: string | undefined, label: string) { if (!input) throw new Error(`Missing ${label}.`); return input; }
export async function stdinText(limit = 64 * 1024): Promise<string> {
  let output = "";
  for await (const chunk of process.stdin) { output += String(chunk); if (Buffer.byteLength(output) > limit) throw new Error("Standard input exceeds the size limit."); }
  return output;
}
async function jsonInput(raw: string | undefined): Promise<Record<string, unknown>> {
  if (raw === undefined) return {};
  const text = raw === "-" ? await stdinText(8 * 1024 * 1024) : raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
  let body: unknown; try { body = JSON.parse(text); } catch { throw new Error("Expected JSON or @path to a JSON file."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
  return body as Record<string, unknown>;
}
const output = (result: unknown) => process.stdout.write(JSON.stringify(result, null, 2) + "\n");
function entrypoint(name: "station-daemon" | "station-dashboard") {
  for (const root of [join(process.cwd(), "package.json"), import.meta.url]) {
    try { return createRequire(root).resolve(`${name}/cli`); } catch { /* Try CLI installation next. */ }
  }
  throw new Error(`Install ${name}@^3 separately in this project or alongside station-runtime-cli before starting it.`);
}
function portFlag(args: ParsedArgs, fallback: number) {
  const port = Number(value(args, "port") ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be between 1 and 65535.");
  return port;
}
async function selectedClient(store: ContextStore, args: ParsedArgs) {
  const selected = await store.resolve(value(args, "context")); const client = new StationClient(selected.connection);
  await client.connect(); return { client, selected };
}
export async function run(args: ParsedArgs, store = new ContextStore()) {
  const [command, action, resource] = args.words;
  if (!command || args.flags.help) { process.stdout.write(HELP); return; }
  if (command === "context") {
    if (action === "ls" || action === "list") { output(await store.list()); return; }
    if (action === "use") { await store.use(required(resource, "context name")); output({ active: resource }); return; }
    if (action === "remove") { await store.remove(required(resource, "context name")); output({ removed: resource }); return; }
    if (action === "add") {
      const token = args.flags["token-stdin"] ? (await stdinText()).trim() : undefined;
      if (args.flags["token-stdin"] && !token) throw new Error("No API token received on stdin.");
      await store.add(required(resource, "context name"), { url: required(value(args, "url"), "--url"), token, stationId: value(args, "identity"), tenant: Boolean(args.flags.tenant) });
      output({ saved: resource }); return;
    }
    throw new Error("Use context add, use, ls or remove.");
  }
  if (command === "init") {
    const dir = resolve(required(action, "configuration directory")); const role = value(args, "role") ?? "standalone";
    if (!["standalone", "headquarters", "station"].includes(role)) throw new Error("Invalid --role.");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "station.config.ts");
    await writeFile(file, `import { defineConfig } from "station-daemon";\n\n// Network roles also require shared durable adapters and membership configuration.\nexport default defineConfig({\n  role: ${JSON.stringify(role)},\n  host: "127.0.0.1",\n  port: 4400,\n  signalsDir: "./signals",\n  // Configure authentication before exposing this API beyond loopback.\n});\n`, { flag: "wx", mode: 0o600 });
    await mkdir(join(dir, "signals"), { recursive: true }); output({ config: file, note: role === "standalone" ? "Install station-daemon to run this configuration." : "Configure shared durable adapters and network identity before starting this network role." }); return;
  }
  if (command === "daemon" || command === "dashboard" || command === "up") {
    const kind = command === "dashboard" ? "dashboard" : "daemon", operation = command === "up" ? "start" : action;
    const instance = value(args, "instance") ?? "local", home = store.home;
    if (operation === "status") { output(await localStatus(kind, instance, home)); return; }
    if (operation === "stop") { output(await stopLocal(kind, instance, home)); return; }
    if (operation === "logs") {
      const status = await localStatus(kind, instance, home);
      if (args.flags.follow) throw new Error(`Streaming log follow is not implemented; use your log viewer on ${status.logPath}.`);
      process.stdout.write(await readFile(status.logPath, "utf8")); return;
    }
    if (operation !== "start") throw new Error("Use start, status, stop or logs.");
    const port = portFlag(args, kind === "daemon" ? 4400 : 4401), endpoint = `http://127.0.0.1:${port}`;
    const env: Record<string, string> = {};
    let launchArgs: string[] = [];
    if (kind === "daemon") {
      const config = value(args, "config");
      launchArgs = ["--host", "127.0.0.1", "--port", String(port), ...(config ? ["--config", resolve(config)] : [])];
    } else {
      const { selected } = await selectedClient(store, args);
      env.STATION_DAEMON_URL = selected.connection.url; env.PORT = String(port); env.HOSTNAME = "127.0.0.1";
      // The dashboard has its own daemon login. Never inject a CLI token into web assets.
    }
    output(await startLocal({ kind, instance, entrypoint: entrypoint(kind === "daemon" ? "station-daemon" : "station-dashboard"), args: launchArgs, cwd: process.cwd(), endpoint, env, home })); return;
  }
  const { client, selected } = await selectedClient(store, args);
  if (command === "tui") { await tui(client, selected.name); return; }
  if (command === "events") {
    const controller = new AbortController(), stop = () => controller.abort(); process.once("SIGINT", stop);
    try { for await (const event of client.events(controller.signal)) output(event); }
    finally { process.removeListener("SIGINT", stop); } return;
  }
  if (command === "status") { output({ context: selected.name, info: await client.connect(), health: await client.health() }); return; }
  if (command === "ps") { output(await client.request("GET", "/stations")); return; }
  if (["signals", "broadcasts", "beacons", "runs"].includes(command)) { output(await client.request("GET", `/${command}`)); return; }
  if (command === "images" || command === "image") {
    if (value(args, "station") && action !== "run") throw new Error("Select the target registry through a saved context; Headquarters registry proxying is not available yet.");
    if (action === "pull" || action === "install") {
      output(await client.request("POST", `/registry/${action}`, { reference: required(resource, "image reference") })); return;
    }
    if (action === "run") {
      output(await client.request("POST", "/registry/run", { reference: required(resource, "image reference"), export: required(args.words[3], "export name"), input: await jsonInput(value(args, "input")), ...(value(args, "station") ? { stationId: value(args, "station") } : {}) })); return;
    }
    if (action === "list" || action === "ls") { output(await client.request("GET", "/registry/images")); return; }
    if (action === "inspect") { output(await client.request("GET", `/registry/resolve?ref=${encodeURIComponent(required(resource, "image reference"))}`)); return; }
    if (action === "tag") {
      output(await client.request("PUT", "/registry/tags", { name: required(resource, "image name"), tag: required(value(args, "tag"), "--tag"), digest: required(value(args, "digest"), "--digest") })); return;
    }
    if (action === "publish") {
      const manifest = await jsonInput("@" + required(resource, "manifest path"));
      const directory = resolve(required(value(args, "artifacts-dir"), "--artifacts-dir"));
      if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error("Manifest must declare artifacts.");
      const blobs: { digest: string; bytes: Uint8Array }[] = [];
      let total = 0;
      for (const artifact of manifest.artifacts as { entrypoint: string; digest: string; size: number }[]) {
        if (!artifact || typeof artifact.entrypoint !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(artifact.entrypoint)) throw new Error("Artifact entrypoint must be a basename.");
        const path = join(directory, artifact.entrypoint), file = await stat(path);
        total += file.size;
        if (!file.isFile() || file.size > 128 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error("Artifact exceeds CLI upload limits (128 MiB per file, 256 MiB total).");
        const bytes = await readFile(path), digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        if (digest !== artifact.digest || bytes.byteLength !== artifact.size) throw new Error("Artifact size or digest does not match its manifest. No artifact was uploaded.");
        blobs.push({ digest, bytes });
      }
      for (const blob of blobs) await client.putBlob(blob.digest, blob.bytes);
      output(await client.request("POST", "/registry/images", manifest)); return;
    }
    throw new Error("Use images list, inspect, publish, tag, pull, install or run. The target daemon must enable the requested registry capability.");
  }
  if (command === "api") {
    const method = required(action, "HTTP method").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported HTTP method.");
    output(await client.request(method, required(resource, "API path"), value(args, "json") === undefined ? undefined : await jsonInput(value(args, "json")))); return;
  }
  if (command === "signal" || command === "broadcast") {
    const name = required(resource, "definition name");
    if (value(args, "station")) throw new Error("This API does not support station pinning for registered code definitions yet. The target was not ignored.");
    if (action === "get") { output(await client.request("GET", `/${command}s/${encodeURIComponent(name)}`)); return; }
    if (action !== "run") throw new Error("Use run or get.");
    const input = await jsonInput(value(args, "input"));
    output(command === "signal" ? await client.triggerSignal(name, input) : await client.triggerBroadcast(name, input)); return;
  }
  if (command === "beacon") {
    if (value(args, "station")) throw new Error("Beacon placement must be set in its instance configuration; --station is not supported by this route.");
    const name = encodeURIComponent(required(resource, "beacon name")), id = value(args, "id");
    const base = `/beacons/${name}${id ? `/instances/${encodeURIComponent(id)}` : ""}`;
    if (action === "get") output(await client.request("GET", base));
    else if (action === "create") output(await client.request("POST", `/beacons/${name}/instances`, await jsonInput(value(args, "json"))));
    else if (["start", "stop", "restart"].includes(action)) output(await client.request("POST", `${base}/${action}`, await jsonInput(value(args, "json"))));
    else throw new Error("Use beacon get, create, start, stop or restart.");
    return;
  }
  if (command === "sandbox" || command === "browser") {
    if (action === "stations") { output(await client.executionStations()); return; }
    const station = required(value(args, "station"), "--station owner ID");
    const input = await jsonInput(value(args, "json"));
    if ("method" in input || "id" in input) throw new Error("Pass method and resource ID as positional arguments, not JSON fields.");
    const request: ExecutionRequest = { ...input, method: required(action, "execution method"), ...(resource ? { id: resource } : {}) };
    if (value(args, "command")) request.command = value(args, "command");
    output(await client.execution(station, command, request)); return;
  }
  throw new Error(`Unknown command ${command}. Run station --help.`);
}
export { defaultHome };
