import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = resolve(packageRoot, ".next/standalone/node_modules/.pnpm");

let entries = [];
try {
  entries = await readdir(pnpmDir);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

// Next treats sharp as optional and this dashboard does not use next/image.
// Prune native artifacts so a package built on macOS does not publish a
// Darwin-only binary (and likewise for Linux/Windows release machines).
const nativeImagePackages = entries.filter(
  (name) => name.startsWith("sharp@") || name.startsWith("@img+sharp-"),
);

await Promise.all(
  nativeImagePackages.map((name) => rm(resolve(pnpmDir, name), { recursive: true, force: true })),
);
