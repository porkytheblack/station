import { validateBrowserOpenOptions, type BrowserOpenOptions } from "./commands.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { managedSession, validateTimeout } from "./session.js";
import { fileURLToPath } from "node:url";
import { BrowserAdapter, BrowserSession, BrowserUseError } from "./browser.js";

export interface BunBrowserOptions {
  bunPath?: string;
  chromePath?: string;
  backend?: "chrome" | "webkit";
  width?: number;
  height?: number;
  operationTimeoutMs?: number;
}

export class BunBrowserAdapter implements BrowserAdapter {
  readonly name = "bun-webview";
  readonly capabilities = { screenshots: true, independentSessions: true, isolated: false, networkRestricted: false, profiles: false, pages: false, commands: false, uploads: false, downloads: false, pointer: false, inspection: false, locators: false, dialogs: false, diagnostics: false, tracing: false } as const;
  constructor(private readonly options: BunBrowserOptions = {}) {}

  async open(input: BrowserOpenOptions = {}): Promise<BrowserSession> {
    const options = validateBrowserOpenOptions(input);
    if (options.profileId) throw new BrowserUseError("unsupported", "Bun persistent profiles are not implemented by this adapter.");
    const timeoutMs = validateTimeout(this.options.operationTimeoutMs ?? 30_000);
    for (const dimension of [this.options.width ?? 1280, this.options.height ?? 720]) {
      if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096) throw new BrowserUseError("invalid_input", "Viewport dimensions must be between 1 and 4096.");
    }
    if (this.options.backend && !["chrome", "webkit"].includes(this.options.backend)) throw new BrowserUseError("invalid_input", "Unknown Bun browser backend.");
    const builtWorker = fileURLToPath(new URL("./bun-worker.js", import.meta.url));
    const worker = existsSync(builtWorker) ? builtWorker : fileURLToPath(new URL("./bun-worker.ts", import.meta.url));
    const child = spawn(this.options.bunPath ?? "bun", [worker], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Do not expose Station/database/API credentials to browser subprocesses.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    });
    let exited = false;
    const exit = new Promise<void>((resolve) => child.once("close", () => { exited = true; resolve(); }));
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Process already exited. */ }
    };
    let shutdown: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      if (shutdown) return shutdown;
      shutdown = (async () => {
        if (!exited) {
          kill("SIGTERM");
          const timer = setTimeout(() => kill("SIGKILL"), 1000);
          try { await exit; } finally { clearTimeout(timer); }
        }
        kill("SIGKILL"); // Clean descendants in the owned POSIX process group.
      })();
      return shutdown;
    };
    let sequence = 0;
    let closed = false;
    let output = "";
    let diagnostic = "";
    let queue = Promise.resolve<unknown>(undefined);
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    const fail = (error: Error) => {
      closed = true;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
    };
    child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
    child.on("error", (error) => { fail(error); void terminate(); });
    child.stdin.on("error", (error) => { fail(error); void terminate(); });
    child.on("exit", () => { fail(new BrowserUseError("browser_closed", `Bun browser exited. ${diagnostic}`)); void terminate(); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 32 * 1024 * 1024) { fail(new BrowserUseError("output_limit", "Browser response exceeds 32 MB.")); void terminate(); return; }
      let end: number;
      while ((end = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try {
          const response = JSON.parse(line);
          const request = pending.get(response.id);
          if (!request) continue;
          pending.delete(response.id); clearTimeout(request.timer);
          if (response.error) request.reject(new BrowserUseError("browser_error", response.error));
          else request.resolve(response.value);
        } catch { fail(new BrowserUseError("browser_protocol", "Invalid response from Bun browser.")); void terminate(); }
      }
    });
    const request = (method: string, argument?: unknown): Promise<unknown> => {
      const run = queue.then(() => {
        if (closed) throw new BrowserUseError("browser_closed", "Browser session is closed.");
        return new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            fail(new BrowserUseError("browser_timeout", "Browser operation timed out; session was closed."));
            void terminate();
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          child.stdin.write(JSON.stringify({ id, method, argument }) + "\n");
        });
      });
      queue = run.catch(() => undefined);
      return run;
    };
    const close = async () => {
      fail(new BrowserUseError("browser_closed", "Browser session is closed."));
      await terminate();
    };
    try {
      await request("open", {
        backend: this.options.backend === "webkit" ? "webkit" : { type: "chrome", url: false, ...(this.options.chromePath ? { path: this.options.chromePath } : {}) },
        width: options.viewport?.width ?? this.options.width ?? 1280,
        height: options.viewport?.height ?? this.options.height ?? 720,
      });
    } catch (error) { fail(error as Error); await terminate(); throw error; }
    return managedSession({
      navigate: async (url) => { await request("navigate", url); },
      evaluate: (script) => request("evaluate", script),
      click: async (selector) => { await request("click", selector); },
      type: async (text) => { await request("type", text); },
      press: async (key) => { await request("press", key); },
      screenshot: async () => Buffer.from(await request("screenshot") as string, "base64"),
      close,
    }, timeoutMs);
  }
}
