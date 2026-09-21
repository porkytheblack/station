// Explicit opt-in only. Never included by test/*.test.ts or the release preflight.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrowserbaseBrowserAdapter, SteelBrowserAdapter } from "../dist/remote.js";
import { BrowserSessionManager } from "../dist/manager.js";

if (process.env.STATION_ALLOW_PAID_BROWSER !== "1") throw new Error("Set STATION_ALLOW_PAID_BROWSER=1 to authorize one provider session (provider charges may apply).");
const provider = process.env.STATION_BROWSER_PROVIDER;
if (provider !== "browserbase" && provider !== "steel") throw new Error("Select STATION_BROWSER_PROVIDER=browserbase or steel.");
const prefix = provider === "browserbase" ? "BROWSERBASE" : "STEEL";
const apiKey = process.env[`${prefix}_API_KEY`], projectId = process.env[`${prefix}_PROJECT_ID`];
if (!apiKey || !projectId) throw new Error(`Set ${prefix}_API_KEY and ${prefix}_PROJECT_ID.`);
const root = resolve(process.env.STATION_BROWSER_SMOKE_ROOT ?? `.station/provider-smoke/${provider}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
const profile = process.env.STATION_PROVIDER_PROFILE_ID;
const common = { apiKey, projectId, rootDir: resolve(root, "controller"), sessionTimeoutMs: 60000,
  ...(profile ? { profiles: { smoke: profile } } : {}), reliability: { minIntervalMs: 0 } };
const adapter = provider === "browserbase" ? new BrowserbaseBrowserAdapter(common) : new SteelBrowserAdapter(common);
const manager = new BrowserSessionManager(adapter, 1);
try {
  const session = await manager.open(profile ? { profileId: "smoke" } : {});
  await manager.perform(session.id, "navigate", "https://example.com");
  const screenshot = await manager.perform(session.id, "screenshot") as { base64: string };
  const path = resolve(root, "example.png"); writeFileSync(path, Buffer.from(screenshot.base64, "base64"), { mode: 0o600 });
  console.log(`PASS: ${provider} navigation and screenshot; artifact: ${path}`);
} finally { await manager.close(); }
