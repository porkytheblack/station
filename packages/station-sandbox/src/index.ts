import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface Sandbox {
  id: string;
  createdAt: string;
  /** Adapter identifier; host-process is the first implementation. */
  backend: string;
}
export interface CommandInput { command: string; cwd?: string; timeoutMs?: number }
export interface CommandRun {
  id: string;
  sandboxId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timed_out" | "interrupted";
  stdout: string;
  stderr: string;
  truncated: boolean;
  exitCode: number | null;
  startedAt: string;
  finishedAt?: string;
}
export interface SandboxAdapter {
  readonly name: string;
  readonly capabilities: { filesystem: true; commands: true; isolated: boolean; pty: boolean };
  create(): Promise<Sandbox>;
  list(): Promise<Sandbox[]>;
  get(id: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  exec(id: string, input: CommandInput): Promise<CommandRun>;
  command(id: string, runId: string): Promise<CommandRun>;
  cancel(id: string, runId: string): Promise<CommandRun>;
  close(): Promise<void>;
}
export class SandboxError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "SandboxError"; }
}
export interface HostSandboxOptions {
  rootDir: string;
  maxEnvironments?: number;
  maxConcurrent?: number;
  maxOutputBytes?: number;
  maxTimeoutMs?: number;
  /** Maximum completed command records retained per workspace. Default: 100. */
  maxHistoryPerSandbox?: number;
  /** Explicit child environment. Host secrets are not inherited automatically. */
  env?: Record<string, string>;
  shell?: string;
}
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (code: string, message: string): never => { throw new SandboxError(code, message); };

/** Trusted-code backend. One manager process must own a root directory. */
export class HostSandboxAdapter implements SandboxAdapter {
  readonly name = "host-process";
  readonly capabilities = { filesystem: true, commands: true, isolated: false, pty: false } as const;
  private readonly root: string;
  private readonly environments = new Map<string, Sandbox>();
  private readonly running = new Map<string, { run: CommandRun; child: ChildProcess; done: Promise<void>; stop(status: CommandRun["status"]): void }>();
  private readonly maxEnvironments: number;
  private readonly maxConcurrent: number;
  private readonly maxOutput: number;
  private readonly maxTimeout: number;
  private readonly maxHistory: number;
  private closed = false;
  private storageFailed = false;
  private readonly persistenceFailures = new Map<string, SandboxError>();

