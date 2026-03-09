import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveConfig, type StationConfig } from "./schema.js";

const CONFIG_NAMES = [
  "station.config.ts",
  "station.config.js",
  "station.config.mjs",
];

export async function loadConfig(cwd: string, configFile?: string): Promise<StationConfig> {
  const configPath = configFile ? resolve(cwd, configFile) : findConfigFile(cwd);

  if (!configPath || !existsSync(configPath)) {
    if (configFile) {
      console.error(`[station] Config file not found: ${configFile}`);
      process.exit(1);
    }
    console.log("[station] No config file found. Using defaults.");
    return resolveConfig({});
  }

  console.log(`[station] Loading ${configPath}`);

  const mod = await import(pathToFileURL(resolve(configPath)).href);
  const raw = mod.default ?? mod;
  return resolveConfig(raw);
}

function findConfigFile(cwd: string): string | null {
  for (const name of CONFIG_NAMES) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
