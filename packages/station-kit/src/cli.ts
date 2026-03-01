#!/usr/bin/env node

// Station CLI launcher — re-executes itself with tsx loader so user .ts files
// (signals, broadcasts, configs) can be imported with full resolution.

import { execPath } from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "__STATION_TSX_LOADED";

if (!process.env[MARKER]) {
  // Resolve tsx from station-kit's own dependencies (not the user's project)
  const require = createRequire(import.meta.url);
  let tsxSpecifier: string;
  try {
    const tsxEntry = require.resolve("tsx");
    tsxSpecifier = pathToFileURL(tsxEntry).href;
  } catch {
    // Fallback: bare specifier (user may have tsx installed)
    tsxSpecifier = "tsx";
  }

  const main = fileURLToPath(new URL("./cli-main.js", import.meta.url));
  const child = spawn(execPath, ["--import", tsxSpecifier, main], {
    stdio: "inherit",
    env: { ...process.env, [MARKER]: "1" },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error("[station] Failed to start:", err.message);
    process.exit(1);
  });
} else {
  // Already loaded with tsx — import main
  await import("./cli-main.js");
}
