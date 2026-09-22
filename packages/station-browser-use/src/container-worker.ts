/** Immutable image entry point. stdin/stdout are reserved for bounded JSONL RPC. */
import { createInterface } from "node:readline";
import { rmSync } from "node:fs";
import { PlaywrightBrowserAdapter } from "./playwright.js";
import { BrowserUseError, type BrowserSession } from "./browser.js";
import { validateBrowserOpenOptions } from "./commands.js";
let session: BrowserSession | undefined;
let closing = false;
const respond = (value: unknown) => { const json = JSON.stringify(value); if (Buffer.byteLength(json) > 34 * 1024 * 1024) throw new BrowserUseError("output_limit", "Browser response exceeds transport limits."); process.stdout.write(json + "\n"); };
async function close() { if (closing) return; closing = true; await session?.close(); }
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close().finally(() => process.exit()); });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("close", () => { void close().finally(() => process.exit()); });
// The parent serializes operations; close is intentionally allowed to interrupt one.
lines.on("line", (line) => { void (async () => {
  let id: unknown;
  try {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new BrowserUseError("invalid_input", "Browser request exceeds transport limits.");
    const message = JSON.parse(line); id = message.id;
    if (!Number.isSafeInteger(id)) throw new BrowserUseError("invalid_input", "Invalid request identifier.");
    let result: unknown = null;
    if (message.op === "open") {
      if (session || closing) throw new BrowserUseError("busy", "Browser already initialized.");
      const options = validateBrowserOpenOptions(message.options);
      // Host holds the exclusive volume lock and reconciles its old container first.
      // PIDs and hostnames inside a replacement container cannot identify old owners.
      if (options.profileId) for (const name of [".station-owner.json", ".station-recovery", "SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(`/home/node/profiles/default/${name}`, { recursive: true, force: true });
      const adapter = new PlaywrightBrowserAdapter({ ...message.settings, ...(options.profileId ? { profileRootDir: "/home/node/profiles" } : {}) });
      session = await adapter.open({ ...options, ...(options.profileId ? { profileId: "default" } : {}) });
    } else if (message.op === "close") { await close(); }
    else {
      if (!session || closing) throw new BrowserUseError("unavailable", "Browser is unavailable.");
      if (message.humanControl !== undefined && typeof message.humanControl !== "boolean") throw new BrowserUseError("invalid_input", "Invalid control context.");
      session.setHumanControl?.(message.humanControl === true);
      try { switch (message.op) {
        case "navigate": await session.navigate(message.value); break;
        case "click": await session.click(message.value); break;
        case "type": await session.type(message.value); break;
        case "press": await session.press(message.value); break;
        case "evaluate": result = await session.evaluate(message.value); break;
        case "screenshot": result = Buffer.from(await session.screenshot()).toString("base64"); break;
        case "execute": result = await session.execute!(message.value); break;
        default: throw new BrowserUseError("invalid_input", "Unknown browser operation.");
      } } finally { session.setHumanControl?.(false); }
    }
    respond({ id, result });
  } catch (error) { respond({ id, error: { code: error instanceof BrowserUseError ? error.code : "unavailable", message: error instanceof BrowserUseError ? error.message : "Container browser operation failed." } }); }
})().catch(() => { void close().finally(() => process.exit(1)); }); });
