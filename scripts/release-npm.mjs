#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

// Dependencies are released before the packages that reference them. Keep
// this explicit: release order is operational policy, not an incidental
// filesystem or workspace traversal order.
const releaseOrder = [
  "station-signal",
  "station-expressions",
  "station-env",
  "station-network",
  "station-schedules",
  "station-broadcast",
  "station-beacon",
  "station-adapter-sqlite",
  "station-adapter-postgres",
  "station-adapter-mysql",
  "station-adapter-redis",
  "station-kit",
  "station-tauri",
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const resume = args.has("--resume");
const allowDirty = args.has("--allow-dirty");
const skipChecks = args.has("--skip-checks");
const help = args.has("--help") || args.has("-h");
const knownFlags = new Set(["--", "--dry-run", "--resume", "--allow-dirty", "--skip-checks", "--help", "-h", "--tag"]);

function valueAfter(flag, fallback) {
  const values = process.argv.slice(2);
  const index = values.indexOf(flag);
  if (index === -1) return fallback;
  const value = values[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
  return value;
}

const tag = valueAfter("--tag", "latest");

for (const [index, arg] of process.argv.slice(2).entries()) {
  if (index > 0 && process.argv.slice(2)[index - 1] === "--tag") continue;
  if (!knownFlags.has(arg)) fail(`Unknown option: ${arg}`);
}

if (help) {
  console.log(`Publish every Station package to npm in dependency order.

Usage:
  pnpm release:npm
  pnpm release:npm:dry-run
  pnpm release:npm -- --resume
  pnpm release:npm -- --tag next

Options:
  --dry-run      Build and run npm publish dry-runs without uploading
  --resume       Skip exact package versions already present on npm
  --tag <tag>    Publish under an npm dist-tag (default: latest)
  --allow-dirty  Permit a dirty worktree (intended for local dry-run QA)
  --skip-checks  Skip the workspace typecheck and test preflight
`);
  process.exit(0);
}

function fail(message) {
  console.error(`\n[release] ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const printable = [command, ...commandArgs].join(" ");
  console.log(`\n[release] $ ${printable}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) fail(`${printable} could not start: ${result.error.message}`);
  if (!options.allowFailure && result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    fail(`${printable} failed with exit code ${result.status}.`);
  }
  return result;
}

function readPackage(name) {
  const packageDir = resolve(root, "packages", name);
  const manifestPath = resolve(packageDir, "package.json");
  if (!existsSync(manifestPath)) fail(`Missing manifest for ${name}.`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== name) fail(`${manifestPath} declares ${manifest.name}, expected ${name}.`);
  if (manifest.private) fail(`${name} is private and cannot be released.`);
  if (manifest.license !== "MIT") fail(`${name} must declare its MIT license before release.`);
  if (!existsSync(resolve(packageDir, "LICENSE"))) fail(`${name} is missing LICENSE.`);
  if (!existsSync(resolve(packageDir, "README.md"))) fail(`${name} is missing README.md.`);
  return { name, version: manifest.version };
}

function publishedVersion(name, version) {
  const result = run("npm", ["view", `${name}@${version}`, "version", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) return true;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/E404|404 Not Found|is not in this registry/i.test(output)) return false;
  process.stderr.write(output);
  fail(`Could not determine whether ${name}@${version} is already published.`);
}

if (!allowDirty) {
  const status = run("git", ["status", "--porcelain", "--untracked-files=normal"], { capture: true });
  if (status.stdout.trim()) {
    fail("The worktree is dirty. Commit the release first, or use --allow-dirty only for local dry-run QA.");
  }
}

if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tag)) fail(`Invalid npm dist-tag: ${tag}`);

const packages = releaseOrder.map(readPackage);
const versions = new Set(packages.map((item) => item.version));
if (versions.size !== 1) {
  fail(`Every public Station package must share one version. Found: ${[...versions].join(", ")}`);
}
const version = packages[0].version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`Invalid release version: ${version}`);

console.log(`[release] Station ${version} -> npm tag "${tag}"${dryRun ? " (dry run)" : ""}`);

const alreadyPublished = new Set();
for (const item of packages) {
  const published = publishedVersion(item.name, item.version);
  if (!published) {
    console.log(`[release] available: ${item.name}@${item.version}`);
    continue;
  }
  if (!resume) {
    fail(`${item.name}@${item.version} is already on npm. Bump every package version, or rerun with --resume after a partial release.`);
  }
  alreadyPublished.add(item.name);
  console.log(`[release] resume: skipping ${item.name}@${item.version} (already published)`);
}

if (!dryRun) run("npm", ["whoami"]);

if (!skipChecks) {
  run("pnpm", ["typecheck"]);
  run("pnpm", ["test"]);
}

for (const item of packages) {
  if (alreadyPublished.has(item.name)) continue;
  console.log(`\n[release] === ${item.name}@${item.version} ===`);
  run("pnpm", ["--filter", item.name, "build"]);
  const publishArgs = [
    "--filter", item.name,
    "publish",
    "--access", "public",
    "--tag", tag,
    "--no-git-checks",
  ];
  if (dryRun) publishArgs.push("--dry-run");
  run("pnpm", publishArgs);
}

console.log(`\n[release] ${dryRun ? "Dry run complete" : "Published"}: Station ${version}`);
