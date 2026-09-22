import type { BrowserContext, Page } from "playwright";
import { mkdirSync, readdirSync, lstatSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserArtifact, BrowserDiagnostic, BrowserDiagnostics, BrowserTraceState } from "./commands.js";
import { BrowserUseError } from "./browser.js";
const safeUrl = (input: string): string => { try { const url = new URL(input); return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) ? (url.origin + url.pathname).slice(0, 2048) : url.protocol; } catch { return "invalid-url"; } };
const consoleMessage = (input: string) => Buffer.from(input.slice(0, 2048)).subarray(0, 2048).toString("utf8").replace(/\uFFFD$/, "").replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, safeUrl);
function diskBytes(root: string): number {
  let count = 0; let bytes = 0;
  const walk = (path: string) => { for (const name of readdirSync(path)) { if (++count > 10000) throw new Error("Trace file count exceeded"); const next = join(path, name); let entry; try { entry = lstatSync(next); } catch (reason) { if ((reason as NodeJS.ErrnoException).code === "ENOENT") continue; throw reason; } if (entry.isSymbolicLink()) throw new Error("Trace link rejected"); if (entry.isDirectory()) walk(next); else bytes += entry.size; } };
  walk(root); return bytes;
}
/** Bounded observability and one-shot dialog policies. Console body capture is opt-in. */
export class PlaywrightTools {
  private events: BrowserDiagnostic[] = [];
  private consoleText = false;
  private trace: BrowserTraceState = { status: "idle" };
  private traceGuard?: ReturnType<typeof setInterval>;
  private stopping?: Promise<void>;
  private readonly dialogs = new Map<Page, { action: "accept" | "dismiss"; promptText?: string; expires: number }>();
  constructor(private readonly context: BrowserContext, private readonly traceRoot: string, private readonly remaining: () => number, private readonly capacity: () => void, private readonly artifact: (bytes: Buffer, name: string, mime: string) => BrowserArtifact) {}
  private event(value: Omit<BrowserDiagnostic, "at">) { this.events.push({ at: new Date().toISOString(), ...value }); if (this.events.length > 200) this.events.splice(0, this.events.length - 200); }
  register(page: Page) {
    page.on("console", (message) => this.event({ kind: "console", level: message.type().slice(0, 32), ...(this.consoleText ? { message: consoleMessage(message.text()) } : {}) }));
    page.on("request", (request) => this.event({ kind: "request", method: request.method().slice(0, 16), url: safeUrl(request.url()) }));
    page.on("response", (response) => this.event({ kind: "response", status: response.status(), url: safeUrl(response.url()) }));
    page.on("requestfailed", (request) => this.event({ kind: "requestfailed", method: request.method().slice(0, 16), url: safeUrl(request.url()) }));
    page.on("dialog", (dialog) => {
      const armed = this.dialogs.get(page); this.dialogs.delete(page);
      const policy = armed && armed.expires >= Date.now() ? armed : { action: "dismiss" as const };
      this.event({ kind: "dialog", level: dialog.type(), action: policy.action });
      void (policy.action === "accept" ? dialog.accept(dialog.type() === "prompt" ? policy.promptText : undefined) : dialog.dismiss()).catch(() => undefined);
    });
    page.once("close", () => this.dialogs.delete(page));
  }
  dialog(page: Page, action: "accept" | "dismiss", promptText?: string, expiresInMs = 10000) {
    const expires = Date.now() + expiresInMs;
    this.dialogs.set(page, { action, promptText, expires }); return { armed: true, expiresAt: new Date(expires).toISOString() };
  }
  diagnostics(options: { consoleText?: boolean; clear?: boolean }): BrowserDiagnostics {
    if (options.clear) this.events = [];
    if (options.consoleText !== undefined) { this.consoleText = options.consoleText; if (!this.consoleText) for (const event of this.events) if (event.kind === "console") delete event.message; }
    return { events: this.events.map((event) => ({ ...event })), consoleText: this.consoleText, trace: { ...this.trace } };
  }
  async traceStart(): Promise<BrowserTraceState> {
    if (this.trace.status === "recording" || this.stopping) throw new BrowserUseError("busy", "A browser trace is already active or stopping.");
    this.capacity(); rmSync(this.traceRoot, { recursive: true, force: true }); mkdirSync(this.traceRoot, { recursive: true, mode: 0o700 });
    try { await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false }); }
    catch (reason) { this.trace = { status: "error", stoppedAt: new Date().toISOString() }; await this.context.close().catch(() => undefined); throw reason; }
    this.trace = { status: "recording", startedAt: new Date().toISOString() };
    const started = Date.now();
    this.traceGuard = setInterval(() => {
      try { if (Date.now() - started >= 60000 || diskBytes(this.traceRoot) > this.remaining()) this.abortTrace("limit"); }
      catch { this.abortTrace("error"); }
    }, 50);
    this.traceGuard.unref?.(); return { ...this.trace };
  }
  private abortTrace(status: "limit" | "error") {
    if (this.trace.status !== "recording") return;
    clearInterval(this.traceGuard); this.traceGuard = undefined;
    this.trace.status = status; this.trace.stoppedAt = new Date().toISOString();
    this.stopping = this.context.tracing.stop().catch(async () => { await this.context.close().catch(() => undefined); }).finally(() => { rmSync(this.traceRoot, { recursive: true, force: true }); this.stopping = undefined; });
    void this.stopping.catch(() => undefined);
  }
  async traceStop(): Promise<BrowserArtifact> {
    if (this.stopping) await this.stopping;
    if (this.trace.status === "limit") throw new BrowserUseError("output_limit", "Trace exceeded its byte or 60-second duration limit.");
    if (this.trace.status !== "recording") throw new BrowserUseError("invalid_state", "No active browser trace.");
    clearInterval(this.traceGuard); this.traceGuard = undefined;
    const path = join(this.traceRoot, "export.zip"); let stopped = false;
    try {
      await this.context.tracing.stop({ path }); stopped = true;
      const size = lstatSync(path).size;
      if (size > this.remaining()) { this.trace.status = "limit"; throw new BrowserUseError("output_limit", "Trace exceeds session artifact budget."); }
      const artifact = this.artifact(readFileSync(path), "browser-trace.zip", "application/zip");
      this.trace.status = "stopped"; return artifact;
    } catch (reason) { if (!stopped) await this.context.close().catch(() => undefined); if (this.trace.status !== "limit") this.trace.status = "error"; throw reason; }
    finally { this.trace.stoppedAt = new Date().toISOString(); rmSync(this.traceRoot, { recursive: true, force: true }); }
  }
  async close(): Promise<void> { this.events = []; this.consoleText = false; this.dialogs.clear(); clearInterval(this.traceGuard); this.abortTrace("error"); await this.stopping; }
}
