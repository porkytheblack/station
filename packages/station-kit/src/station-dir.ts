import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export interface StationDirs {
  baseDir: string;
  dataDir: string;
  outDir: string;
}

export function ensureStationDir(cwd: string, stationDir: string): StationDirs {
  const baseDir = resolve(cwd, stationDir);
  const dataDir = join(baseDir, "data");
  const outDir = join(baseDir, "out");

  mkdirSync(dataDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const gitignorePath = join(baseDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "data/\n");
  }

  return { baseDir, dataDir, outDir };
}
