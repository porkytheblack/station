import { BrowserUseError, type BrowserSession } from "./browser.js";

export function validateTimeout(timeout: number): number {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new BrowserUseError("invalid_input", "Browser timeout must be between 1 and 120000 milliseconds.");
  }
  return timeout;
}

export function validateInput(value: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value) > 65_536) {
    throw new BrowserUseError("invalid_input", "Browser action requires a string up to 64 KiB.");
  }
}

/** Serialize backend operations; close interrupts pending work rather than queuing behind it. */
export function managedSession(browser: BrowserSession, timeoutMs: number): BrowserSession {
  let closed = false;
  let closing: Promise<void> | undefined;
  let queue = Promise.resolve<unknown>(undefined);
  let queued = 0;
  const cancellation = new Set<(error: Error) => void>();
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    for (const reject of cancellation) reject(new BrowserUseError("browser_closed", "Browser session is closed."));
    closing = Promise.resolve().then(() => browser.close());
    return closing;
  };
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new BrowserUseError("browser_closed", "Browser session is closed."));
    if (queued >= 64) return Promise.reject(new BrowserUseError("busy", "Browser operation queue is full."));
    queued++;
    const result = queue.then(async () => {
      if (closed) throw new BrowserUseError("browser_closed", "Browser session is closed.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel!: (error: Error) => void;
      const interrupted = new Promise<never>((_, reject) => {
        cancel = reject;
        cancellation.add(cancel);
        timer = setTimeout(() => {
          reject(new BrowserUseError("browser_timeout", "Browser operation timed out; session was closed."));
          void close().catch(() => undefined);
        }, timeoutMs);
      });
      try { return await Promise.race([Promise.resolve().then(operation), interrupted]); }
      finally { clearTimeout(timer); cancellation.delete(cancel); }
    });
    queue = result.catch(() => undefined);
    return result.finally(() => { queued--; });
  };
  const text = (value: string, operation: () => Promise<void>) => run(async () => { validateInput(value); await operation(); });
  return {
    ...(browser.execute ? { execute: (command: import("./commands.js").BrowserCommand) => run(() => browser.execute!(command)) } : {}),
    navigate: (value) => text(value, () => browser.navigate(value)),
    click: (value) => text(value, () => browser.click(value)),
    type: (value) => text(value, () => browser.type(value)),
    press: (value) => text(value, () => browser.press(value)),
    evaluate: (value) => run(async () => {
      validateInput(value);
      const result = await browser.evaluate(value);
      // Both backends expose JSON values; undefined is represented as null on the wire.
      const json = JSON.stringify(result ?? null);
      if (json === undefined) return null;
      if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new BrowserUseError("output_limit", "Browser response exceeds 32 MiB.");
      return JSON.parse(json);
    }),
    screenshot: () => run(async () => {
      const result = await browser.screenshot();
      if (result.byteLength > 24 * 1024 * 1024) throw new BrowserUseError("output_limit", "Browser screenshot exceeds 24 MiB.");
      return result;
    }),
    close,
  };
}
