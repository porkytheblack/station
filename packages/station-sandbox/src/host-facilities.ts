import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SandboxError } from "./index.js";
import type { FileEntry, FileList, FileRead, FileWrite, SandboxService, ServiceInput, TerminalInput, TerminalOutput, TerminalSession } from "./advanced.js";

interface Pty { pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void; onData(listener: (data: string) => void): unknown; onExit(listener: (event: { exitCode: number }) => void): unknown }
interface PtyModule { spawn(file: string, args: string[], options: { name: string; cwd: string; env: Record<string, string>; cols: number; rows: number }): Pty }
interface TerminalState { view: TerminalSession; buffer: Buffer; offset: number; pty?: Pty; done: Promise<void>; finish(): void; killTimer?: ReturnType<typeof setTimeout> }
interface ServiceState { view: SandboxService; child?: ChildProcess; timer?: ReturnType<typeof setTimeout>; killTimer?: ReturnType<typeof setTimeout>; done?: Promise<void>; stop?: "stopped" | "interrupted" }
interface Options { root: string; shell: string; env: Record<string, string>; maxOutputBytes: number; maxHistory: number; enablePty?: boolean; maxTerminals?: number; maxServices?: number; maxFileBytes?: number; maxTerminalInputBytes?: number }
const fail = (code: string, message: string): never => { throw new SandboxError(code, message); };
const integer = (value: unknown, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("invalid_input", "Invalid numeric bound.");
  return value as number;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const validId = /^[a-f0-9-]{36}$/;
const decode = (buffer: Buffer) => new StringDecoder("utf8").write(buffer);

export class HostFacilities {
  readonly ptyEnabled: boolean;
  private pty?: PtyModule;
  private readonly terminalStates = new Map<string, TerminalState>();
  private readonly serviceStates = new Map<string, ServiceState>();
  private readonly maxTerminals: number;
  private readonly maxServices: number;
  private readonly maxFile: number;
  private readonly maxInput: number;
  private closed = false;
  private readonly serviceControls = new Set<string>();
  private fatal?: SandboxError;
  constructor(private readonly options: Options) {
    this.maxTerminals = integer(options.maxTerminals ?? 8, 1, 1024);
    this.maxServices = integer(options.maxServices ?? 16, 1, 1024);
    this.maxFile = integer(options.maxFileBytes ?? 1024 * 1024, 1, 16 * 1024 * 1024);
    this.maxInput = integer(options.maxTerminalInputBytes ?? 64 * 1024, 1, 1024 * 1024);
    if (options.enablePty !== undefined && typeof options.enablePty !== "boolean") fail("invalid_input", "enablePty must be boolean.");
    this.ptyEnabled = options.enablePty === true;
    if (this.ptyEnabled && "Bun" in globalThis) fail("unsupported", "node-pty terminals require a Node controller; Bun-host PTY support is unavailable. Bun command children remain supported.");
    if (this.ptyEnabled) {
      try {
        const require = createRequire(import.meta.url);
        this.pty = require("node-pty") as PtyModule;
        if (process.platform === "darwin") {
          const packageRoot = dirname(dirname(require.resolve("node-pty")));
          const native = Object.keys(require.cache).find((path) => path.startsWith(`${packageRoot}/`) && path.endsWith("/pty.node"));
          if (!native) throw new Error("Missing native binding path");
          accessSync(join(dirname(native), "spawn-helper"), constants.X_OK);
        }
      } catch { fail("unsupported", "Install node-pty native bindings and verify its macOS spawn-helper is executable before enabling terminals."); }
    }
  }
  assertAvailable() { this.admit(); }
  private admit() { if (this.closed || this.fatal) throw this.fatal ?? new SandboxError("unavailable", "Worker is closing."); }
  private workspace(id: string) { return realpathSync(join(this.options.root, id, "workspace")); }
  private environment(id: string) {
    const home = join(this.options.root, id, "home");
    const prefix = join(home, ".local");
    return { LANG: "C.UTF-8", NPM_CONFIG_PREFIX: prefix, ...this.options.env, HOME: home, TMPDIR: this.workspace(id),
      PATH: [join(this.workspace(id), "node_modules/.bin"), join(prefix, "bin"), this.options.env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"].join(":"), TERM: "xterm-256color" };
  }
  private safePath(id: string, path: string, allowMissing = false, parents = false) {
    if (typeof path !== "string" || !path || path.length > 4096 || isAbsolute(path) || path.includes("\0") || path.includes("\\")) fail("invalid_input", "File path must be relative to the workspace.");
    const parts = path.split("/").filter((part) => part && part !== ".");
    if (parts.some((part) => part === "..")) fail("invalid_input", "Parent traversal is not allowed.");
    let target = this.workspace(id);
    for (let i = 0; i < parts.length; i++) {
      target = join(target, parts[i]);
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) fail("invalid_input", "Symlink paths are not supported by the file API.");
        if (i < parts.length - 1 && !stat.isDirectory()) fail("invalid_input", "Path parent is not a directory.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (parents && i < parts.length - 1) mkdirSync(target, { mode: 0o700 });
        else if (!(allowMissing && i === parts.length - 1)) fail("not_found", "Workspace path does not exist.");
      }
    }
    return target;
  }
  private cwd(id: string, value = ".") {
    const path = this.safePath(id, value);
    if (!lstatSync(path).isDirectory()) fail("invalid_input", "Working directory must be a directory.");
    return path;
  }
  private entry(id: string, path: string): FileEntry {
    const stat = lstatSync(path);
    const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : fail("unsupported", "Special filesystem entries are not supported.");
    return { name: path.split("/").at(-1)!, path: relative(this.workspace(id), path) || ".", type, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }
  listFiles(id: string, path = ".", options: { offset?: number; limit?: number } = {}): FileList {
    if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_input", "Invalid list options.");
    const target = this.cwd(id, path);
    const offset = integer(options.offset ?? 0, 0, 1_000_000);
    const limit = integer(options.limit ?? 100, 1, 1000);
    const directory = opendirSync(target);
    const entries: FileEntry[] = [];
    let index = 0;
    try {
      let entry;
      while ((entry = directory.readSync())) {
        if (index++ < offset) continue;
        if (entries.length === limit) return { entries, nextOffset: offset + entries.length };
        entries.push(this.entry(id, join(target, entry.name)));
      }
      return { entries };
    } finally { directory.closeSync(); }
  }
  readFile(id: string, path: string, options: { offset?: number; length?: number } = {}): FileRead {
    if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_input", "Invalid read options.");
    const target = this.safePath(id, path);
    const offset = integer(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const length = integer(options.length ?? this.maxFile, 1, this.maxFile);
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) fail("invalid_input", "Only regular files can be read.");
      if (offset > stat.size) fail("invalid_input", "Offset exceeds file length.");
      const buffer = Buffer.alloc(Math.min(length, stat.size - offset));
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      return { path, base64: buffer.subarray(0, bytes).toString("base64"), bytes, totalBytes: stat.size, nextOffset: offset + bytes };
    } finally { closeSync(fd); }
  }
  writeFile(id: string, path: string, input: FileWrite): FileEntry {
    this.admit();
    if (!input || typeof input.base64 !== "string" || input.base64.length > Math.ceil(this.maxFile / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) fail("invalid_input", "Expected bounded canonical base64 file data.");
    if (input.createParents !== undefined && typeof input.createParents !== "boolean") fail("invalid_input", "createParents must be boolean.");
    const data = Buffer.from(input.base64, "base64");
    if (data.length > this.maxFile || data.toString("base64") !== input.base64) fail("invalid_input", "File data exceeds its limit or is not canonical base64.");
    const target = this.safePath(id, path, true, input.createParents);
    if (target === this.workspace(id)) fail("invalid_input", "Cannot overwrite workspace root.");
    const tmp = join(dirname(target), `.station-write-${randomUUID()}`);
    try { writeFileSync(tmp, data, { flag: "wx", mode: 0o600 }); this.safePath(id, path, true); renameSync(tmp, target); }
    finally { rmSync(tmp, { force: true }); }
    return this.entry(id, target);
  }
  removeFile(id: string, path: string, options: { recursive?: boolean } = {}) {
    this.admit();
    if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_input", "Invalid remove options.");
    if (options.recursive !== undefined && typeof options.recursive !== "boolean") fail("invalid_input", "recursive must be boolean.");
    const target = this.safePath(id, path);
    if (target === this.workspace(id)) fail("invalid_input", "Cannot remove workspace root.");
    rmSync(target, { recursive: options.recursive ?? false });
  }
  private meta(id: string, kind: "terminals" | "services", itemId: string) {
    if (!validId.test(itemId)) fail("not_found", "Resource not found.");
    const dir = join(this.options.root, id, kind);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, `${itemId}.json`);
  }
  private save(id: string, kind: "terminals" | "services", itemId: string, data: unknown) {
    const path = this.meta(id, kind, itemId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); renameSync(tmp, path);
  }
  private persist(id: string, kind: "terminals" | "services", itemId: string, data: unknown) {
    try { this.save(id, kind, itemId, data); } catch { this.fatal = new SandboxError("storage_error", "Cannot persist terminal/service state; worker admission stopped."); }
  }
  recover(id: string) {
    for (const kind of ["terminals", "services"] as const) {
      const dir = dirname(this.meta(id, kind, randomUUID()));
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        const path = join(dir, file);
        if (lstatSync(path).size > this.options.maxOutputBytes * 8 + 128_000) fail("invalid_state", "Oversized execution metadata.");
        let view;
        try { view = JSON.parse(readFileSync(path, "utf8")); } catch { return fail("invalid_state", "Invalid execution metadata."); }
        if (!view || view.sandboxId !== id || `${view.id}.json` !== file || !validId.test(view.id)) fail("invalid_state", "Invalid resource ownership metadata.");
        if (kind === "terminals") {
          if (!["running", "exited", "interrupted"].includes(view.status) || !Number.isInteger(view.cols) || !Number.isInteger(view.rows) || view.cols < 1 || view.cols > 500 || view.rows < 1 || view.rows > 500 || !Number.isFinite(Date.parse(view.startedAt))) fail("invalid_state", "Invalid terminal metadata.");
          if (view.status === "running") { view.status = "interrupted"; view.finishedAt = new Date().toISOString(); this.save(id, kind, view.id, view); }
          this.terminalStates.set(view.id, { view, buffer: Buffer.alloc(0), offset: 0, done: Promise.resolve(), finish() {} });
        } else {
          try { this.validateService(view); } catch { fail("invalid_state", "Invalid persisted service definition."); }
          if (!["running", "restarting", "stopped", "failed", "interrupted"].includes(view.status) || !Array.isArray(view.history) || typeof view.stdout !== "string" || typeof view.stderr !== "string" || !Number.isSafeInteger(view.restartCount) || view.restartCount < 0 || !view.restart || view.history.length > 100 || !Number.isFinite(Date.parse(view.createdAt))) fail("invalid_state", "Invalid service metadata.");
          for (const attempt of view.history) {
            if (!attempt || !Number.isFinite(Date.parse(attempt.startedAt)) || (attempt.finishedAt !== undefined && !Number.isFinite(Date.parse(attempt.finishedAt))) || !(attempt.exitCode === null || Number.isInteger(attempt.exitCode))) fail("invalid_state", "Invalid service history.");
          }
          if (["running", "restarting"].includes(view.status)) { view.status = "interrupted"; view.finishedAt = new Date().toISOString(); this.save(id, kind, view.id, view); }
          this.serviceStates.set(view.id, { view });
        }
      }
    }
    this.pruneTerminals(id);
  }
  private term(id: string, terminalId: string): TerminalState {
    const state = this.terminalStates.get(terminalId);
    if (!state || state.view.sandboxId !== id) return fail("not_found", "Terminal not found.");
    return state;
  }
  private pruneTerminals(id: string) {
    const completed = [...this.terminalStates.values()].filter((s) => s.view.sandboxId === id && s.view.status !== "running");
    for (const state of completed.slice(0, Math.max(0, completed.length - this.options.maxHistory))) {
      rmSync(this.meta(id, "terminals", state.view.id), { force: true }); this.terminalStates.delete(state.view.id);
    }
  }
  openTerminal(id: string, input: TerminalInput = {}): TerminalSession {
    this.admit();
    if (!this.pty) return fail("unsupported", "PTY support is not enabled on this worker.");
    if ([...this.terminalStates.values()].filter((s) => s.view.status === "running").length >= this.maxTerminals) fail("capacity", "Terminal capacity reached.");
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid_input", "Invalid terminal options.");
    const cols = integer(input.cols ?? 80, 1, 500); const rows = integer(input.rows ?? 24, 1, 500);
    const cwd = this.cwd(id, input.cwd);
    const view: TerminalSession = { id: randomUUID(), sandboxId: id, status: "running", cols, rows, startedAt: new Date().toISOString(), exitCode: null };
    this.save(id, "terminals", view.id, view);
    let terminal!: Pty;
    try { terminal = this.pty.spawn(this.options.shell, ["--noprofile", "--norc", "-i"], { name: "xterm-256color", cwd, env: this.environment(id), cols, rows }); }
    catch {
      rmSync(this.meta(id, "terminals", view.id), { force: true });
      fail("unavailable", "PTY creation failed. Verify node-pty native bindings and its executable spawn-helper.");
    }
    let finish!: () => void;
    const done = new Promise<void>((resolveDone) => { finish = resolveDone; });
    const state: TerminalState = { view, buffer: Buffer.alloc(0), offset: 0, pty: terminal, done, finish };
    this.terminalStates.set(view.id, state);
    terminal.onData((data) => {
      state.buffer = Buffer.concat([state.buffer, Buffer.from(data)]);
      if (state.buffer.length > this.options.maxOutputBytes) {
        let drop = state.buffer.length - this.options.maxOutputBytes;
        while (drop < state.buffer.length && (state.buffer[drop] & 0xc0) === 0x80) drop++;
        state.offset += drop; state.buffer = Buffer.from(state.buffer.subarray(drop));
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(state.killTimer); this.kill(terminal.pid, "SIGKILL");
      view.exitCode = exitCode; if (view.status === "running") view.status = "exited";
      view.finishedAt = new Date().toISOString(); state.pty = undefined;
      this.persist(id, "terminals", view.id, view);
      try { this.pruneTerminals(id); } catch { this.fatal = new SandboxError("storage_error", "Cannot prune terminal history."); }
      finish();
    });
    return clone(view);
  }
  terminals(id: string) { return [...this.terminalStates.values()].filter((s) => s.view.sandboxId === id).map((s) => clone(s.view)); }
  terminal(id: string, terminalId: string, offset = 0): TerminalOutput {
    integer(offset, 0, Number.MAX_SAFE_INTEGER);
    const state = this.term(id, terminalId);
    const end = state.offset + state.buffer.length;
    if (offset > end) fail("invalid_input", "Terminal offset is beyond retained output.");
    let start = Math.max(offset, state.offset) - state.offset;
    while (start < state.buffer.length && (state.buffer[start] & 0xc0) === 0x80) start++;
    return { ...clone(state.view), data: decode(state.buffer.subarray(start)), startOffset: state.offset, offset: state.offset + start, nextOffset: end, truncated: offset < state.offset };
  }
  terminalInput(id: string, terminalId: string, data: string) {
    this.admit();
    if (typeof data !== "string" || Buffer.byteLength(data) > this.maxInput) fail("invalid_input", "Terminal input exceeds its limit.");
    const state = this.term(id, terminalId); if (!state.pty) fail("unavailable", "Terminal has exited."); state.pty!.write(data);
  }
  resizeTerminal(id: string, terminalId: string, cols: number, rows: number) {
    this.admit(); integer(cols, 1, 500); integer(rows, 1, 500);
    const state = this.term(id, terminalId); if (!state.pty) fail("unavailable", "Terminal has exited.");
    state.pty!.resize(cols, rows); state.view.cols = cols; state.view.rows = rows; this.save(id, "terminals", terminalId, state.view);
  }
  private kill(pid: number | undefined, signal: NodeJS.Signals) {
    if (!pid) return;
    try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.fatal = new SandboxError("unavailable", "Process group cleanup failed."); }
  }
  private async cleanupExitedGroup(pid: number | undefined) {
    if (!pid) return;
    try { process.kill(-pid, "SIGKILL"); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      if (process.platform === "darwin" && (error as NodeJS.ErrnoException).code === "EPERM") {
        // macOS can report EPERM while an exited shell's process group is being
        // reaped. Confirm disappearance; never reinterpret a live denied group
        // as success, and never send delayed signals to a potentially reused ID.
        for (let attempt = 0; attempt < 25; attempt++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          try { process.kill(-pid, 0); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") return;
            if ((probe as NodeJS.ErrnoException).code !== "EPERM") break;
          }
        }
      }
      this.fatal = new SandboxError("unavailable", "Process group cleanup failed.");
    }
  }
  async closeTerminal(id: string, terminalId: string, interrupt = false) {
    const state = this.term(id, terminalId);
    if (state.pty) {
      if (interrupt) state.view.status = "interrupted";
      const pid = state.pty.pid;
      state.pty.kill("SIGHUP");
      this.kill(pid, "SIGTERM");
      state.killTimer ??= setTimeout(() => { this.kill(pid, "SIGKILL"); state.pty?.kill("SIGKILL"); }, 250);
      await state.done;
    }
  }
  private validateService(input: ServiceInput) {
    if (!input || typeof input.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(input.name) || typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0") || Buffer.byteLength(input.command) > 65_536) fail("invalid_input", "Invalid service name or command.");
    if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.length > 4096 || input.cwd.includes("\0"))) fail("invalid_input", "Invalid service working directory.");
    if (input.restart !== undefined && (!input.restart || typeof input.restart !== "object" || Array.isArray(input.restart))) fail("invalid_input", "Invalid service restart policy.");
    if (input.restart) {
      if (!["never", "on-failure", "always"].includes(input.restart.policy)) fail("invalid_input", "Invalid service restart policy.");
      integer(input.restart.maxRestarts, 0, 1000); integer(input.restart.delayMs, 10, 60_000);
    }
  }
  private svc(id: string, serviceId: string): ServiceState {
    if (this.fatal) throw this.fatal;
    const state = this.serviceStates.get(serviceId);
    if (!state || state.view.sandboxId !== id) return fail("not_found", "Service not found.");
    return state;
  }
  startService(id: string, input: ServiceInput): SandboxService {
    this.admit(); this.validateService(input); this.cwd(id, input.cwd);
    if (this.serviceStates.size >= this.maxServices) fail("capacity", "Service definition capacity reached; remove unused definitions.");
    if ([...this.serviceStates.values()].some((s) => s.view.sandboxId === id && s.view.name === input.name)) fail("conflict", "Service name already exists in this workspace.");
    const view: SandboxService = { ...input, restart: clone(input.restart ?? { policy: "never", maxRestarts: 0, delayMs: 1000 }), id: randomUUID(), sandboxId: id, status: "running", restartCount: 0, stdout: "", stderr: "", truncated: false, createdAt: new Date().toISOString(), exitCode: null, history: [] };
    const state = { view }; this.save(id, "services", view.id, view); this.serviceStates.set(view.id, state); this.launch(state); return clone(view);
  }
  private launch(state: ServiceState) {
    this.admit(); const view = state.view;
    view.status = "running"; view.startedAt = new Date().toISOString(); delete view.finishedAt; view.exitCode = null;
    view.stdout = ""; view.stderr = ""; view.truncated = false;
    view.history.push({ startedAt: view.startedAt, exitCode: null }); view.history = view.history.slice(-Math.min(this.options.maxHistory, 100));
    this.save(view.sandboxId, "services", view.id, view);
    const child = spawn(this.options.shell, ["--noprofile", "--norc", "-c", view.command], { cwd: this.cwd(view.sandboxId, view.cwd), env: this.environment(view.sandboxId), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    state.child = child; state.stop = undefined;
    let finish!: () => void; state.done = new Promise<void>((done) => { finish = done; });
    const streams = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }; let captured = 0;
    const append = (key: "stdout" | "stderr", chunk: Buffer) => {
      const text = streams[key].write(chunk); const data = Buffer.from(text); const room = Math.max(0, this.options.maxOutputBytes - captured);
      view[key] += decode(data.subarray(0, room)); captured += Math.min(room, data.length); if (data.length > room) view.truncated = true;
    };
    child.stdout!.on("data", (data) => append("stdout", data)); child.stderr!.on("data", (data) => append("stderr", data));
    child.on("error", (error) => append("stderr", Buffer.from(error.message)));
    let cleanup = Promise.resolve();
    child.on("exit", () => { cleanup = this.cleanupExitedGroup(child.pid); });
    child.on("close", async (code) => {
      clearTimeout(state.killTimer);
      await cleanup;
      state.killTimer = undefined; state.child = undefined;
      view.exitCode = code; view.finishedAt = new Date().toISOString();
      Object.assign(view.history.at(-1)!, { finishedAt: view.finishedAt, exitCode: code });
      const retry = !this.closed && !state.stop && view.restartCount < view.restart.maxRestarts && (view.restart.policy === "always" || view.restart.policy === "on-failure" && code !== 0);
      if (retry) {
        view.status = "restarting"; view.restartCount++;
        state.timer = setTimeout(() => {
          state.timer = undefined;
          try { this.launch(state); } catch { view.status = "failed"; this.persist(view.sandboxId, "services", view.id, view); }
        }, view.restart.delayMs);
      } else view.status = state.stop ?? (code === 0 ? "stopped" : "failed");
      this.persist(view.sandboxId, "services", view.id, view); finish();
    });
  }
  services(id: string) { if (this.fatal) throw this.fatal; return [...this.serviceStates.values()].filter((s) => s.view.sandboxId === id).map((s) => clone(s.view)); }
  service(id: string, serviceId: string) { return clone(this.svc(id, serviceId).view); }
  private async stopServiceInternal(id: string, serviceId: string, interrupt = false): Promise<SandboxService> {
    const state = this.serviceStates.get(serviceId);
    if (!state || state.view.sandboxId !== id) return fail("not_found", "Service not found.");
    clearTimeout(state.timer); state.timer = undefined; state.stop = interrupt ? "interrupted" : "stopped";
    if (state.child) {
      const pid = state.child.pid; this.kill(pid, "SIGTERM");
      state.killTimer ??= setTimeout(() => this.kill(pid, "SIGKILL"), 250);
      await state.done;
    } else { state.view.status = state.stop; state.view.finishedAt = new Date().toISOString(); this.save(id, "services", serviceId, state.view); }
    return clone(state.view);
  }
  private async control<T>(serviceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.serviceControls.has(serviceId)) return fail("busy", "Service lifecycle operation already in progress.");
    this.serviceControls.add(serviceId);
    try { return await operation(); } finally { this.serviceControls.delete(serviceId); }
  }
  async stopService(id: string, serviceId: string) {
    return this.control(serviceId, () => this.stopServiceInternal(id, serviceId));
  }
  async restartService(id: string, serviceId: string) {
    return this.control(serviceId, async () => {
      this.admit(); const state = this.svc(id, serviceId); await this.stopServiceInternal(id, serviceId);
      this.admit(); state.view.restartCount = 0; this.launch(state); return clone(state.view);
    });
  }
  async removeService(id: string, serviceId: string) {
    return this.control(serviceId, async () => {
      this.admit(); const state = this.svc(id, serviceId); await this.stopServiceInternal(id, serviceId);
      rmSync(this.meta(id, "services", serviceId)); this.serviceStates.delete(state.view.id);
    });
  }
  forget(id: string) {
    for (const [key, state] of this.terminalStates) if (state.view.sandboxId === id) this.terminalStates.delete(key);
    for (const [key, state] of this.serviceStates) if (state.view.sandboxId === id) this.serviceStates.delete(key);
  }
  busy(id: string) { return [...this.terminalStates.values()].some((s) => s.view.sandboxId === id && s.pty) || [...this.serviceStates.values()].some((s) => s.view.sandboxId === id && (s.child || s.timer || this.serviceControls.has(s.view.id))); }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([
      ...[...this.terminalStates.values()].filter((s) => s.pty).map((s) => this.closeTerminal(s.view.sandboxId, s.view.id, true)),
      ...[...this.serviceStates.values()].filter((s) => s.child || s.timer).map((s) => this.stopServiceInternal(s.view.sandboxId, s.view.id, true)),
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}
