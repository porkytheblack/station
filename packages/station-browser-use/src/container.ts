import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BrowserUseError, type BrowserAdapter, type BrowserSession } from "./browser.js";
import { validateBrowserOpenOptions, type BrowserOpenOptions, type BrowserProfile } from "./commands.js";
import { managedSession, validateTimeout } from "./session.js";
import { atomicWrite, directory, entries, lockDirectory, ownedPath, readBounded, safeId } from "./storage.js";
export interface ContainerBrowserOptions {
  rootDir: string;
  /** Required when reopening an already tenant-bound controller root. */
  tenantId?: string;
  /** Operator-built image containing Node, Playwright and the immutable worker. */
  image: string;
  engine?: "docker" | "podman";
  executable?: string;
  workerPath?: string;
  /** Local Linux Docker only: operator-provisioned profile directory, e.g. under enforced XFS project quota. */
  profileStorageRoot?: string;
  /** Operator-selected egress proxy. Public deployment profile enforces this below the workload. */
  proxy?: { server: string };
  /** none by default. host/container networking is rejected. */
  network?: string;
  /** Operator assertion for an externally enforced named-network egress policy. */
  networkRestricted?: boolean;
  user?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  tmpfsMb?: number;
  timeoutMs?: number;
  maxProfiles?: number;
  maxPages?: number;
  maxArtifactBytes?: number;
  maxArtifacts?: number;
}
const OWNER = "station.browser.owner";
const PROFILE = "station.browser.profile";
const SESSION = "station.browser.session";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const error = (code: string, message: string) => new BrowserUseError(code, message);
const bounded = (value: number | undefined, fallback: number, max: number) => { const n = value ?? fallback; if (!Number.isSafeInteger(n) || n < 1 || n > max) throw error("invalid_input", "Invalid container resource limit."); return n; };
/** One Linux container per browser session. No host-process fallback. */
export class ContainerBrowserAdapter implements BrowserAdapter {
  readonly name: string;
  readonly capabilities: BrowserAdapter["capabilities"];
  private readonly root: string;
  private readonly profiles: string;
  private readonly profileStorageRoot?: string;
  private readonly journals: string;
  private readonly release: () => void;
  private readonly executable: string;
  private readonly owner: string;
  private image = "";
  private readonly readyPromise: Promise<void>;
  private readonly sessions = new Set<BrowserSession>();
  private readonly opening = new Set<Promise<BrowserSession>>();
  private readonly busyProfiles = new Set<string>();
  private closed = false;
  private broken = false;
  private closing?: Promise<void>;
  private readonly timeout: number;
  private readonly user: string;
  private readonly memory: number;
  private readonly cpus: number;
  private readonly pids: number;
  private readonly tmpfs: number;
  constructor(private readonly options: ContainerBrowserOptions) {
    this.name = options.engine === "podman" ? "podman-playwright" : "docker-playwright";
    this.executable = options.executable ?? options.engine ?? "docker";
    if (!options.image || options.image.startsWith("-") || /[\0\r\n]/.test(options.image)) throw error("invalid_input", "A valid operator image is required.");
    const network = options.network ?? "none";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(network) || ["host", "container"].includes(network)) throw error("invalid_input", "Host/container networking is unsupported.");
    if (options.networkRestricted && ["bridge", "default", "podman"].includes(network)) throw error("invalid_input", "A built-in bridge is not a restricted network.");
    if (options.workerPath && (!options.workerPath.startsWith("/") || /[\0\r\n]/.test(options.workerPath))) throw error("invalid_input", "Worker path must be an absolute image path.");
    this.user = options.user ?? "1000:1000";
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/.test(this.user)) throw error("invalid_input", "A numeric nonroot UID/GID is required.");
    this.memory = bounded(options.memoryMb, 1024, 1_048_576); this.pids = bounded(options.pidsLimit, 256, 1_000_000); this.tmpfs = bounded(options.tmpfsMb, 256, 65536);
    this.cpus = options.cpus ?? 1; if (!Number.isFinite(this.cpus) || this.cpus <= 0 || this.cpus > 1024) throw error("invalid_input", "Invalid CPU limit.");
    this.timeout = options.timeoutMs ?? 30_000; validateTimeout(this.timeout);
    bounded(options.maxProfiles, 64, 1024); bounded(options.maxPages, 8, 64); bounded(options.maxArtifactBytes, 4 * 1024 * 1024, 16 * 1024 * 1024); bounded(options.maxArtifacts, 16, 128);
    this.capabilities = { screenshots: true, independentSessions: true, profiles: true, pages: true, commands: true, uploads: true, downloads: true, pointer: true, inspection: true, locators: true, dialogs: true, diagnostics: true, tracing: true, isolated: true, networkRestricted: network === "none" || Boolean(options.networkRestricted) };
    if (options.proxy) {
      const proxy = new URL(options.proxy.server);
      if (proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash || !/^\d+\.\d+\.\d+\.\d+$/.test(proxy.hostname) || !proxy.port) throw error("invalid_input", "Egress proxy must be an explicit IPv4 HTTP endpoint without credentials or bypass rules.");
    }
    if (options.profileStorageRoot) {
      if (process.platform !== "linux" || options.engine === "podman" || options.profileStorageRoot.includes(",")) throw error("unsupported", "Profile storage directories require local Linux Docker.");
      this.profileStorageRoot = directory(options.profileStorageRoot);
      if (lstatSync(this.profileStorageRoot).uid !== Number(this.user.split(":")[0])) throw error("invalid_state", "Profile storage root must belong to the configured workload UID.");
    }
    this.root = directory(options.rootDir); this.release = lockDirectory(this.root);
    try {
      this.profiles = directory(join(this.root, "profiles")); this.journals = directory(join(this.root, "sessions"));
      const path = join(this.root, "owner.json"); this.owner = existsSync(path) ? JSON.parse(readBounded(path, 4096).toString()).id : randomUUID();
      if (!uuid.test(this.owner)) throw error("invalid_state", "Invalid container browser owner.");
      if (!existsSync(path)) atomicWrite(path, JSON.stringify({ id: this.owner }));
      this.bindTenantStorage(options.tenantId);
    } catch (reason) { this.release(); throw reason; }
    this.readyPromise = this.initialize().catch((reason) => { this.broken = true; this.release(); throw reason; });
    void this.readyPromise.catch(() => undefined);
  }
  ready(): Promise<void> { return this.readyPromise; }
  async bindTenant(tenantId?: string): Promise<void> { await this.admit(); this.bindTenantStorage(tenantId); }
  private bindTenantStorage(tenantId?: string): void {
    if (tenantId !== undefined && (typeof tenantId !== "string" || !tenantId || tenantId.length > 200 || /[\0\r\n]/.test(tenantId))) throw error("invalid_input", "Invalid tenant identity.");
    const path = join(this.root, "tenant.json");
    if (existsSync(path)) {
      if (JSON.parse(readBounded(path, 4096).toString()).tenantId !== tenantId) throw error("invalid_state", "Browser storage belongs to another tenant.");
    } else {
      if (tenantId === undefined) return;
      if (entries(this.profiles).length || entries(this.journals).length || this.sessions.size || this.opening.size) throw error("invalid_state", "Existing browser storage cannot be assigned to a tenant.");
      atomicWrite(path, JSON.stringify({ tenantId }));
    }
  }
  private call(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; let total = 0; let failed = false;
      const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, 15_000);
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 1024 * 1024) { failed = true; child.kill("SIGKILL"); } else if (stream === child.stdout) output += chunk.toString(); });
      child.once("error", () => { clearTimeout(timer); reject(error("unavailable", "Container engine could not be started.")); });
      child.once("close", (code) => { clearTimeout(timer); code === 0 && !failed ? resolve(output) : reject(error("unavailable", "Container engine operation failed.")); });
    });
  }
  private async initialize() {
    const info = JSON.parse(await this.call(["info", "--format", "json"]));
    if ((info.OSType ?? info.host?.os ?? info.Host?.OS) !== "linux") throw error("unsupported", "A Linux container engine is required.");
    if ([info.MemoryLimit, info.CpuCfsQuota, info.PidsLimit].some((supported) => supported === false)) throw error("unsupported", "Container resource limits are unavailable.");
    if (Array.isArray(info.host?.cgroupControllers) && ["cpu", "memory", "pids"].some((item) => !info.host.cgroupControllers.includes(item))) throw error("unsupported", "CPU, memory and PID controller delegation is required.");
    if (this.profileStorageRoot) {
      if ((process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith("unix://")) || info.SecurityOptions?.some((value: string) => value.includes("rootless"))) throw error("unsupported", "Profile storage requires local rootful Docker.");
      const endpoint = JSON.parse(await this.call(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]));
      if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) throw error("unsupported", "Remote Docker cannot mount local profile storage.");
    }
    const image = JSON.parse(await this.call(["image", "inspect", this.options.image]))[0];
    if (typeof image.Id !== "string" || !/^(sha256:)?[0-9a-f]{64}$/.test(image.Id)) throw error("invalid_state", "Cannot resolve immutable container image."); this.image = image.Id;
    for (const id of entries(this.journals)) {
      if (!uuid.test(id)) throw error("invalid_state", "Invalid session journal.");
      const record = JSON.parse(readBounded(join(this.journals, id), 4096).toString());
      if (record.name !== this.containerName(id)) throw error("invalid_state", "Invalid container ownership journal.");
      await this.removeContainer(record.name); rmSync(join(this.journals, id));
    }
  }
  private containerName(id: string) { return `station-browser-${this.owner.slice(0, 12)}-${id}`; }
  private volumeName(id: string) { return `station-browser-profile-${this.owner.slice(0, 12)}-${createHash("sha256").update(id).digest("hex").slice(0, 20)}`; }
  private async inspect(kind: "container" | "volume", name: string): Promise<any | undefined> {
    const names = (await this.call(kind === "container" ? ["ps", "-a", "--format", "{{.Names}}"] : ["volume", "ls", "--format", "{{.Name}}"])) .trim().split("\n");
    return names.includes(name) ? JSON.parse(await this.call([kind === "container" ? "inspect" : "volume", ...(kind === "volume" ? ["inspect"] : []), name]))[0] : undefined;
  }
  private async removeContainer(name: string) {
    const value = await this.inspect("container", name);
    if (!value) return;
    if (value.Config?.Labels?.[OWNER] !== this.owner) throw error("invalid_state", "Container ownership mismatch.");
    await this.call(["rm", "--force", name]);
  }
  private async admit() { await this.ready(); if (this.closed || this.broken) throw error("unavailable", "Container browser adapter is unavailable."); }
  async listProfiles(): Promise<BrowserProfile[]> { await this.admit(); return entries(this.profiles).map((id) => ({ id: safeId(id), inUse: this.busyProfiles.has(id) })); }
  async deleteProfile(id: string): Promise<void> {
    await this.admit(); safeId(id);
    if (this.busyProfiles.has(id)) throw error("busy", "Browser profile is in use.");
    const path = ownedPath(this.profiles, id); if (!existsSync(path)) throw error("not_found", "Browser profile not found.");
    this.busyProfiles.add(id);
    try {
      const record = JSON.parse(readBounded(path, 4096).toString());
      if (this.profileStorageRoot) {
        const expected = join(this.profileStorageRoot, this.volumeName(id));
        if (record.directory !== expected) throw error("invalid_state", "Profile storage configuration changed.");
        rmSync(ownedPath(this.profileStorageRoot, this.volumeName(id)), { recursive: true, force: true });
      } else {
        if (record.directory) throw error("invalid_state", "Profile storage configuration changed.");
        const volume = this.volumeName(id); const value = await this.inspect("volume", volume);
        if (value) { if (value.Labels?.[OWNER] !== this.owner || value.Labels?.[PROFILE] !== id) throw error("invalid_state", "Profile ownership mismatch."); await this.call(["volume", "rm", volume]); }
      }
      rmSync(path);
    }
    finally { this.busyProfiles.delete(id); }
  }
  open(input: BrowserOpenOptions = {}): Promise<BrowserSession> {
    const opening = this.openSession(validateBrowserOpenOptions(input)); this.opening.add(opening);
    void opening.finally(() => this.opening.delete(opening)).catch(() => undefined); return opening;
  }
  private async openSession(options: BrowserOpenOptions): Promise<BrowserSession> {
    await this.admit();
    if (options.profileId && this.busyProfiles.has(options.profileId)) throw error("busy", "Browser profile is in use.");
    if (options.profileId) this.busyProfiles.add(options.profileId);
    const id = randomUUID(); const name = this.containerName(id); const journal = join(this.journals, id);
    let child: ChildProcessWithoutNullStreams | undefined; let closed = false; let closing: Promise<void> | undefined;
    const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>(); let sequence = 0;
    const rejectAll = () => { for (const entry of pending.values()) entry.reject(error("unavailable", "Container browser session closed.")); pending.clear(); };
    let session: BrowserSession | undefined;
    const cleanup = () => closing ??= (async () => {
      closed = true; rejectAll(); child?.stdin.end();
      try { await this.removeContainer(name); rmSync(journal, { force: true }); }
      catch (reason) { this.broken = true; throw reason; }
      finally { child?.kill("SIGKILL"); if (session) this.sessions.delete(session); if (options.profileId) this.busyProfiles.delete(options.profileId); }
    })();
    try {
      const mounts: string[] = [];
      if (options.profileId) {
        if (!existsSync(ownedPath(this.profiles, options.profileId)) && entries(this.profiles).length + [...this.busyProfiles].filter((id) => !existsSync(ownedPath(this.profiles, id))).length > (this.options.maxProfiles ?? 64)) throw error("capacity", "Persistent browser profile capacity reached.");
        const volume = this.volumeName(options.profileId);
        const marker = ownedPath(this.profiles, options.profileId);
        const saved = existsSync(marker) ? JSON.parse(readBounded(marker, 4096).toString()) : undefined;
        if (this.profileStorageRoot) {
          const expected = join(this.profileStorageRoot, volume);
          if (saved && saved.directory !== expected) throw error("invalid_state", "Profile storage configuration changed; migrate explicitly.");
          const path = directory(ownedPath(this.profileStorageRoot, volume));
          if (lstatSync(path).uid !== Number(this.user.split(":")[0])) throw error("invalid_state", "Run the controller as the configured workload UID for directory profiles.");
          atomicWrite(marker, JSON.stringify({ directory: path }));
          mounts.push("--mount", `type=bind,source=${path},target=/home/node`);
        } else {
          if (saved?.directory) throw error("invalid_state", "Profile storage configuration changed; migrate explicitly.");
          const existing = await this.inspect("volume", volume);
          if (existing && (existing.Labels?.[OWNER] !== this.owner || existing.Labels?.[PROFILE] !== options.profileId)) throw error("invalid_state", "Profile ownership mismatch.");
          if (!existing) await this.call(["volume", "create", "--label", `${OWNER}=${this.owner}`, "--label", `${PROFILE}=${options.profileId}`, volume]);
          atomicWrite(marker, JSON.stringify({ volume }));
          mounts.push("--mount", `type=volume,source=${volume},target=/home/node`);
        }
      } else mounts.push("--tmpfs", `/home/node:rw,nosuid,nodev,size=${this.tmpfs}m,mode=1777`);
      atomicWrite(journal, JSON.stringify({ name }));
      await this.call(["create", "-i", "--name", name, "--label", `${OWNER}=${this.owner}`, "--label", `${SESSION}=${id}`,
        "--log-driver", "none", "--user", this.user, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--init",
        "--memory", `${this.memory}m`, "--cpus", String(this.cpus), "--pids-limit", String(this.pids), "--network", this.options.network ?? "none",
        ...(this.options.proxy ? ["--dns", "127.0.0.1", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1", "--sysctl", "net.ipv6.conf.default.disable_ipv6=1"] : []),
        "--tmpfs", `/tmp:rw,nosuid,nodev,size=${this.tmpfs}m,mode=1777`, "--shm-size", "128m", ...mounts,
        "--env", "HOME=/home/node", "--env", "TMPDIR=/tmp", "--entrypoint", this.profileStorageRoot ? "/usr/local/bin/station-quota-guard" : "/usr/local/bin/node", this.image,
        ...(this.profileStorageRoot ? ["/usr/local/bin/node"] : []),
        this.options.workerPath ?? "/opt/station/packages/station-browser-use/dist/container-worker.js"]);
      child = spawn(this.executable, ["start", "--attach", "--interactive", name], { stdio: ["pipe", "pipe", "pipe"] });
      const decoder = new StringDecoder("utf8"); let buffer = ""; let bytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 34 * 1024 * 1024) { void cleanup().catch(() => undefined); return; }
        buffer += decoder.write(chunk);
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); bytes = Buffer.byteLength(buffer);
          try { const response = JSON.parse(line); const request = pending.get(response.id); if (!request) continue; pending.delete(response.id); response.error ? request.reject(error(response.error.code ?? "unavailable", response.error.message ?? "Browser operation failed.")) : request.resolve(response.result); }
          catch { void cleanup().catch(() => undefined); }
        }
      });
      child.stderr.on("data", () => { /* Drain diagnostics without exposing page/proxy secrets. */ });
      child.stdin.on("error", () => rejectAll()); child.once("error", () => { rejectAll(); void cleanup().catch(() => undefined); }); child.once("close", () => { rejectAll(); void cleanup().catch(() => undefined); });
      const rpc = (op: string, value?: unknown, extra = {}): Promise<any> => {
        if (closed) return Promise.reject(error("unavailable", "Container browser session closed."));
        const id = ++sequence; const message = JSON.stringify({ id, op, value, ...extra }) + "\n";
        if (Buffer.byteLength(message) > 8 * 1024 * 1024) return Promise.reject(error("invalid_input", "Browser request exceeds transport limits."));
        return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child!.stdin.write(message, (reason) => { if (reason) { pending.delete(id); reject(error("unavailable", "Container browser transport failed.")); } }); });
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([rpc("open", undefined, { options, settings: { proxy: this.options.proxy, timeoutMs: this.timeout, maxPages: this.options.maxPages, maxArtifactBytes: this.options.maxArtifactBytes, maxArtifacts: this.options.maxArtifacts } }), new Promise((_, reject) => { timer = setTimeout(() => reject(error("timeout", "Container browser startup timed out.")), this.timeout); })]); }
      finally { clearTimeout(timer); }
      session = managedSession({ navigate: (value) => rpc("navigate", value), click: (value) => rpc("click", value), type: (value) => rpc("type", value), press: (value) => rpc("press", value), evaluate: (value) => rpc("evaluate", value), screenshot: async () => Buffer.from(await rpc("screenshot"), "base64"), execute: (value) => rpc("execute", value), close: async () => {
        if (!closed) { let timer: ReturnType<typeof setTimeout> | undefined; try { await Promise.race([rpc("close"), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]); } catch { /* Engine removal is authoritative. */ } finally { clearTimeout(timer); } }
        await cleanup();
      } }, this.timeout);
      this.sessions.add(session); if (this.closed) { await session.close(); throw error("unavailable", "Container browser adapter is closing."); } return session;
    } catch (reason) { await cleanup(); throw reason; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true;
    return this.closing = (async () => { await this.readyPromise.catch(() => undefined); const results = await Promise.allSettled([...this.opening, ...[...this.sessions].map((session) => session.close())]); this.release(); const failures = results.filter((result) => result.status === "rejected"); if (failures.length) throw new AggregateError(failures.map((result) => (result as PromiseRejectedResult).reason), "Container browser shutdown failed."); })();
  }
}
