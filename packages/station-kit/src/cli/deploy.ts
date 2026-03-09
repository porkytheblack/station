import {
  writeFileSync,
  readFileSync,
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { loadConfig } from "../config/loader.js";
import { ensureStationDir } from "../station-dir.js";

const cwd = process.cwd();

// Ensure .station/data exists before loading config — adapter constructors may open DBs
const defaultStationDir = ".station";
mkdirSync(join(cwd, defaultStationDir, "data"), { recursive: true });

const config = await loadConfig(cwd);
const { outDir } = ensureStationDir(cwd, config.stationDir);

// ── Workspace resolution ────────────────────────────────────

function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.workspaces) return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveWorkspaceVersion(depName: string, startDir: string): string | null {
  const root = findWorkspaceRoot(startDir);
  if (!root) return null;
  const candidate = join(root, "packages", depName, "package.json");
  if (!existsSync(candidate)) return null;
  try {
    const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// ── Production package.json ─────────────────────────────────

interface PkgJson {
  name?: string;
  version?: string;
  type?: string;
  private?: boolean;
  description?: string;
  license?: string;
  author?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

const resolvedDeps: Array<{ dep: string; from: string; to: string }> = [];

function buildProductionPackageJson(): PkgJson {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) {
    console.error("[station] No package.json found.");
    process.exit(1);
  }

  const raw: PkgJson = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // Merge deps: all dependencies + station-* from devDependencies
  const deps: Record<string, string> = { ...(raw.dependencies ?? {}) };
  if (raw.devDependencies) {
    for (const [name, version] of Object.entries(raw.devDependencies)) {
      if (name.startsWith("station-") && !deps[name]) {
        deps[name] = version;
      }
    }
  }

  // Resolve workspace:* → ^{version}
  for (const [name, version] of Object.entries(deps)) {
    if (version.startsWith("workspace:")) {
      const resolved_version = resolveWorkspaceVersion(name, cwd);
      if (resolved_version) {
        const newVersion = `^${resolved_version}`;
        resolvedDeps.push({ dep: name, from: version, to: newVersion });
        deps[name] = newVersion;
      } else {
        console.warn(`[station] Could not resolve ${version} for "${name}" — ensure you are in a workspace or use real version numbers.`);
      }
    }
  }

  const out: PkgJson = {};
  if (raw.name) out.name = raw.name;
  if (raw.version) out.version = raw.version;
  if (raw.type) out.type = raw.type;
  if (raw.private !== undefined) out.private = raw.private;
  if (raw.description) out.description = raw.description;
  if (raw.license) out.license = raw.license;
  if (raw.author) out.author = raw.author;
  out.scripts = { start: "npx station --no-open --host 0.0.0.0" };
  out.dependencies = deps;

  return out;
}

// ── Discover entry points ───────────────────────────────────

function discoverFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const full = join(dir, entry.toString());
    if (statSync(full).isFile() && /\.(ts|js|mjs)$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

function findConfigFile(): string | null {
  for (const name of ["station.config.ts", "station.config.js", "station.config.mjs"]) {
    const candidate = join(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Build ───────────────────────────────────────────────────

console.log("\n[station] Building deploy bundle...\n");

// Clean out directory
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true });
}
mkdirSync(outDir, { recursive: true });

// Write production package.json first (need deps list for externals)
const prodPkg = buildProductionPackageJson();
writeFileSync(join(outDir, "package.json"), JSON.stringify(prodPkg, null, 2) + "\n");

// Collect entry points
const entryPoints: string[] = [];
let signalCount = 0;
let broadcastCount = 0;

if (config.signalsDir) {
  const signalsSrc = resolve(cwd, config.signalsDir);
  const files = discoverFiles(signalsSrc);
  signalCount = files.length;
  entryPoints.push(...files);
}

if (config.broadcastsDir) {
  const broadcastsSrc = resolve(cwd, config.broadcastsDir);
  const files = discoverFiles(broadcastsSrc);
  broadcastCount = files.length;
  entryPoints.push(...files);
}

const configFile = findConfigFile();
if (configFile) {
  entryPoints.push(configFile);
}

if (entryPoints.length === 0) {
  console.error("[station] No signals, broadcasts, or config found to bundle.");
  process.exit(1);
}

// Collect externals: all npm deps + node builtins
const external = [
  ...Object.keys(prodPkg.dependencies ?? {}),
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

// Run esbuild
try {
  const result = await build({
    entryPoints,
    outdir: outDir,
    outbase: cwd,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external,
    logLevel: "warning",
  });

  if (result.errors.length > 0) {
    console.error("[station] Build failed.");
    process.exit(1);
  }
} catch (err: unknown) {
  console.error("[station] Build failed:", (err as Error).message);
  process.exit(1);
}

// Count shared chunks
const outputFiles = readdirSync(outDir);
const chunks = outputFiles.filter((f) => f.startsWith("chunk-") && f.endsWith(".js"));

console.log(`  Bundled ${signalCount} signal${signalCount !== 1 ? "s" : ""}, ${broadcastCount} broadcast${broadcastCount !== 1 ? "s" : ""}`);
if (chunks.length > 0) {
  console.log(`  ${chunks.length} shared chunk${chunks.length !== 1 ? "s" : ""} extracted`);
}
if (configFile) {
  console.log(`  Config compiled`);
}

// ── Copy deploy.include entries ─────────────────────────────

if (config.deploy?.include) {
  for (const entry of config.deploy.include) {
    const src = resolve(cwd, entry);
    if (!existsSync(src)) {
      console.warn(`  [station] Warning: deploy.include path not found: ${entry}`);
      continue;
    }
    const dest = join(outDir, entry);
    if (statSync(src).isDirectory()) {
      cpSync(src, dest, { recursive: true });
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
    }
  }
}

// ── Dockerfile ──────────────────────────────────────────────

function generateDockerfile(): string {
  const port = config.port;
  return [
    `FROM node:20-alpine`,
    `WORKDIR /app`,
    ``,
    `COPY package.json ./`,
    `RUN npm install --omit=dev`,
    ``,
    `COPY . .`,
    ``,
    `EXPOSE ${port}`,
    `ENV NODE_ENV=production`,
    `ENV HOST=0.0.0.0`,
    `ENV PORT=${port}`,
    ``,
    `# Set these in your deployment platform:`,
    `# ENV STATION_AUTH_USERNAME=admin`,
    `# ENV STATION_AUTH_PASSWORD=changeme`,
    ``,
    `CMD ["npx", "station", "--no-open", "--host", "0.0.0.0"]`,
    ``,
  ].join("\n");
}

// ── nixpacks.toml ───────────────────────────────────────────

function generateNixpacks(): string {
  return [
    `[phases.setup]`,
    `nixPkgs = ["nodejs_20"]`,
    ``,
    `[phases.install]`,
    `cmds = ["npm install --omit=dev"]`,
    ``,
    `[start]`,
    `cmd = "npx station --no-open --host 0.0.0.0"`,
    ``,
  ].join("\n");
}

// ── Write deployment files ──────────────────────────────────

writeFileSync(join(outDir, "Dockerfile"), generateDockerfile());
writeFileSync(join(outDir, "nixpacks.toml"), generateNixpacks());
writeFileSync(join(outDir, ".dockerignore"), ["node_modules", ".station/data", "*.db", ".git", ""].join("\n"));
writeFileSync(join(outDir, ".gitignore"), ["node_modules/", "data/", "*.db", ""].join("\n"));

// ── Summary ─────────────────────────────────────────────────

function listDir(dir: string, prefix = ""): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      entries.push(`${prefix}${entry}/`);
      entries.push(...listDir(full, `${prefix}  `));
    } else {
      entries.push(`${prefix}${entry}`);
    }
  }
  return entries;
}

console.log(`\n  ${outDir}\n`);
for (const line of listDir(outDir)) {
  console.log(`    ${line}`);
}

if (resolvedDeps.length > 0) {
  console.log(`\n  Resolved dependencies:`);
  for (const r of resolvedDeps) {
    console.log(`    ${r.dep}: ${r.from} → ${r.to}`);
  }
}

console.log(`\n  Environment variables:`);
console.log(`    STATION_AUTH_USERNAME  — dashboard login`);
console.log(`    STATION_AUTH_PASSWORD  — dashboard password`);
console.log(`    PORT                  — server port (default: ${config.port})`);

console.log(`\n  Deploy:`);
console.log(`    docker build -t station ${outDir}`);
console.log(`    docker run -p ${config.port}:${config.port} station\n`);
