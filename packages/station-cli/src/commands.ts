import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createRequire } from "node:module";
import { StationClient, type ExecutionRequest } from "station-client";
import { ContextStore, defaultHome } from "./store.js";
import { localStatus, startLocal, stopLocal } from "./lifecycle.js";
import { tui } from "./tui.js";
import { readImage, packImage, boundedFile } from "./images.js";
import { followLog } from "./logs.js";
import { saveNewFile, downloadSandboxFile } from "./transfers.js";
import { attachTerminal, terminalSize } from "./terminal.js";
import { uploadImageArtifact } from "./uploads.js";
import { inviteWorker, joinWorker, leaveWorker, readEnrollmentFile } from "./enrollment.js";
import { waitSandboxCommand, commandExitCode, CommandWaitError } from "./command-wait.js";
export const HELP = `Station 3 — client for local and remote daemons

station context add NAME --url URL [--token-stdin] [--identity ID] [--tenant]
station context use NAME | context ls | context remove NAME
station network invite STATION_ID --out FILE [--ttl-ms 300000]
station network join --file INVITATION|- --out WORKER_CONFIG
station network members | network revoke STATION_ID
station network leave --file WORKER_CONFIG|-
station init DIRECTORY [--role standalone|headquarters|station]
station daemon start [--instance local] [--config FILE] [--port 4400]
station daemon status|stop|logs [--instance local] [--follow]
station dashboard start [--instance local] [--port 4401] [--context NAME]
station dashboard status|stop|logs [--instance local]
station status | ps | signals | broadcasts | beacons | runs
station signal run NAME [--input JSON|@FILE]
station broadcast run NAME [--input JSON|@FILE]
station beacon get|create|start|stop|restart NAME [--id ID] [--json JSON|@FILE]
station sandbox METHOD [ID] --station ID [--json JSON|@FILE]
station sandbox shell ID --station ID [--cwd PATH]
station sandbox attach ID --station ID --terminal TERMINAL_ID
station sandbox exec ID --station ID --command 'git status' [--wait] [--wait-timeout-ms 300000]
station browser METHOD [ID] --station ID [--json JSON|@FILE]
station browser execute ID --station ID --json '{"command":{"op":"pages"}}'
station images validate MANIFEST --artifacts-dir DIRECTORY
station images pack|build MANIFEST --artifacts-dir DIRECTORY --out DIRECTORY
station images list | images inspect REFERENCE
station images pull|install REFERENCE
station images run REFERENCE EXPORT [--input JSON|@FILE] [--station ID]
station images publish MANIFEST --artifacts-dir DIRECTORY
station images tag NAME --tag TAG --digest SHA256
station deployments list|inspect|stage|activate|rollback|drain|rollout|rollout-cancel|run [ID] [--json JSON|@FILE]
station sandbox upload ID --station ID --file LOCAL --path REMOTE [--parents]
station sandbox download ID --station ID --path REMOTE --out LOCAL
station browser upload ID --station ID --file LOCAL --selector CSS [--mime TYPE]
station browser download ID --station ID --artifact ID --out LOCAL
station browser screenshot ID --station ID --out LOCAL
station api METHOD /PATH [--json JSON|@FILE]
station events | tui

All commands accept --json-errors for stable JSON failures on stderr.
Sandbox exec --wait returns the final JSON result and remote exit code.
Its local wait timeout or Ctrl-C stops polling without cancelling remote work.
Use sandbox cancel ID --station OWNER --json '{"runId":"COMMAND_ID"}' to cancel.
Remote command deadlines use --json '{"timeoutMs":10000}'.
All remote commands accept --context NAME. API paths are relative to /api/v1.
JSON may be '-' to read stdin. All execution methods use the daemon's own
validation and authorization; tenant contexts use its restricted gateway.
No command implicitly starts a daemon. Install station-daemon or
station-dashboard separately to manage local services. Local service
management is Unix-only. Browser and sandbox work stays on --station.
`;
export interface ParsedArgs { words: string[]; flags: Record<string, string | true> }
const booleans = new Set(["help", "token-stdin", "tenant", "follow", "parents", "wait", "json-errors"]);
export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { words: [], flags: Object.create(null) };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h") { result.flags.help = true; continue; }
    if (!arg.startsWith("--")) { result.words.push(arg); continue; }
    const [key, ...rest] = arg.slice(2).split("=");
    if (!["help", "token-stdin", "tenant", "follow", "url", "identity", "role", "instance", "config", "port", "context", "json", "input", "station", "id", "command", "artifacts-dir", "tag", "digest", "out", "file", "path", "selector", "mime", "artifact", "control-token", "parents", "terminal", "cwd", "ttl-ms", "wait", "wait-timeout-ms", "json-errors"].includes(key)) throw new Error(`Unknown option --${key}.`);
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
  if ((args.flags.wait || args.flags["wait-timeout-ms"]) && (command !== "sandbox" || action !== "exec" || !args.flags.wait)) throw new Error("--wait and --wait-timeout-ms require sandbox exec --wait.");
  const waitTimeout = Number(value(args, "wait-timeout-ms") ?? 300000);
  if (args.flags.wait && (!Number.isSafeInteger(waitTimeout) || waitTimeout < 1 || waitTimeout > 86400000)) throw new Error("--wait-timeout-ms must be between 1 and 86400000.");
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
      const controller = new AbortController(), stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try { for await (const chunk of followLog(status.logPath, { signal: controller.signal, follow: Boolean(args.flags.follow) })) {
        if (!process.stdout.write(chunk)) await new Promise<void>(resolve => process.stdout.once("drain", resolve));
      } } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
      return;
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
      env.STATION_DAEMON_URL = selected.connection.url; env.PORT = String(port); env.STATION_DASHBOARD_HOST = "127.0.0.1";
      // The dashboard has its own daemon login. Never inject a CLI token into web assets.
    }
    output(await startLocal({ kind, instance, entrypoint: entrypoint(kind === "daemon" ? "station-daemon" : "station-dashboard"), args: launchArgs, cwd: process.cwd(), endpoint, env, home })); return;
  }
  if ((command === "images" || command === "image") && ["build", "pack", "validate"].includes(action)) {
    if (value(args, "station")) throw new Error("Local image preparation does not select an execution station.");
    const manifest = required(resource, "manifest path"), artifacts = required(value(args, "artifacts-dir"), "--artifacts-dir");
    if (action === "validate") { const result = await readImage(manifest, artifacts); output({ valid: true, digest: result.digest, name: result.manifest.name, version: result.manifest.version }); }
    else output(await packImage(manifest, artifacts, required(value(args, "out"), "--out"), action === "build"));
    return;
  }
  if (command === "network" && ["join", "leave"].includes(action)) {
    if (value(args, "context") || value(args, "url") || value(args, "station") || args.flags.tenant) throw new Error("Worker enrollment uses only the fixed authority and identity in its private input file.");
    const path = required(value(args, "file"), "--file (or --file - for stdin)"), text = path === "-" ? await stdinText() : await readEnrollmentFile(path);
    output(action === "join" ? await joinWorker(text, required(value(args, "out"), "--out")) : await leaveWorker(text)); return;
  }
  const { client, selected } = await selectedClient(store, args);
  if (command === "network") {
    if (client.connection.tenant) throw new Error("Network administration requires an operator context.");
    if (action === "invite") { output(await inviteWorker(client, required(resource, "station identity"), required(value(args, "out"), "--out"), value(args, "ttl-ms") === undefined ? undefined : Number(value(args, "ttl-ms")))); return; }
    if (action === "members") { output(await client.request("GET", "/network/members")); return; }
    if (action === "revoke") { await client.request("DELETE", `/network/members/${encodeURIComponent(required(resource, "station identity"))}`); output({ revoked: resource }); return; }
    throw new Error("Use network invite, join, members, revoke or leave.");
  }
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
    const targetStation = value(args, "station");
    const registry = client.registryPath(action === "run" ? undefined : targetStation);
    if (action === "pull" || action === "install") {
      output(await client.request("POST", `${registry}/${action}`, { reference: required(resource, "image reference") })); return;
    }
    if (action === "run") {
      output(await client.request("POST", `${client.registryPath()}/run`, { reference: required(resource, "image reference"), export: required(args.words[3], "export name"), input: await jsonInput(value(args, "input")), ...(value(args, "station") ? { stationId: value(args, "station") } : {}) })); return;
    }
    if (action === "list" || action === "ls") { output(await client.request("GET", `${registry}/images`)); return; }
    if (action === "inspect") { output(await client.request("GET", `${registry}/resolve?ref=${encodeURIComponent(required(resource, "image reference"))}`)); return; }
    if (action === "tag") {
      output(await client.request("PUT", `${registry}/tags`, { name: required(resource, "image name"), tag: required(value(args, "tag"), "--tag"), digest: required(value(args, "digest"), "--digest") })); return;
    }
    if (action === "publish") {
      const image = await readImage(required(resource, "manifest path"), required(value(args, "artifacts-dir"), "--artifacts-dir"));
      for (const artifact of image.manifest.artifacts) await uploadImageArtifact(client, artifact.digest, image.blobs.get(artifact.entrypoint)!, { home: store.home, stationId: targetStation });
      output(await client.request("POST", `${registry}/images`, image.manifest)); return;
    }
    throw new Error("Use images list, inspect, publish, tag, pull, install or run. The target daemon must enable the requested registry capability.");
  }
  if (command === "deployments" || command === "deployment") {
    const targetStation = value(args, "station");
    const base = `${client.registryPath(targetStation)}/deployments`;
    if (action === "list") output(await client.request("GET", base));
    else if (action === "inspect") output(await client.request("GET", `${base}/${encodeURIComponent(required(resource, "deployment id"))}`));
    else if (action === "stage") output(await client.request("POST", base, await jsonInput(value(args, "json"))));
    else if (action === "rollout-cancel") {
      const body=await jsonInput(value(args,"json"));
      if(!body||typeof body!=="object"||Array.isArray(body)||typeof body.rolloutId!=="string"||!Number.isSafeInteger(body.expectedRevision)||Object.keys(body).some(k=>!["rolloutId","expectedRevision"].includes(k)))throw new Error("rollout-cancel requires rolloutId and expectedRevision JSON fields.");
      output(await client.request("POST",`${base}/${encodeURIComponent(required(resource,"deployment id"))}/rollouts/${encodeURIComponent(body.rolloutId)}/cancel`,{expectedRevision:body.expectedRevision}));
    }
    else if (["activate", "rollback", "drain", "rollout", "run"].includes(action)) output(await client.request("POST", `${base}/${encodeURIComponent(required(resource, "deployment id"))}/${action}`, await jsonInput(value(args, "json"))));
    else throw new Error("Use deployments list, inspect, stage, activate, rollback, drain, rollout, rollout-cancel or run.");
    return;
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
    if (command === "sandbox" && ["shell", "attach"].includes(action)) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Terminal attachment requires an interactive TTY.");
      const sandbox = required(resource, "sandbox id");
      const terminal = action === "shell"
        ? (await client.execution<{ id: string }>(station, "sandbox", { method: "openTerminal", id: sandbox, options: { ...terminalSize(), ...(value(args, "cwd") ? { cwd: value(args, "cwd") } : {}) } })).id
        : required(value(args, "terminal"), "--terminal");
      process.stderr.write(`Terminal ${terminal}; Ctrl-] detaches, Ctrl-C interrupts the remote command.\n`);
      const result = await attachTerminal(client, station, sandbox, terminal);
      process.stderr.write(`\n${result.detached ? "Detached; terminal remains managed by the worker." : `Terminal ${result.status} (exit ${result.exitCode}).`}\n`);
      return;
    }
    const token = value(args, "control-token");
    if (action === "upload") {
      const id = required(resource, "resource id"), path = required(value(args, "file"), "--file");
      const bytes = await boundedFile(path, 4 * 1024 * 1024);
      output(command === "sandbox"
        ? await client.sandboxWriteFile(station, id, required(value(args, "path"), "--path"), bytes, { createParents: Boolean(args.flags.parents) })
        : await client.browserUpload(station, id, { selector: required(value(args, "selector"), "--selector") }, [{ name: basename(path), mimeType: value(args, "mime") ?? "application/octet-stream", bytes }], token));
      return;
    }
    if (action === "download") {
      const id = required(resource, "resource id"), destination = resolve(required(value(args, "out"), "--out"));
      output(command === "sandbox"
        ? await downloadSandboxFile(client, station, id, required(value(args, "path"), "--path"), destination)
        : await saveNewFile(destination, (await client.browserReadDownload(station, id, required(value(args, "artifact"), "--artifact"))).data));
      return;
    }
    if (command === "browser" && action === "screenshot") {
      output(await saveNewFile(resolve(required(value(args, "out"), "--out")), await client.browserScreenshot(station, required(resource, "session id"), token))); return;
    }
    const input = await jsonInput(value(args, "json"));
    if (token) input.controlToken = token;
    if ("method" in input || "id" in input) throw new Error("Pass method and resource ID as positional arguments, not JSON fields.");
    const request: ExecutionRequest = { ...input, method: required(action, "execution method"), ...(resource ? { id: resource } : {}) };
    if (value(args, "command")) request.command = value(args, "command");
    if (command === "sandbox" && action === "exec" && args.flags.wait) {
      const id = required(resource, "sandbox id"), controller = new AbortController();
      const interrupt = () => controller.abort(); process.on("SIGINT", interrupt);
      try {
        let initial: unknown;
        try { initial = await client.execution(station, "sandbox", request, controller.signal); }
        catch (error) { if (controller.signal.aborted) throw new CommandWaitError("wait_interrupted", 130); throw error; }
        const result = await waitSandboxCommand(client, station, id, initial, { timeoutMs: waitTimeout, signal: controller.signal });
        output(result); process.exitCode = commandExitCode(result);
      } catch (error) { if (error instanceof CommandWaitError && error.lastResult) output(error.lastResult); throw error; }
      finally { process.removeListener("SIGINT", interrupt); }
      return;
    }
    output(await client.execution(station, command, request)); return;
  }
  throw new Error(`Unknown command ${command}. Run station --help.`);
}
export { defaultHome };
