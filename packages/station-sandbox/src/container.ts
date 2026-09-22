import { prepareContainerSeccomp, type ContainerSeccompPolicy } from "./container-seccomp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, posix } from "node:path";
import { createRequire } from "node:module";
import { acquireHostRoot } from "./host-lock.js";
import type { FileEntry, FileList, FileRead, SandboxService, ServiceInput, TerminalInput, TerminalSession, TerminalOutput } from "./advanced.js";
import { StringDecoder } from "node:string_decoder";
import { SandboxError, type Sandbox, type SandboxAdapter, type CommandInput, type CommandRun } from "./index.js";
import { engineCall, FILE_SCRIPT, STOP_SCRIPT } from "./container-engine.js";

export interface ContainerSandboxOptions {
  rootDir: string;
  /** Verify persistent tenant ownership before any reconciliation or service restart. */
  tenantId?: string;
  /** Operator-controlled Linux image with Node, Bash, setsid and /home/node owned by user. */
  image: string;
  engine?: "docker" | "podman";
  executable?: string;
  /** Operator-reviewed deny-default JSON profile; required when engine default is unconfined. */
  seccompProfile?: string;
  /** none (default), bridge, or an operator-created network name. */
  network?: string;
  /** Operator attests a named network enforces tenant-safe egress; not a firewall implementation. */
  networkRestricted?: boolean;
  user?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  maxEnvironments?: number;
  maxConcurrent?: number;
  maxTimeoutMs?: number;
  maxOutputBytes?: number;
  maxHistoryPerSandbox?: number;
  maxServicesPerSandbox?: number;
  maxTerminalsPerSandbox?: number;
  /** Auto-detect on Node by default. true requires node-pty; Bun controllers are unsupported. */
  enablePty?: boolean;
  env?: Record<string, string>;
}
interface Workspace extends Sandbox { seccomp: string; container: string; volume: string; image: string; unavailable?: boolean }
interface ServiceState { meta: SandboxService; desired: boolean; runId?: string; timer?: ReturnType<typeof setTimeout> }
interface TerminalState { meta: TerminalSession; process?: import("node-pty").IPty; data: Buffer; startOffset: number; nextOffset: number; done: Promise<void> }
interface Active { run: CommandRun; child: ChildProcess; done: Promise<void>; finish(): void; stop(status: CommandRun["status"]): Promise<void>; }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OWNER = "station.sandbox.owner";
const ID = "station.sandbox.id";
const fail = (code: string, message: string): never => { throw new SandboxError(code, message); };
const number = (input: number | undefined, fallback: number, max = 2_147_483_647) => {
  const value = input ?? fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail("invalid_input", "Container limits must be positive bounded integers.");
  return value;
};
const JOB = `printf 'station-session:%s\\n' "$$"; cd -- "$2" || exit 127; exec /bin/bash --noprofile --norc -c "$3"`;


/** Linux container isolation on an operator-managed engine. No host-process fallback. */
export class ContainerSandboxAdapter implements SandboxAdapter {
  readonly name: string;
  readonly capabilities: { filesystem: true; commands: true; isolated: true; pty: boolean; networkRestricted: boolean; files: true; services: true } = { filesystem: true, commands: true, isolated: true, pty: false, networkRestricted: false, files: true, services: true };
  private pty?: typeof import("node-pty");
  private readonly serviceStates = new Map<string, ServiceState>();
  private readonly terminalStates = new Map<string, TerminalState>();
  private readonly unlock: () => void;
  private readonly root: string;
  private readonly executable: string;
  private readonly owner: string;
  private readonly lockToken = randomUUID();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly active = new Map<string, Active>();
  private readonly maxEnvironments: number;
  private readonly maxConcurrent: number;
  private readonly maxTimeout: number;
  private readonly maxOutput: number;
  private readonly maxHistory: number;
  private readonly memory: number;
  private readonly pids: number;
  private readonly cpus: number;
  private readonly user: string;
  private readonly initialized: Promise<void>;
  private seccomp!: ContainerSeccompPolicy;
  private creating = 0;
  private readonly creations = new Set<Promise<Sandbox>>();
  private closed = false;
  private broken = false;
  private readonly leaders = new Map<string, number>();
  private readonly terminations = new Map<string, Promise<void>>();
  private readonly recoveries = new Map<string, Promise<void>>();
  private closing?: Promise<void>;

