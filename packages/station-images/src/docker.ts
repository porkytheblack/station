import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ImageProcessBackend, ImageProcessBoundary, ImageProcessSpec } from "./execution.js";
import { fail, type HostTarget } from "./types.js";

/** All options are operator configuration, never values from an uploaded manifest. */
export interface DockerImageOptions {
  /** Preinstalled Linux runtime image; tags alone are deliberately rejected. */
  image: string;
  /** Private staging directory on the same host as the Docker engine. */
  rootDir: string;
  /** Runtime compatibility advertised by the reviewed operator image. */
  target: HostTarget;
  executable?: string;
  user?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  tmpfsMb?: number;
  maxConcurrent?: number;
  /** Absolute invocation lifetime recorded for the independent host reaper; GNU timeout is an additional guard. */
  maxRuntimeMs?: number;
  nodeExecutable?: string;
  bunExecutable?: string;
  /** Optional explicit local Docker Unix socket (e.g. Docker Desktop). */
  socketPath?: string;
  /** Operator-reviewed deny-default seccomp JSON; required when the engine default is unconfined. */
  seccompProfile?: string;
}

interface ContainerIntent {
  format: "station.image-invocation/v1";
  name: string;
  image: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
}
interface ContainerState { Id?: string; Name?: string; State?: { Running?: boolean }; Config?: { Image?: string; Labels?: Record<string, string> } }
export interface ImageReapResult { removed: number; retained: number }

function integer(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) fail("invalid_backend", "Docker resource limits must be positive bounded integers");
  return n;
}
function envFile(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || /[\r\n\0]/.test(value)) {
      fail("invalid_environment", "Docker image environment requires valid keys and single-line values");
    }
    return `${key}=${value}`;
  }).join("\n") + "\n";
}

/** A Linux Docker engine is required; there is no host execution fallback. */
export type DockerImageBackendOptions = DockerImageOptions;

export class DockerImageProcessBackend implements ImageProcessBackend {
  readonly isolation = "container" as const;
  readonly name = "docker";
  readonly isolated = true;
  readonly target: HostTarget;
  private readonly root: string;
  private readonly executable: string;
  private readonly owner: string;
  private readonly user: string;
  private readonly memory: number;
  private readonly cpus: number;
  private readonly pids: number;
  private readonly tmpfs: number;
  private readonly capacity: number;
  private readonly maxRuntime: number;
  private readonly engineEnv: NodeJS.ProcessEnv;
  private initialized?: Promise<void>;
  private seccompPath?: string;
  private active = 0;
  private broken = false;

