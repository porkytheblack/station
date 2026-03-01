import { loadConfig } from "./config/loader.js";
import { createStation } from "./server/index.js";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const cwd = process.cwd();
const config = await loadConfig(cwd);

// Spawn Next.js standalone server for the dashboard
const pkgRoot = resolve(import.meta.dirname, "..");
const nextServer = resolve(pkgRoot, ".next/standalone/packages/station-kit/server.js");
const nextPort = config.port + 1;

let nextProcess: ChildProcess | undefined;

if (existsSync(nextServer)) {
  nextProcess = spawn(process.execPath, [nextServer], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: String(nextPort), HOSTNAME: "127.0.0.1" },
  });

  let stderrBuf = "";
  nextProcess.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });
  nextProcess.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[station] Next.js exited with code ${code}`);
      if (stderrBuf) console.error(stderrBuf);
    }
  });

  // Wait for Next.js to be ready
  const ready = await new Promise<boolean>((res) => {
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        await fetch(`http://127.0.0.1:${nextPort}/`);
        clearInterval(poll);
        res(true);
      } catch {
        if (attempts > 50) {
          clearInterval(poll);
          console.error("[station] Next.js did not respond after 5s.");
          if (stderrBuf) console.error(stderrBuf);
          res(false);
        }
      }
    }, 100);
  });

  if (!ready) {
    nextProcess.kill();
    process.exit(1);
  }
} else {
  console.warn("[station] Dashboard not built — run 'pnpm build' in station-kit.");
}

const station = await createStation(config, cwd, nextProcess ? nextPort : undefined);
await station.start();

// Open browser
if (config.open) {
  const url = `http://${config.host}:${config.port}`;
  const { execFile } = await import("node:child_process");
  const platform = process.platform;

  await new Promise((res) => setTimeout(() => res(true), 2000));
  if (platform === "darwin") {
    execFile("open", [url]);
  } else if (platform === "linux") {
    execFile("xdg-open", [url]);
  } else if (platform === "win32") {
    execFile("cmd", ["/c", "start", url]);
  }
}

// Graceful shutdown
const shutdown = async () => {
  console.log("\n[station] Shutting down...");
  await station.stop();
  nextProcess?.kill();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
