import { defineConfig } from "station-kit";
import { BrowserSessionManager } from "station-browser-use";
import { BunBrowserAdapter } from "station-browser-use/bun";
import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";
import { shared, required } from "./shared.js";

const adapter = process.env.BROWSER_BACKEND === "bun"
  ? new BunBrowserAdapter({ bunPath: process.env.BUN_PATH, chromePath: process.env.CHROME_PATH, backend: "chrome" })
  : new PlaywrightBrowserAdapter({ executablePath: process.env.CHROME_PATH, profileRootDir: process.env.BROWSER_PROFILE_ROOT ?? ".station/browser/profiles" });

export default defineConfig({
  ...shared("browser", 5702), role: "station",
  execution: { token: required("STATION_EXECUTION_TOKEN"), browser: new BrowserSessionManager(adapter, 3, { recordingRootDir: process.env.BROWSER_RECORDING_ROOT ?? ".station/browser/recordings" }) },
});
