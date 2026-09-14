import { validateInput } from "./session.js";
import { randomUUID } from "node:crypto";
import { BrowserUseError, type BrowserAdapter, type BrowserSession } from "./browser.js";

export type BrowserAction = "navigate" | "evaluate" | "click" | "type" | "press" | "screenshot";
export interface BrowserHandle { id: string; backend: string }

export class BrowserSessionManager {
  private readonly sessions = new Map<string, { browser: BrowserSession; busy: boolean }>();
  private opening = 0;
  private closed = false;
  private readonly openings = new Set<Promise<BrowserHandle>>();
  private readonly closings = new Set<Promise<void>>();
  private closing?: Promise<void>;
  constructor(readonly adapter: BrowserAdapter, private readonly maxSessions = 4) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new BrowserUseError("invalid_input", "maxSessions must be a positive integer.");
  }
  open(): Promise<BrowserHandle> {
    const opening = this.openSession();
    this.openings.add(opening);
    void opening.finally(() => this.openings.delete(opening)).catch(() => undefined);
    return opening;
  }
  private async openSession(): Promise<BrowserHandle> {
    if (this.closed) throw new BrowserUseError("unavailable", "Browser worker is closing.");
    if (this.sessions.size + this.opening + this.closings.size >= this.maxSessions) throw new BrowserUseError("capacity", "Browser session capacity reached.");
    this.opening++;
    try {
      const browser = await this.adapter.open();
      if (this.closed) { await browser.close(); throw new BrowserUseError("unavailable", "Browser worker is closing."); }
      const id = randomUUID();
      this.sessions.set(id, { browser, busy: false });
      return { id, backend: this.adapter.name };
    } finally { this.opening--; }
  }
  list(): BrowserHandle[] { return [...this.sessions.keys()].map((id) => ({ id, backend: this.adapter.name })); }
  async perform(id: string, action: BrowserAction, value?: string): Promise<unknown> {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserUseError("not_found", "Browser session not found.");
    if (session.busy) throw new BrowserUseError("busy", "Browser session has an operation in progress.");
    if (action !== "screenshot") validateInput(value!);
    session.busy = true;
    try {
      switch (action) {
        case "navigate": await session.browser.navigate(value!); return null;
        case "evaluate": return await session.browser.evaluate(value!);
        case "click": await session.browser.click(value!); return null;
        case "type": await session.browser.type(value!); return null;
        case "press": await session.browser.press(value!); return null;
        case "screenshot": return { mimeType: "image/png", base64: Buffer.from(await session.browser.screenshot()).toString("base64") };
        default: throw new BrowserUseError("invalid_input", "Unknown browser action.");
      }
    } finally { session.busy = false; }
  }
  async closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserUseError("not_found", "Browser session not found.");
    this.sessions.delete(id);
    const closing = Promise.resolve().then(() => session.browser.close());
    this.closings.add(closing);
    try { await closing; } finally { this.closings.delete(closing); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([
        ...this.openings, ...this.closings,
        ...[...this.sessions.keys()].map((id) => this.closeSession(id)),
      ]);
      // Opening requests reject when shutdown wins the race; they close their own browser.
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected" && !(result.reason instanceof BrowserUseError && result.reason.code === "unavailable"));
      if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Browser shutdown failed.");
    })();
    return this.closing;
  }
}