  constructor(private readonly options: HostSandboxOptions) {
    if (process.platform === "win32") fail("unsupported", "The host-process backend requires a POSIX host.");
    this.root = resolve(options.rootDir);
    const limit = (value: number | undefined, fallback: number) => {
      const n = value ?? fallback;
      if (!Number.isSafeInteger(n) || n < 1) fail("invalid_input", "Limits must be positive integers.");
      return n;
    };
    this.maxEnvironments = limit(options.maxEnvironments, 20);
    this.maxConcurrent = limit(options.maxConcurrent, 4);
    this.maxOutput = limit(options.maxOutputBytes, 256 * 1024);
    this.maxTimeout = limit(options.maxTimeoutMs, 300_000);
    this.maxHistory = limit(options.maxHistoryPerSandbox, 100);
    if (this.maxTimeout > 2_147_483_647) fail("invalid_input", "Timeout exceeds timer range.");
    if (options.shell !== undefined && (typeof options.shell !== "string" || !options.shell || options.shell.includes("\0"))) fail("invalid_input", "shell must name a Bash-compatible executable.");
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0")) fail("invalid_input", "Invalid child environment.");
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(this.root)) {
      if (!validId.test(id)) continue;
      const sandbox = this.readMetadata(join(this.root, id, "sandbox.json")) as Sandbox;
      if (!sandbox || sandbox.id !== id || sandbox.backend !== this.name || !this.date(sandbox.createdAt)) fail("invalid_state", "Invalid sandbox metadata.");
      this.environments.set(id, { id, backend: "host-process", createdAt: sandbox.createdAt });
      for (const filename of readdirSync(join(this.root, id, "runs"))) {
        if (!filename.endsWith(".json")) continue;
        const runId = filename.slice(0, -5);
        const path = join(this.root, id, "runs", filename);
        const run = this.readRun(id, runId);
        if (run.status === "running") this.write(path, { ...run, status: "interrupted", finishedAt: new Date().toISOString() });
      }
      this.prune(id);
    }
  }
  private date(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
  private readMetadata(path: string): unknown {
    try {
      // Results are capped on write. Reject unexpectedly huge or malformed records on recovery.
      if (statSync(path).size > this.maxOutput * 6 + 16_384) fail("invalid_state", "Oversized sandbox metadata.");
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("not_found", "Sandbox metadata not found.");
      return fail("invalid_state", "Unreadable sandbox metadata.");
    }
  }
  private readRun(id: string, runId: string): CommandRun {
    const run = this.readMetadata(this.runPath(id, runId)) as CommandRun;
    const statuses = ["running", "completed", "failed", "cancelled", "timed_out", "interrupted"];
    if (!run || run.id !== runId || run.sandboxId !== id || !statuses.includes(run.status) ||
        typeof run.stdout !== "string" || typeof run.stderr !== "string" || typeof run.truncated !== "boolean" ||
        !(run.exitCode === null || Number.isInteger(run.exitCode)) || !this.date(run.startedAt) ||
        (run.status !== "running" && !this.date(run.finishedAt))) fail("invalid_state", "Invalid command metadata.");
    return run;
  }
  private prune(id: string) {
    const records = readdirSync(join(this.root, id, "runs"))
      .filter((filename) => filename.endsWith(".json"))
      .map((filename) => this.readRun(id, filename.slice(0, -5)))
      .filter((run) => run.status !== "running")
      .sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!) || a.id.localeCompare(b.id));
    for (const run of records.slice(0, Math.max(0, records.length - this.maxHistory))) rmSync(this.runPath(id, run.id));
  }
  private write(path: string, value: unknown) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  }
  private check(id: string): Sandbox {
    const sandbox = this.environments.get(id);
    if (!sandbox || !validId.test(id)) return fail("not_found", "Sandbox not found.");
    return sandbox;
  }
  private runPath(id: string, runId: string) {
    this.check(id);
    if (!validId.test(runId)) fail("not_found", "Command not found.");
    return join(this.root, id, "runs", `${runId}.json`);
  }
  async create(): Promise<Sandbox> {
    if (this.closed || this.storageFailed) fail("unavailable", "Worker is closing or storage is unavailable.");
    if (this.environments.size >= this.maxEnvironments) fail("capacity", "Workspace capacity reached.");
    const sandbox: Sandbox = { id: randomUUID(), createdAt: new Date().toISOString(), backend: "host-process" };
    const dir = join(this.root, sandbox.id);
    for (const name of ["workspace", "home", "runs"]) mkdirSync(join(dir, name), { recursive: true, mode: 0o700 });
    this.write(join(dir, "sandbox.json"), sandbox);
    this.environments.set(sandbox.id, sandbox);
    return { ...sandbox };
  }
  async list() { return [...this.environments.values()].map((item) => ({ ...item })); }
  async get(id: string) { return { ...this.check(id) }; }
  async destroy(id: string) {
    this.check(id);
    if ([...this.running.values()].some(({ run }) => run.sandboxId === id)) fail("busy", "Cancel running commands before deleting the workspace.");
    rmSync(join(this.root, id), { recursive: true });
    this.environments.delete(id);
  }
  async exec(id: string, input: CommandInput): Promise<CommandRun> {
    this.check(id);
    if (this.closed || this.storageFailed) fail("unavailable", "Worker is closing or storage is unavailable.");
    if (!input || typeof input.command !== "string" || !input.command.trim() || Buffer.byteLength(input.command) > 65_536 || input.command.includes("\0")) fail("invalid_input", "command must be a non-empty string up to 64 KiB.");
    if (input.cwd !== undefined && (typeof input.cwd !== "string" || isAbsolute(input.cwd) || input.cwd.includes("\0"))) fail("invalid_input", "cwd must be a relative directory.");
    const timeout = input.timeoutMs ?? Math.min(30_000, this.maxTimeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > this.maxTimeout) fail("invalid_input", "Invalid command timeout.");
    if (this.running.size >= this.maxConcurrent) fail("capacity", "Worker command capacity reached.");
    const workspace = realpathSync(join(this.root, id, "workspace"));
    let cwd: string;
    try { cwd = realpathSync(resolve(workspace, input.cwd ?? ".")); if (!statSync(cwd).isDirectory()) throw new Error("Not a directory"); }
    catch { return fail("invalid_input", "Working directory does not exist."); }
    const delta = relative(workspace, cwd);
    if (delta === ".." || delta.startsWith("../") || isAbsolute(delta)) fail("invalid_input", "Working directory must be inside the workspace.");
    const run: CommandRun = { id: randomUUID(), sandboxId: id, status: "running", stdout: "", stderr: "", truncated: false, exitCode: null, startedAt: new Date().toISOString() };
    this.write(this.runPath(id, run.id), run);
    const home = join(this.root, id, "home");
    const toolPrefix = join(home, ".local");
    const path = [join(workspace, "node_modules", ".bin"), join(toolPrefix, "bin"),
      this.options.env?.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
    const child = spawn(this.options.shell ?? "/bin/bash", ["--noprofile", "--norc", "-c", input.command], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { LANG: "C.UTF-8", NPM_CONFIG_PREFIX: toolPrefix, ...this.options.env, PATH: path, HOME: home, TMPDIR: workspace },
    });
    let bytes = 0;
    const captured = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const append = (key: "stdout" | "stderr", chunk: Buffer) => {
      const room = Math.max(0, this.maxOutput - bytes);
      const retained = chunk.subarray(0, room);
      if (retained.length) {
        captured[key] = Buffer.concat([captured[key], retained]);
        // Decode across chunk boundaries and omit partial trailing UTF-8 characters.
        // Invalid bytes may expand to replacement characters: cap their encoded size too.
        const decoded = new StringDecoder("utf8").write(captured[key]);
        run[key] = new StringDecoder("utf8").write(Buffer.from(decoded).subarray(0, captured[key].length));
      }
      bytes += retained.length;
      if (chunk.length > room) run.truncated = true;
    };
    child.stdout!.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => append("stderr", chunk));
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") append("stderr", Buffer.from(`Process cleanup failed: ${String(error)}`));
      }
    };
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (status: CommandRun["status"]) => {
      if (run.status !== "running") return;
      run.status = status;
      kill("SIGTERM");
      hardKill = setTimeout(() => kill("SIGKILL"), 250);
    };
    const timer = setTimeout(() => stop("timed_out"), timeout);
    let finish!: () => void;
    const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
    this.running.set(run.id, { run, child, done, stop });
    child.on("error", (error) => { append("stderr", Buffer.from(error.message)); run.status = "failed"; });
    // exit precedes close: children can retain pipe handles after the shell exits.
    child.on("exit", () => kill("SIGKILL"));
    child.on("close", (code) => {
      clearTimeout(timer); clearTimeout(hardKill);
      // Commands are bounded jobs: do not leave ordinary background children behind.
      kill("SIGKILL");
      run.exitCode = code;
      if (run.status === "running") run.status = code === 0 ? "completed" : "failed";
      run.finishedAt = new Date().toISOString();
      try { this.write(this.runPath(id, run.id), run); this.prune(id); }
      catch {
        run.status = "failed";
        this.storageFailed = true;
        this.persistenceFailures.set(run.id, new SandboxError("storage_error", "Failed to persist command result or prune command history."));
      }
      this.running.delete(run.id);
      finish();
    });
    return { ...run };
  }
  async command(id: string, runId: string): Promise<CommandRun> {
    this.runPath(id, runId);
    const persistenceFailure = this.persistenceFailures.get(runId);
    if (persistenceFailure) throw persistenceFailure;
    const active = this.running.get(runId);
    if (active?.run.sandboxId === id) return { ...active.run };
    return this.readRun(id, runId);
  }
  async cancel(id: string, runId: string) {
    await this.command(id, runId);
    const active = this.running.get(runId);
    if (active) { active.stop("cancelled"); await active.done; }
    return this.command(id, runId);
  }
  async close() {
    this.closed = true;
    const active = [...this.running.values()];
    for (const entry of active) entry.stop("interrupted");
    await Promise.all(active.map((entry) => entry.done));
  }
}