  constructor(private readonly options: DockerImageOptions) {
    options = structuredClone(options); this.options = options;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(options.image)) {
      fail("invalid_backend", "Docker requires an operator-selected image pinned by sha256 digest");
    }
    if (options.target.os !== "linux" || !["amd64", "arm64"].includes(options.target.arch)) {
      fail("invalid_backend", "Docker image target must be Linux amd64 or arm64");
    }
    for (const [runtime, major] of Object.entries(options.target.runtimes)) {
      if (!["node", "bun"].includes(runtime) || !Number.isSafeInteger(major) || major! < 1) fail("invalid_backend", "Invalid Docker runtime declaration");
    }
    this.target = structuredClone(options.target);
    this.root = resolve(options.rootDir);
    this.owner = createHash("sha256").update(`${this.root}\0${options.image}`).digest("hex");
    if (/[\r\n\0,]/.test(this.root)) fail("invalid_backend", "Invalid Docker staging directory");
    this.executable = options.executable ?? "docker";
    this.user = options.user ?? "1000:1000";
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/.test(this.user)) fail("invalid_backend", "Docker requires a numeric non-root UID and GID");
    this.memory = integer(options.memoryMb, 256, 1_048_576);
    this.pids = integer(options.pidsLimit, 64, 1_000_000);
    this.tmpfs = integer(options.tmpfsMb, 32, 1_048_576);
    this.capacity = integer(options.maxConcurrent, 4, 1000);
    this.maxRuntime = integer(options.maxRuntimeMs, 300000, 86400000);
    for (const executable of [options.nodeExecutable, options.bunExecutable]) if (executable && (!isAbsolute(executable) || /[\r\n\0]/.test(executable))) fail("invalid_backend", "Container runtime paths must be absolute");
    this.cpus = options.cpus ?? 1;
    if (!Number.isFinite(this.cpus) || this.cpus <= 0 || this.cpus > 1024) fail("invalid_backend", "Invalid Docker CPU limit");
    if (options.socketPath && (!options.socketPath.startsWith("/") || /[\r\n\0]/.test(options.socketPath))) fail("invalid_backend", "Docker socket must be an absolute local Unix socket path");
    // The CLI may access its explicitly selected engine socket, but workload
    // containers receive neither this environment nor the socket itself.
    if (options.seccompProfile && (!isAbsolute(options.seccompProfile) || /[\r\n\0]/.test(options.seccompProfile))) fail("invalid_backend", "Seccomp profile must be an absolute operator-controlled file path");
    this.engineEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", DOCKER_CONFIG: join(this.root, "docker-config") };
    if (options.socketPath) this.engineEnv.DOCKER_HOST = `unix://${options.socketPath}`;
  }

  private call(args: string[]): Promise<string> {
    return new Promise((resolveCall, reject) => {
      const child = spawn(this.executable, args, { env: this.engineEnv, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", bytes = 0;
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 15000);
      child.stdout.on("data", (data: Buffer) => {
        bytes += data.length;
        if (bytes > 1024 * 1024) child.kill("SIGKILL");
        else output += data.toString();
      });
      child.stderr.resume(); // Never put engine diagnostics (possibly secrets) in errors.
      child.once("error", () => { clearTimeout(timer); reject(new Error("Docker engine operation failed")); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && bytes <= 1024 * 1024) resolveCall(output.trim());
        else reject(new Error("Docker engine operation failed"));
      });
    });
  }

  ready(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }
  private async initializeStorage(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("invalid_backend", "Docker staging root must be an operator-owned real directory");
    await chmod(this.root, 0o700);
    await mkdir(join(this.root, "docker-config"), { mode: 0o700, recursive: true });
    const configInfo = await lstat(join(this.root, "docker-config"));
    if (!configInfo.isDirectory() || configInfo.isSymbolicLink()) fail("invalid_backend", "Docker client config must be a real private directory");
  }
  private async initialize(): Promise<void> {
    await this.initializeStorage();
    if (this.options.seccompProfile) {
      const stat = await lstat(this.options.seccompProfile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || (stat.mode & 0o022) !== 0) fail("invalid_backend", "Seccomp profile must be a bounded regular file without group/world write access");
      const bytes = await readFile(this.options.seccompProfile);
      let profile: { defaultAction?: string; syscalls?: Array<{ names?: unknown; action?: unknown }> };
      try { profile = JSON.parse(bytes.toString("utf8")); } catch { fail("invalid_backend", "Seccomp profile must contain JSON"); }
      if (!["SCMP_ACT_ERRNO", "SCMP_ACT_KILL", "SCMP_ACT_KILL_PROCESS", "SCMP_ACT_TRAP"].includes(profile.defaultAction ?? "") || !Array.isArray(profile.syscalls) || profile.syscalls.some(rule => !rule || !Array.isArray(rule.names) || rule.names.some(name => typeof name !== "string" || !/^[a-zA-Z0-9_]+$/.test(name)))) fail("invalid_backend", "Seccomp profile must deny by default and use explicit syscall names");
      this.seccompPath = join(this.root, `seccomp-${createHash("sha256").update(bytes).digest("hex")}.json`);
      try { await writeFile(this.seccompPath, bytes, { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (!(await readFile(this.seccompPath)).equals(bytes)) fail("invalid_backend", "Stored seccomp profile integrity mismatch"); }
    }
    let info: Record<string, unknown>;
    try { info = JSON.parse(await this.call(["info", "--format", "{{json .}}"])) as Record<string, unknown>; }
    catch { fail("backend_unavailable", "A reachable Docker engine is required"); }
    if (info.OSType !== "linux" || info.MemoryLimit !== true || info.PidsLimit !== true || info.CpuCfsQuota !== true || info.SwapLimit !== true || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some(option => typeof option === "string" && option.includes("name=seccomp") && (option.includes("profile=builtin") || Boolean(this.seccompPath)))) {
      fail("backend_unavailable", "Docker must provide Linux containers and enforce memory, swap, PID and CPU limits with an enforced seccomp profile");
    }
    try {
      const image = JSON.parse(await this.call(["image", "inspect", this.options.image, "--format", "{{json .}}"])) as { Os?: string; Architecture?: string; Config?: { Volumes?: Record<string, unknown> } };
      if (image.Os !== "linux" || image.Architecture !== this.target.arch) fail("incompatible_target", "Operator Docker image does not match configured target");
      if (image.Config?.Volumes && Object.keys(image.Config.Volumes).length) fail("invalid_backend", "Operator image must not declare writable volumes");
    } catch (error) {
      if (error instanceof Error && error.name === "ImageError") throw error;
      fail("backend_unavailable", "The digest-pinned operator image must already be installed in Docker");
    }
  }

  private async intent(directory: string): Promise<ContainerIntent | null> {
    const path = join(directory, "container.json");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const value = JSON.parse(await readFile(path, "utf8")) as ContainerIntent;
    if (value.format !== "station.image-invocation/v1" || !/^station-image-[a-f0-9-]{36}$/.test(value.name ?? "") || value.image !== this.options.image || value.owner !== this.owner || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || value.createdAt < 0 || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > 86400000) return null;
    return value;
  }
  private matches(state: ContainerState, intent: ContainerIntent): boolean {
    return /^[a-f0-9]{64}$/.test(state.Id ?? "") && state.Name === `/${intent.name}` &&
      state.Config?.Image === intent.image && state.Config?.Labels?.["station.image.execution"] === "true" &&
      state.Config?.Labels?.["station.image.owner"] === intent.owner &&
      state.Config?.Labels?.["station.image.invocation"] === intent.name &&
      state.Config?.Labels?.["station.image.created-at"] === String(intent.createdAt) &&
      state.Config?.Labels?.["station.image.expires-at"] === String(intent.expiresAt);
  }
  /** Only stopped, exactly owned containers. Legacy/unverifiable journals stay for operator review. */
  async reconcile(): Promise<ImageReapResult> { return this.cleanJournal(false, Date.now()); }
  /**
   * Independently callable host maintenance. Force-remove exactly owned expired containers,
   * whether running or stopped. Uses Docker container IDs after inspecting immutable labels.
   * Run from a separate service for controller-crash protection. `now` is operator/test-only.
   */
  async reapExpired(now = Date.now(), signal?: AbortSignal): Promise<ImageReapResult> {
    if (!Number.isSafeInteger(now) || now < 0) fail("invalid_reaper_time", "Reaper time must be a nonnegative epoch millisecond value");
    return this.cleanJournal(true, now, signal);
  }
  private async cleanJournal(expiredOnly: boolean, now: number, signal?: AbortSignal): Promise<ImageReapResult> {
    // Cleanup must still work if the old operator image has been pruned or host admission checks fail.
    await this.initializeStorage();
    let removed = 0, retained = 0;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (signal?.aborted) break;
      if (!entry.isDirectory() || !entry.name.startsWith("invocation-")) continue;
      const directory = join(this.root, entry.name);
      try {
        const intent = await this.intent(directory);
        if (!intent || expiredOnly && now < intent.expiresAt) { retained++; continue; }
        const state = JSON.parse(await this.call(["inspect", "--format", "{{json .}}", intent.name])) as ContainerState;
        if (!this.matches(state, intent) || !expiredOnly && state.State?.Running !== false) { retained++; continue; }
        // Removing by ID avoids deleting a different container if its name is replaced after inspect.
        await this.call(["rm", "--force", state.Id!]);
        await rm(directory, { recursive: true, force: true });
        removed++;
      } catch { retained++; }
    }
    return { removed, retained };
  }
  private async removeContainer(name: string): Promise<void> {
    try { await this.call(["rm", "--force", name]); }
    catch {
      // The independent reaper may have already removed an expired invocation.
      // A successful empty engine query confirms absence; engine outages stay failures.
      const survivors = await this.call(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`]);
      if (survivors !== "") fail("cleanup_failed", "Docker container removal could not be confirmed");
    }
  }

  async spawn(spec: ImageProcessSpec): Promise<ImageProcessBoundary> {
    await this.ready();
    if (this.broken) fail("backend_unavailable", "Docker cleanup failed; operator reconciliation is required");
    if (this.active >= this.capacity) fail("capacity", "Docker image execution capacity reached");
    if (dirname(resolve(spec.executablePath)) !== resolve(spec.directory)) fail("invalid_artifact", "Artifact must be directly inside its private staging directory");
    const artifactInfo = await lstat(spec.executablePath);
    if (!artifactInfo.isFile() || artifactInfo.size !== spec.artifact.size) fail("invalid_artifact", "Artifact must be a regular file of the declared size");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(spec.artifact.entrypoint) || !["native", "node", "bun"].includes(spec.artifact.runtime)) fail("invalid_artifact", "Invalid artifact entrypoint or runtime");
    const containerPath = `/station/${spec.artifact.entrypoint}`;
    const environment = envFile(spec.env);
    this.active++;
    const name = `station-image-${randomUUID()}`;
    const createdAt = Date.now(), expiresAt = createdAt + this.maxRuntime;
    let directory: string | undefined;
    let created = false;
    try {
      directory = await mkdtemp(join(this.root, "invocation-"));
      const artifactPath = join(directory, "artifact");
      await copyFile(spec.executablePath, artifactPath);
      await chmod(artifactPath, 0o555);
      const bytes = await readFile(artifactPath);
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== spec.artifact.digest) fail("digest_mismatch", "Staged artifact does not match its digest");
      const envPath = join(directory, "environment");
      await writeFile(envPath, environment, { mode: 0o600, flag: "wx" });
      const runtime = spec.artifact.runtime === "native" ? containerPath
        : spec.artifact.runtime === "node" ? this.options.nodeExecutable ?? "/usr/local/bin/node"
        : this.options.bunExecutable ?? "/usr/local/bin/bun";
      const journal = await open(join(directory, "container.json"), "wx", 0o600);
      try { await journal.writeFile(JSON.stringify({ format: "station.image-invocation/v1", name, image: this.options.image, owner: this.owner, createdAt, expiresAt } satisfies ContainerIntent)); await journal.sync(); } finally { await journal.close(); }
      const parentDirectory = await open(directory, "r");
      try { await parentDirectory.sync(); } finally { await parentDirectory.close(); }
      // Do not use --rm: dispose must confirm removal before dropping its journal.
      created = true; // Create may succeed even when the CLI loses its response.
      await this.call(["create", "--name", name, "--pull", "never", "--interactive",
        "--label", "station.image.execution=true", "--label", `station.image.owner=${this.owner}`,
        "--label", `station.image.invocation=${name}`, "--label", `station.image.created-at=${createdAt}`, "--label", `station.image.expires-at=${expiresAt}`, "--restart", "no", "--stop-timeout", "2",
        "--no-healthcheck", "--network", "none", "--user", this.user, "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", ...(this.seccompPath ? ["--security-opt", `seccomp=${this.seccompPath}`] : []), "--read-only",
        "--memory", `${this.memory}m`, "--memory-swap", `${this.memory}m`,
        "--cpus", String(this.cpus), "--pids-limit", String(this.pids),
        "--ulimit", "nofile=256:256", "--ulimit", "core=0:0", "--log-driver", "none",
        "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${this.tmpfs}m,mode=1777`,
        "--workdir", "/tmp", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
        "--env-file", envPath,
        "--mount", `type=bind,source=${artifactPath},target=${containerPath},readonly`,
        "--entrypoint", "/usr/bin/timeout", this.options.image,
        "--signal=TERM", "--kill-after=1s", `${this.maxRuntime / 1000}s`, runtime,
        ...(spec.artifact.runtime === "native" ? [] : [containerPath])]);
      if (Date.now() >= expiresAt) fail("timeout", "Image invocation expired during container preparation");
      await rm(envPath); // Docker owns the explicit workload env; no plaintext staging copy remains.
      const child = spawn(this.executable, ["start", "--attach", "--interactive", name], {
        env: this.engineEnv, stdio: ["pipe", "pipe", "pipe"], shell: false,
      });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
        child.once("error", () => reject(new Error("Cannot attach Docker image process")));
        child.once("close", (code, signal) => resolveExit({ code, signal }));
      });
      // Promise may reject before the caller installs its protocol listeners.
      void exited.catch(() => {});
      let disposing: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        disposing ??= (async () => {
          try {
            await this.removeContainer(name);
            await rm(directory!, { recursive: true, force: true });
          } catch {
            this.broken = true;
            fail("cleanup_failed", "Docker removal failed; retained container journal requires operator reconciliation");
          } finally {
            child.kill("SIGKILL");
            this.active--;
          }
        })();
        return disposing;
      };
      const terminate = async (force: boolean): Promise<void> => {
        if (disposing) { await disposing; return; }
        try { await this.call([force ? "kill" : "stop", ...(force ? [] : ["--time", "1"]), name]); }
        catch {
          // Already-exited containers need no signal. Confirm state instead of swallowing engine failure.
          const running = await this.call(["inspect", "--format", "{{.State.Running}}", name]);
          if (running !== "false") fail("cleanup_failed", "Docker container termination could not be confirmed");
        }
      };
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, terminate, dispose };
    } catch (error) {
      if (created) {
        try { await this.removeContainer(name); }
        catch { this.broken = true; this.active--; throw new Error("Docker cleanup failed; retained journal requires operator reconciliation"); }
      }
      if (directory) await rm(directory, { recursive: true, force: true });
      this.active--;
      throw error;
    }
  }

}