  constructor(private readonly options: ContainerSandboxOptions) {
    this.name = options.engine === "podman" ? "podman" : "docker";
    this.executable = options.executable ?? this.name;
    this.root = resolve(options.rootDir);
    if (!options.image || options.image.startsWith("-") || /[\0\r\n]/.test(options.image)) fail("invalid_input", "A valid operator image is required.");
    const network = options.network ?? "none";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network) || ["host", "default", "private", "slirp4netns", "pasta"].includes(network)) fail("invalid_input", "Use none, bridge, or an explicit operator network name.");
    if (options.networkRestricted !== undefined && typeof options.networkRestricted !== "boolean") fail("invalid_input", "Invalid network restriction assertion.");
    if (options.networkRestricted && ["none", "bridge"].includes(network)) fail("invalid_input", "Network restriction assertions apply only to named networks; none is already restricted.");
    this.capabilities.networkRestricted = network === "none" || options.networkRestricted === true;
    this.user = options.user ?? "1000:1000";
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/.test(this.user)) fail("invalid_input", "A numeric non-root UID and GID are required.");
    this.maxEnvironments = number(options.maxEnvironments, 8, 1000);
    this.maxConcurrent = number(options.maxConcurrent, 4, 1000);
    this.maxTimeout = number(options.maxTimeoutMs, 300_000);
    this.maxOutput = number(options.maxOutputBytes, 256 * 1024, 16 * 1024 * 1024);
    this.maxHistory = number(options.maxHistoryPerSandbox, 100, 10000);
    this.memory = number(options.memoryMb, 512, 1_048_576);
    this.pids = number(options.pidsLimit, 128, 1_000_000);
    this.cpus = options.cpus ?? 1;
    if (!Number.isFinite(this.cpus) || this.cpus <= 0 || this.cpus > 1024) fail("invalid_input", "cpus must be positive and bounded.");
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) fail("invalid_input", "Invalid container environment.");
    }
    number(options.maxServicesPerSandbox, 8, 1000);
    number(options.maxTerminalsPerSandbox, 4, 1000);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (options.enablePty && "Bun" in globalThis) fail("unsupported", "Container PTYs require a Node controller; Bun may still execute workload commands.");
    this.unlock = acquireHostRoot(this.root);
    if (options.enablePty !== false && !("Bun" in globalThis)) {
      try { this.pty = createRequire(import.meta.url)("node-pty"); this.capabilities.pty = true; }
      catch { if (options.enablePty) { this.releaseLock(); fail("unsupported", "Container PTYs require node-pty on a Node controller."); } }
    }
    try {
      const ownerPath = join(this.root, "owner.json");
      this.owner = existsSync(ownerPath) ? this.read(ownerPath).id : randomUUID();
      if (!uuid.test(this.owner)) fail("invalid_state", "Invalid container ownership record.");
      if (!existsSync(ownerPath)) this.write(ownerPath, { id: this.owner });
      this.bindTenantRoot(options.tenantId);
    } catch (error) { this.releaseLock(); throw error; }
    this.initialized = this.initialize().catch((error) => { this.broken = true; this.releaseLock(); throw error; });
    void this.initialized.catch(() => {});
  }
  ready() { return this.initialized; }
  private bindTenantRoot(tenantId?: string) {
    const path = join(this.root, "tenant.json");
    if (existsSync(path)) {
      if (this.read(path).tenantId !== tenantId) fail("invalid_state", "Container data is bound to a different tenant.");
    } else if (tenantId !== undefined) {
      if (readdirSync(this.root).some((id) => uuid.test(id))) fail("invalid_state", "Existing unbound workspaces cannot be assigned to a tenant; use a fresh root.");
      if (typeof tenantId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(tenantId)) fail("invalid_input", "Invalid tenant identifier.");
      this.write(path, { tenantId });
    }
  }
  async bindTenant(tenantId?: string) {
    if (this.options.tenantId !== tenantId) fail("invalid_state", "Container constructor and worker tenant identifiers must match.");
    this.bindTenantRoot(tenantId);
    await this.ready();
  }
  private releaseLock() { this.unlock(); }
  private read(path: string): any {
    try { if (statSync(path).size > this.maxOutput * 6 + 512 * 1024) fail("invalid_state", "Oversized container metadata."); return JSON.parse(readFileSync(path, "utf8")); }
    catch { return fail("invalid_state", "Unreadable container metadata."); }
  }
  private write(path: string, value: unknown) {
    try { const temporary = `${path}.${this.lockToken}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path); }
    catch { this.broken = true; fail("storage_error", "Container metadata could not be persisted."); }
  }
  private call(args: string[], input?: string) { return engineCall(this.executable, args, { input }); }
  private labels(workspace: Workspace) { return ["--label", `${OWNER}=${this.owner}`, "--label", `${ID}=${workspace.id}`]; }
  private async inspect(kind: "container" | "volume", name: string): Promise<any | null> {
    // An inspect failure is only absence if an independent inventory query confirms it.
    const names = (await this.call(kind === "container" ? ["ps", "-a", "--format", "{{.Names}}"] : ["volume", "ls", "--format", "{{.Name}}"])) .trim().split("\n");
    if (!names.includes(name)) return null;
    return JSON.parse(await this.call(kind === "container" ? ["inspect", name] : ["volume", "inspect", name]))[0];
  }
  private checkOwner(value: any, workspace: Workspace, volume = false) {
    const labels = volume ? value.Labels : value.Config?.Labels;
    if (labels?.[OWNER] !== this.owner || labels?.[ID] !== workspace.id) fail("invalid_state", "Container ownership does not match its metadata.");
  }
  private async initialize() {
    const info = JSON.parse(await this.call(["info", "--format", "json"]));
    if ((info.OSType ?? info.host?.os ?? info.Host?.OS) !== "linux") fail("unsupported", "A Linux container engine is required.");
    if ([info.MemoryLimit, info.CpuCfsQuota, info.PidsLimit].some((supported) => supported === false)) fail("unsupported", "The container engine cannot enforce the requested resource limits.");
    if (this.name === "podman" && Array.isArray(info.host?.cgroupControllers) && ["cpu", "memory", "pids"].some((controller) => !info.host.cgroupControllers.includes(controller))) fail("unsupported", "The container engine requires delegated CPU, memory and PID controllers.");
    try { this.seccomp = prepareContainerSeccomp(this.root, this.options.seccompProfile, info, this.name === "podman" ? "podman" : "docker"); }
    catch { fail("unsupported", "An enforced seccomp policy is required; use a reviewed deny-default seccompProfile when engine defaults are unconfined."); }
    await this.call(["image", "inspect", this.options.image]);
    for (const id of readdirSync(this.root)) {
      if (!uuid.test(id)) continue;
      const workspace = this.read(join(this.root, id, "workspace.json")) as Workspace;
      if (workspace.id !== id || workspace.backend !== this.name || workspace.container !== `station-${this.owner.slice(0, 12)}-${id}` || workspace.volume !== `station-data-${this.owner.slice(0, 12)}-${id}` || typeof workspace.image !== "string" || !workspace.image || workspace.image.startsWith("-") || !Number.isFinite(Date.parse(workspace.createdAt))) fail("invalid_state", "Invalid container workspace metadata.");
      this.workspaces.set(id, workspace);
      await this.provision(workspace, true);
      mkdirSync(join(this.root, id, "services"), { recursive: true, mode: 0o700 });
      mkdirSync(join(this.root, id, "terminals"), { recursive: true, mode: 0o700 });
      for (const filename of readdirSync(join(this.root, id, "runs"))) {
        if (!filename.endsWith(".json")) continue;
        const run = this.readRun(id, filename.slice(0, -5));
        if (run.status === "running") this.writeRun({ ...run, status: "interrupted", finishedAt: new Date().toISOString() });
      }
      for (const filename of readdirSync(join(this.root, id, "services"))) {
        if (!filename.endsWith(".json")) continue;
        const saved = this.read(join(this.root, id, "services", filename));
        if (!uuid.test(saved.meta?.id) || saved.meta.sandboxId !== id) fail("invalid_state", "Invalid service metadata.");
        if (saved.desired) saved.meta.status = "interrupted";
        this.serviceStates.set(saved.meta.id, { meta: saved.meta, desired: Boolean(saved.desired) });
      }
      for (const filename of readdirSync(join(this.root, id, "terminals"))) {
        if (!filename.endsWith(".json")) continue;
        const saved = this.read(join(this.root, id, "terminals", filename)) as TerminalOutput;
        if (!uuid.test(saved.id) || saved.sandboxId !== id) fail("invalid_state", "Invalid terminal metadata.");
        if (saved.status === "running") { saved.status = "interrupted"; saved.finishedAt = new Date().toISOString(); }
        const { data, startOffset, nextOffset, offset: _offset, truncated: _truncated, ...meta } = saved;
        if (typeof data !== "string" || !Number.isSafeInteger(startOffset) || !Number.isSafeInteger(nextOffset) || startOffset < 0 || nextOffset < startOffset) fail("invalid_state", "Invalid terminal output metadata.");
        if (Buffer.byteLength(data) !== nextOffset - startOffset) fail("invalid_state", "Invalid terminal byte offsets.");
        this.terminalStates.set(saved.id, { meta, data: Buffer.from(data), startOffset, nextOffset, done: Promise.resolve() });
      }
    }
    // Start after ready resolves so normal admission checks remain in force.
    queueMicrotask(() => { void this.initialized.then(async () => {
      for (const state of this.serviceStates.values()) if (state.desired && !this.closed) await this.launchService(state);
    }).catch(() => { this.broken = true; }); });
  }
  private async provision(workspace: Workspace, recovering = false) {
    if (workspace.seccomp !== this.seccomp.fingerprint) fail("invalid_state", "Workspace seccomp policy differs; explicit recreation or migration is required.");
    const volume = await this.inspect("volume", workspace.volume);
    if (volume) this.checkOwner(volume, workspace, true);
    else await this.call(["volume", "create", ...this.labels(workspace), workspace.volume]);
    const existing = await this.inspect("container", workspace.container);
    if (existing) {
      this.checkOwner(existing, workspace);
      if (existing.Config?.Labels?.["station.sandbox.seccomp"] !== this.seccomp.fingerprint || existing.HostConfig?.SecurityOpt?.some((option: string) => option === "seccomp=unconfined")) fail("invalid_state", "Container seccomp policy does not match the workspace.");
      const network = this.options.network ?? "none";
      const actualNetwork = existing.HostConfig?.NetworkMode;
      const namedMatch = !["none", "bridge"].includes(network) && Object.hasOwn(existing.NetworkSettings?.Networks ?? {}, network);
      if (actualNetwork !== network && !namedMatch) fail("invalid_state", "Container network differs from the configured policy; explicit migration is required.");
      if (recovering && existing.State?.Running) await this.call(["stop", "--time", "1", workspace.container]);
      await this.call(["start", workspace.container]);
    } else {
      const env = { ...this.options.env, HOME: "/home/node", NPM_CONFIG_PREFIX: "/home/node/.local", TMPDIR: "/tmp", PATH: "/home/node/workspace/node_modules/.bin:/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
      await this.call(["run", "-d", "--name", workspace.container, ...this.labels(workspace), "--user", this.user,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", ...(this.seccomp.path ? ["--security-opt", `seccomp=${this.seccomp.path}`] : []), "--label", `station.sandbox.seccomp=${this.seccomp.fingerprint}`, "--read-only", "--init",
        "--memory", `${this.memory}m`, "--cpus", String(this.cpus), "--pids-limit", String(this.pids),
        "--network", this.options.network ?? "none", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
        "--mount", `type=volume,source=${workspace.volume},target=/home/node`,
        ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        "--entrypoint", "/bin/bash", workspace.image, "--noprofile", "--norc", "-c", "exec /bin/sleep infinity"]);
    }
    await this.call(["exec", workspace.container, "/bin/bash", "-c", "test -x /usr/local/bin/node && test -x /usr/bin/setsid && /bin/mkdir -p /home/node/workspace /home/node/.local/bin"]);
    workspace.unavailable = false;
    this.write(join(this.root, workspace.id, "workspace.json"), workspace);
  }
  private async check(id: string, admission = false) {
    await this.initialized;
    if (this.closed || this.broken) fail("unavailable", "Container controller is unavailable.");
    const workspace = this.workspaces.get(id);
    if (!uuid.test(id) || !workspace) return fail("not_found", "Sandbox not found.");
    if (admission && workspace.unavailable && this.terminations.has(id)) {
      let recovery = this.recoveries.get(id);
      if (!recovery) {
        recovery = (async () => {
          await this.terminations.get(id);
          await Promise.all([...this.active.values()].filter((entry) => entry.run.sandboxId === id).map((entry) => entry.done));
          await Promise.all([...this.terminalStates.values()].filter((state) => state.meta.sandboxId === id).map((state) => state.done));
          if (this.closed) fail("unavailable", "Container controller is closed.");
          await this.provision(workspace);
          this.terminations.delete(id);
        })();
        this.recoveries.set(id, recovery);
        void recovery.finally(() => this.recoveries.delete(id)).catch(() => {});
      }
      await recovery;
    }
    if (admission && workspace.unavailable) fail("unavailable", "Workspace stopped for cancellation or containment. Restart its controller to reconcile it.");
    return workspace;
  }
  private public(workspace: Workspace): Sandbox { return { id: workspace.id, createdAt: workspace.createdAt, backend: workspace.backend }; }
  create(): Promise<Sandbox> {
    const operation = this.createWorkspace(); this.creations.add(operation);
    void operation.finally(() => this.creations.delete(operation)).catch(() => {}); return operation;
  }
  private async createWorkspace() {
    await this.initialized;
    if (this.closed || this.broken) fail("unavailable", "Container controller is unavailable.");
    if (this.workspaces.size + this.creating >= this.maxEnvironments) fail("capacity", "Workspace capacity reached.");
    this.creating++;
    const id = randomUUID();
    const workspace: Workspace = { id, seccomp: this.seccomp.fingerprint, backend: this.name, createdAt: new Date().toISOString(), image: this.options.image, container: `station-${this.owner.slice(0, 12)}-${id}`, volume: `station-data-${this.owner.slice(0, 12)}-${id}` };
    try {
      for (const directory of ["runs", "services", "terminals"]) mkdirSync(join(this.root, id, directory), { recursive: true, mode: 0o700 });
      this.write(join(this.root, id, "workspace.json"), workspace);
      await this.provision(workspace);
      this.workspaces.set(id, workspace);
      return this.public(workspace);
    } catch (error) {
      // Engine launch errors are local to this workspace. Remove only verified owned resources;
      // if cleanup is unavailable, retain a quarantined intent for explicit reconciliation.
      workspace.unavailable = true;
      this.workspaces.set(id, workspace);
      try { await this.destroy(id); }
      catch { this.write(join(this.root, id, "workspace.json"), workspace); }
      throw error;
    } finally { this.creating--; }
  }
  async list() { await this.initialized; return [...this.workspaces.values()].map((workspace) => this.public(workspace)); }
  async get(id: string) { return this.public(await this.check(id)); }
  async destroy(id: string) {
    const workspace = await this.check(id);
    if ([...this.active.values()].some(({ run }) => run.sandboxId === id) || [...this.terminalStates.values()].some((state) => state.meta.sandboxId === id && state.process) || [...this.serviceStates.values()].some((state) => state.meta.sandboxId === id && state.desired)) fail("busy", "Stop running work before deleting the workspace.");
    const container = await this.inspect("container", workspace.container);
    if (container) { this.checkOwner(container, workspace); await this.call(["rm", "-f", workspace.container]); }
    const volume = await this.inspect("volume", workspace.volume);
    if (volume) { this.checkOwner(volume, workspace, true); await this.call(["volume", "rm", workspace.volume]); }
    rmSync(join(this.root, id), { recursive: true }); this.workspaces.delete(id); this.terminations.delete(id); this.recoveries.delete(id);
    for (const [key, state] of this.serviceStates) if (state.meta.sandboxId === id) this.serviceStates.delete(key);
    for (const [key, state] of this.terminalStates) if (state.meta.sandboxId === id) this.terminalStates.delete(key);
  }
  private readRun(id: string, runId: string): CommandRun {
    if (!uuid.test(runId)) return fail("not_found", "Command not found.");
    const path = join(this.root, id, "runs", `${runId}.json`);
    if (!existsSync(path)) return fail("not_found", "Command not found.");
    const run = this.read(path) as CommandRun;
    if (run.id !== runId || run.sandboxId !== id || !["running", "completed", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status) || typeof run.stdout !== "string" || typeof run.stderr !== "string" || typeof run.truncated !== "boolean" || !Number.isFinite(Date.parse(run.startedAt)) || (run.status !== "running" && !Number.isFinite(Date.parse(run.finishedAt ?? "")))) fail("invalid_state", "Invalid command metadata.");
    return run;
  }
  private writeRun(run: CommandRun) { this.write(join(this.root, run.sandboxId, "runs", `${run.id}.json`), run); }
  private prune(id: string) {
    const completed = readdirSync(join(this.root, id, "runs")).filter((name) => name.endsWith(".json")).map((name) => this.readRun(id, name.slice(0, -5))).filter((run) => run.status !== "running").sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    for (const run of completed.slice(0, Math.max(0, completed.length - this.maxHistory))) rmSync(join(this.root, id, "runs", `${run.id}.json`));
  }
  private cwd(value?: string) {
    if (value !== undefined && (typeof value !== "string" || value.includes("\0") || posix.isAbsolute(value))) fail("invalid_input", "cwd must be relative to the workspace.");
    const path = posix.resolve("/home/node/workspace", value ?? ".");
    if (path !== "/home/node/workspace" && !path.startsWith("/home/node/workspace/")) fail("invalid_input", "cwd must be inside the workspace.");
    return path;
  }
  private terminateWorkspace(workspace: Workspace): Promise<void> {
    const existing = this.terminations.get(workspace.id);
    if (existing) return existing;
    workspace.unavailable = true;
    this.write(join(this.root, workspace.id, "workspace.json"), workspace);
    for (const entry of this.active.values()) if (entry.run.sandboxId === workspace.id && entry.run.status === "running") entry.run.status = "interrupted";
    for (const state of this.serviceStates.values()) if (state.meta.sandboxId === workspace.id) {
      clearTimeout(state.timer); state.timer = undefined; if (!this.closed) state.desired = false;
      state.meta.status = "interrupted"; this.saveService(state);
    }
    for (const state of this.terminalStates.values()) if (state.meta.sandboxId === workspace.id && state.meta.status === "running") {
      state.meta.status = "interrupted"; this.persistTerminal(state);
    }
    const operation = (async () => {
      const container = await this.inspect("container", workspace.container);
      if (container) {
        this.checkOwner(container, workspace);
        if (container.State?.Running) await this.call(["kill", workspace.container]);
        const stopped = await this.inspect("container", workspace.container);
        if (stopped?.State?.Running) fail("unavailable", "Workspace containment could not be verified.");
      }
    })();
    this.terminations.set(workspace.id, operation);
    return operation;
  }
  private async cleanup(workspace: Workspace, runId: string) {
    if (this.terminations.has(workspace.id)) return this.terminations.get(workspace.id);
    const leader = this.leaders.get(runId);
    this.leaders.delete(runId);
    // Session IDs come from a trusted wrapper before workload code starts, never guest files.
    try {
      if (!leader) throw new Error("No trusted session identity");
      await this.call(["exec", workspace.container, "/usr/local/bin/node", "-e", STOP_SCRIPT, String(leader)]);
    } catch { await this.terminateWorkspace(workspace); }
  }
  async exec(id: string, input: CommandInput): Promise<CommandRun> { return this.startCommand(id, input); }
  private async startCommand(id: string, input: CommandInput, service = false): Promise<CommandRun> {
    const workspace = await this.check(id, true);
    if (!input || typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0") || Buffer.byteLength(input.command) > 65_536) fail("invalid_input", "Invalid command.");
    const cwd = this.cwd(input.cwd);
    const timeout = number(input.timeoutMs, Math.min(this.maxTimeout, 30_000), this.maxTimeout);
    if (this.active.size >= this.maxConcurrent) fail("capacity", "Worker command capacity reached.");
    const run: CommandRun = { id: randomUUID(), sandboxId: id, status: "running", stdout: "", stderr: "", truncated: false, exitCode: null, startedAt: new Date().toISOString() };
    this.writeRun(run);
    const child = spawn(this.executable, ["exec", workspace.container, "/usr/bin/setsid", "--wait", "/bin/bash", "--noprofile", "--norc", "-p", "-c", JOB, "station-job", run.id, cwd, input.command], { stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    let dirty = false;
    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const append = (key: "stdout" | "stderr", chunk: Buffer) => {
      const retained = chunk.subarray(0, Math.max(0, this.maxOutput - bytes));
      bytes += retained.length;
      buffers[key] = Buffer.concat([buffers[key], retained]);
      const decoded = new StringDecoder("utf8").write(buffers[key]);
      run[key] = new StringDecoder("utf8").write(Buffer.from(decoded).subarray(0, buffers[key].length));
      dirty = true;
      if (retained.length < chunk.length) run.truncated = true;
    };
    let header = Buffer.alloc(0);
    let identified = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      if (identified) { append("stdout", chunk); return; }
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf(10);
      if (end < 0 && header.length <= 64) return;
      const match = end >= 0 && /^station-session:([1-9][0-9]*)$/.exec(header.subarray(0, end).toString("ascii"));
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 1) {
        void stop("interrupted").catch(() => { this.broken = true; }); return;
      }
      this.leaders.set(run.id, Number(match[1])); identified = true;
      append("stdout", header.subarray(end + 1)); header = Buffer.alloc(0);
    });
    child.stderr!.on("data", (chunk: Buffer) => append("stderr", chunk));
    let finish!: () => void;
    const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
    let stopping: Promise<void> | undefined;
    const stop = (status: CommandRun["status"]) => stopping ??= (async () => {
      if (run.status === "running") run.status = status;
      try { await this.terminateWorkspace(workspace); }
      finally { child.kill("SIGKILL"); }
    })();
    const entry: Active = { run, child, done, finish, stop };
    this.active.set(run.id, entry);
    const timer = service ? undefined : setTimeout(() => { void stop("timed_out").catch(() => { this.broken = true; }); }, timeout);
    const checkpoint = setInterval(() => {
      if (!dirty || run.status !== "running") return;
      dirty = false;
      try { this.writeRun(run); } catch { void stop("interrupted").catch(() => { this.broken = true; }); }
    }, 1000);
    child.on("error", () => { run.status = "failed"; });
    child.on("exit", () => { if (!stopping) stopping = this.cleanup(workspace, run.id).catch(() => { this.broken = true; }); });
    child.on("close", (code) => {
      void (async () => {
        clearTimeout(timer); clearInterval(checkpoint);
        await stopping;
        run.exitCode = code;
        if (run.status === "running") run.status = code === 0 ? "completed" : "failed";
        run.finishedAt = new Date().toISOString();
        try { this.writeRun(run); this.prune(id); } catch { this.broken = true; }
        this.leaders.delete(run.id); this.active.delete(run.id); finish();
      })().catch(() => { this.broken = true; this.active.delete(run.id); finish(); });
    });
    return { ...run };
  }
  async command(id: string, runId: string) { await this.check(id); return { ...(this.active.get(runId)?.run.sandboxId === id ? this.active.get(runId)!.run : this.readRun(id, runId)) }; }
  async cancel(id: string, runId: string) {
    await this.command(id, runId);
    const active = this.active.get(runId);
    if (active) { await active.stop("cancelled"); await active.done; }
    return this.command(id, runId);
  }
  private async file<T>(id: string, method: string, path: string, options: Record<string, unknown> = {}): Promise<T> {
    const workspace = await this.check(id, true);
    if (typeof path !== "string" || path.length > 4096) fail("invalid_input", "Invalid workspace path.");
    this.cwd(path);
    const result = JSON.parse(await engineCall(this.executable, ["exec", "-i", workspace.container, "/usr/local/bin/node", "-e", FILE_SCRIPT], { input: JSON.stringify({ method, path, ...options }), maxBytes: 8 * 1024 * 1024 }));
    if (result && Object.hasOwn(result, "data") && !Object.hasOwn(result, "error")) return result.data as T;
    const code = result?.error?.code;
    if (code === "not_found") return fail(code, "Workspace file was not found.");
    if (code === "invalid_input") return fail(code, "Invalid workspace file operation.");
    if (code === "capacity") return fail(code, "Workspace file capacity reached.");
    return fail("unavailable", "Workspace file operation unavailable.");
  }
  async listFiles(id: string, path = ".", options: { offset?: number; limit?: number } = {}) {
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) fail("invalid_input", "Invalid file offset.");
    number(options.limit, 100, 1000);
    return this.file<FileList>(id, "list", path, options);
  }
  async readFile(id: string, path: string, options: { offset?: number; length?: number } = {}) {
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) fail("invalid_input", "Invalid file offset.");
    number(options.length, 65536, 1024 * 1024);
    return this.file<FileRead>(id, "read", path, options);
  }
  async writeFile(id: string, path: string, options: { base64: string; createParents?: boolean }) {
    if (!options || typeof options.base64 !== "string" || options.base64.length > 1_398_104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(options.base64)) fail("invalid_input", "Invalid file data (maximum 1 MiB).");
    if (Buffer.from(options.base64, "base64").length > 1024 * 1024) fail("invalid_input", "File data exceeds 1 MiB.");
    return this.file<FileEntry>(id, "write", path, options);
  }
  async removeFile(id: string, path: string, options: { recursive?: boolean } = {}) { await this.file(id, "remove", path, options); }
  private saveService(state: ServiceState) { this.write(join(this.root, state.meta.sandboxId, "services", `${state.meta.id}.json`), { meta: state.meta, desired: state.desired }); }
  private async serviceState(id: string, serviceId: string) {
    await this.check(id);
    const state = this.serviceStates.get(serviceId);
    if (!state || state.meta.sandboxId !== id) return fail("not_found", "Service not found.");
    return state;
  }
  private serviceView(state: ServiceState): SandboxService {
    const current = state.runId ? this.active.get(state.runId)?.run : undefined;
    return structuredClone({ ...state.meta, ...(current ? { stdout: current.stdout, stderr: current.stderr, truncated: current.truncated } : {}) });
  }
  private async launchService(state: ServiceState) {
    if (!state.desired || this.closed) return;
    try {
      const run = await this.startCommand(state.meta.sandboxId, { command: state.meta.command, cwd: state.meta.cwd }, true);
      state.runId = run.id; state.meta.status = "running"; state.meta.startedAt = run.startedAt; state.meta.finishedAt = undefined;
      state.meta.history.push({ startedAt: run.startedAt, exitCode: null }); state.meta.history = state.meta.history.slice(-20);
      this.saveService(state);
      const active = this.active.get(run.id)!;
      void active.done.then(() => {
        const completed = active.run;
        state.runId = undefined;
        Object.assign(state.meta, { stdout: completed.stdout, stderr: completed.stderr, truncated: completed.truncated, exitCode: completed.exitCode, finishedAt: completed.finishedAt });
        const attempt = state.meta.history.at(-1); if (attempt) { attempt.finishedAt = completed.finishedAt; attempt.exitCode = completed.exitCode; }
        if (this.closed || this.workspaces.get(state.meta.sandboxId)?.unavailable) state.meta.status = "interrupted";
        else if (state.desired && state.meta.restartCount < state.meta.restart.maxRestarts && (state.meta.restart.policy === "always" || (state.meta.restart.policy === "on-failure" && completed.exitCode !== 0))) {
          state.meta.restartCount++; state.meta.status = "restarting";
          state.timer = setTimeout(() => { state.timer = undefined; void this.launchService(state); }, state.meta.restart.delayMs);
        } else { state.meta.status = !state.desired || completed.exitCode === 0 ? "stopped" : "failed"; state.desired = false; }
        this.saveService(state);
      }).catch(() => { this.broken = true; });
    } catch { state.meta.status = "failed"; state.desired = false; this.saveService(state); }
  }
  async startService(id: string, input: ServiceInput) {
    await this.check(id, true);
    if (!input || typeof input.name !== "string" || !input.name.trim() || input.name.length > 128 || typeof input.command !== "string" || !input.command.trim() || Buffer.byteLength(input.command) > 65_536 || input.command.includes("\0")) fail("invalid_input", "A service name and bounded command are required.");
    const same = [...this.serviceStates.values()].filter((state) => state.meta.sandboxId === id);
    if (same.some((state) => state.meta.name === input.name)) fail("busy", "Service name already exists.");
    if (same.length >= (this.options.maxServicesPerSandbox ?? 8)) fail("capacity", "Service capacity reached.");
    const restart = input.restart ?? { policy: "never", maxRestarts: 0, delayMs: 1000 };
    if (!["never", "on-failure", "always"].includes(restart.policy) || !Number.isSafeInteger(restart.maxRestarts) || restart.maxRestarts < 0 || restart.maxRestarts > 1000 || !Number.isSafeInteger(restart.delayMs) || restart.delayMs < 100 || restart.delayMs > 3_600_000) fail("invalid_input", "Invalid service restart policy.");
    this.cwd(input.cwd);
    const meta: SandboxService = { id: randomUUID(), sandboxId: id, name: input.name, command: input.command, cwd: input.cwd, restart: { ...restart }, status: "restarting", restartCount: 0, stdout: "", stderr: "", truncated: false, createdAt: new Date().toISOString(), exitCode: null, history: [] };
    const state: ServiceState = { meta, desired: true }; this.serviceStates.set(meta.id, state); this.saveService(state);
    await this.launchService(state); return this.serviceView(state);
  }
  async services(id: string) { await this.check(id); return [...this.serviceStates.values()].filter((state) => state.meta.sandboxId === id).map((state) => this.serviceView(state)); }
  async service(id: string, serviceId: string) { return this.serviceView(await this.serviceState(id, serviceId)); }
  async stopService(id: string, serviceId: string) {
    const state = await this.serviceState(id, serviceId); state.desired = false; clearTimeout(state.timer); state.timer = undefined;
    if (state.runId) { const active = this.active.get(state.runId); if (active) { await active.stop("cancelled"); await active.done; } }
    state.meta.status = "stopped"; state.meta.finishedAt = new Date().toISOString(); this.saveService(state); return this.serviceView(state);
  }
  async restartService(id: string, serviceId: string) {
    await this.check(id, true); await this.stopService(id, serviceId); const state = await this.serviceState(id, serviceId);
    state.desired = true; state.meta.restartCount = 0; await this.launchService(state); return this.serviceView(state);
  }
  async removeService(id: string, serviceId: string) { await this.stopService(id, serviceId); this.serviceStates.delete(serviceId); rmSync(join(this.root, id, "services", `${serviceId}.json`)); }
  private terminalView(state: TerminalState, offset = state.startOffset): TerminalOutput {
    if (!Number.isSafeInteger(offset) || offset < 0) fail("invalid_input", "Invalid terminal output offset.");
    if (offset > state.nextOffset) fail("invalid_input", "Terminal offset is beyond retained output.");
    let relative = Math.max(state.startOffset, offset) - state.startOffset;
    while (relative < state.data.length && (state.data[relative] & 0xc0) === 0x80) relative++;
    const decoder = new StringDecoder("utf8");
    return { ...state.meta, data: decoder.write(state.data.subarray(relative)), startOffset: state.startOffset, offset: state.startOffset + relative, nextOffset: state.nextOffset, truncated: offset < state.startOffset };
  }
  private persistTerminal(state: TerminalState) { this.write(join(this.root, state.meta.sandboxId, "terminals", `${state.meta.id}.json`), this.terminalView(state)); }
  private async terminalState(id: string, terminalId: string) {
    await this.check(id);
    const state = this.terminalStates.get(terminalId);
    if (!state || state.meta.sandboxId !== id) return fail("not_found", "Terminal not found.");
    return state;
  }
  async openTerminal(id: string, input: TerminalInput = {}): Promise<TerminalSession> {
    const workspace = await this.check(id, true);
    if (!this.pty) fail("unsupported", "Install node-pty on the controller to enable container terminals.");
    const cols = number(input.cols, 80, 500); const rows = number(input.rows, 24, 300);
    const entries = [...this.terminalStates.values()].filter((state) => state.meta.sandboxId === id && state.meta.status === "running");
    if (entries.length >= (this.options.maxTerminalsPerSandbox ?? 4)) fail("capacity", "Terminal capacity reached.");
    const terminalId = randomUUID();
    const script = `cd -- "$2" || exit 127; exec /bin/bash --noprofile --norc -i`;
    const terminal = this.pty!.spawn(this.executable, ["exec", "-it", "--env", "TERM=xterm-256color", workspace.container, "/bin/bash", "--noprofile", "--norc", "-p", "-c", script, "station-terminal", terminalId, this.cwd(input.cwd)], { name: "xterm-256color", cols, rows, cwd: this.root, env: process.env });
    let finish!: () => void;
    const state: TerminalState = { meta: { id: terminalId, sandboxId: id, status: "running", cols, rows, startedAt: new Date().toISOString(), exitCode: null }, process: terminal, data: Buffer.alloc(0), startOffset: 0, nextOffset: 0, done: new Promise<void>((resolveDone) => { finish = resolveDone; }) };
    this.terminalStates.set(terminalId, state); this.persistTerminal(state);
    let dirty = false;
    const checkpoint = setInterval(() => {
      if (!dirty) return; dirty = false;
      try { this.persistTerminal(state); } catch { this.broken = true; state.process?.kill(); }
    }, 1000);
    terminal.onData((chunk) => {
      const bytes = Buffer.from(chunk, "utf8");
      state.data = Buffer.concat([state.data, bytes]); state.nextOffset += bytes.length; dirty = true;
      if (state.data.length > this.maxOutput) {
        let drop = state.data.length - this.maxOutput;
        while (drop < state.data.length && (state.data[drop] & 0xc0) === 0x80) drop++;
        state.startOffset += drop; state.data = Buffer.from(state.data.subarray(drop));
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearInterval(checkpoint);
      void this.cleanup(workspace, terminalId).catch(() => { this.broken = true; }).finally(() => {
        state.meta.status = this.closed || workspace.unavailable ? "interrupted" : "exited"; state.meta.exitCode = exitCode; state.meta.finishedAt = new Date().toISOString(); state.process = undefined;
        try {
          this.persistTerminal(state);
          const history = [...this.terminalStates.values()].filter((item) => item.meta.sandboxId === id && item.meta.status !== "running").sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt));
          for (const old of history.slice(0, Math.max(0, history.length - this.maxHistory))) { this.terminalStates.delete(old.meta.id); rmSync(join(this.root, id, "terminals", `${old.meta.id}.json`)); }
        } catch { this.broken = true; }
        finish();
      });
    });
    return { ...state.meta };
  }
  async terminals(id: string) { await this.check(id); return [...this.terminalStates.values()].filter((state) => state.meta.sandboxId === id).map((state) => ({ ...state.meta })); }
  async terminal(id: string, terminalId: string, offset?: number) { return this.terminalView(await this.terminalState(id, terminalId), offset); }
  async terminalInput(id: string, terminalId: string, data: string) {
    const state = await this.terminalState(id, terminalId);
    if (!state.process || state.meta.status !== "running") fail("unavailable", "Terminal has exited.");
    if (typeof data !== "string" || Buffer.byteLength(data) > 65_536) fail("invalid_input", "Terminal input exceeds 64 KiB.");
    state.process!.write(data);
  }
  async resizeTerminal(id: string, terminalId: string, cols: number, rows: number) {
    const state = await this.terminalState(id, terminalId);
    number(cols, 80, 500); number(rows, 24, 300);
    if (!state.process) fail("unavailable", "Terminal has exited.");
    state.process!.resize(cols, rows); state.meta.cols = cols; state.meta.rows = rows; this.persistTerminal(state);
  }
  async closeTerminal(id: string, terminalId: string) {
    const workspace = await this.check(id); const state = await this.terminalState(id, terminalId);
    if (state.process) { await this.terminateWorkspace(workspace); state.process.kill(); await state.done; }
  }
  close() {
    return this.closing ??= (async () => {
      try { await this.initialized; } catch { this.releaseLock(); return; }
      this.closed = true;
      await Promise.allSettled(this.creations);
      for (const state of this.serviceStates.values()) { clearTimeout(state.timer); state.timer = undefined; }
      const terminalFailures = await Promise.allSettled([...this.terminalStates.values()].filter((state) => state.process).map(async (state) => {
        const workspace = this.workspaces.get(state.meta.sandboxId)!; await this.cleanup(workspace, state.meta.id); state.process?.kill(); await state.done;
      }));
      const active = [...this.active.values()];
      const failures = await Promise.allSettled(active.map(async (entry) => { await entry.stop("interrupted"); await entry.done; }));
      for (const workspace of this.workspaces.values()) {
        try { await this.call(["stop", "--time", "1", workspace.container]); } catch { this.broken = true; }
      }
      this.releaseLock();
      if ([...failures, ...terminalFailures].some((result) => result.status === "rejected") || this.broken) fail("unavailable", "Container shutdown or persistence failed.");
    })();
  }
}
