import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, delimiter } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");

// Exercise the actual CLI in a disposable workspace. External commands are
// recorded stubs, so these tests cannot contact npm or publish anything.
function release(args = [], scenario = "", extraPackage = false) {
  const root = mkdtempSync(resolve(tmpdir(), "station-release-test-"));
  try {
    mkdirSync(resolve(root, "scripts"));
    mkdirSync(resolve(root, "bin"));
    copyFileSync(resolve(repo, "scripts/release-npm.mjs"), resolve(root, "scripts/release-npm.mjs"));
    for (const directoryEntry of readdirSync(resolve(repo, "packages"), { withFileTypes: true })) {
      if (!directoryEntry.isDirectory()) continue;
      const entry = directoryEntry.name;
      const manifest = JSON.parse(readFileSync(resolve(repo, "packages", entry, "package.json"), "utf8"));
      const directory = resolve(root, "packages", entry);
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "package.json"), JSON.stringify(manifest));
      writeFileSync(resolve(directory, "LICENSE"), "MIT");
      writeFileSync(resolve(directory, "README.md"), manifest.name);
    }
    if (extraPackage) {
      mkdirSync(resolve(root, "packages/forgotten"));
      writeFileSync(resolve(root, "packages/forgotten/package.json"), JSON.stringify({ name: "station-forgotten" }));
    }
    const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STATION_TEST_LOG, JSON.stringify({command,args})+'\\n');
const scenario = process.env.STATION_TEST_SCENARIO;
const manifests = fs.readdirSync(path.join(process.cwd(),'packages')).map(directory => ({directory, ...JSON.parse(fs.readFileSync(path.join(process.cwd(),'packages',directory,'package.json'),'utf8'))}));
if (command === 'npm' && args[0] === 'whoami') {
  if (scenario === 'unauthenticated') { console.error('E401'); process.exit(1); }
  console.log(JSON.stringify('porkytheblack')); process.exit(0);
}
if (command === 'npm' && args[0] === 'access') {
  if (scenario === 'access-unavailable') { console.error('E403'); process.exit(1); }
  if (scenario === 'access-malformed') { console.log('[]'); process.exit(0); }
  const grants = Object.fromEntries(manifests.filter(item=>!item.private).map(item=>[item.name,'read-write']));
  if (scenario === 'foreign-package') delete grants['station-tauri'];
  if (scenario === 'read-only') grants['station-tauri']='read-only';
  console.log(JSON.stringify(grants)); process.exit(0);
}
if (command === 'npm' && args[0] === 'view') {
  if (args[2] === 'name') {
    if (scenario === 'name-unavailable') { console.error('E503'); process.exit(1); }
    if (scenario === 'new-name') { console.error('E404'); process.exit(1); }
    console.log(JSON.stringify(args[1])); process.exit(0);
  }
  if (scenario === 'resume' && args[1].startsWith('station-signal@')) { console.log('"published"'); process.exit(0); }
  console.error('E404'); process.exit(1);
}
if (command === 'pnpm' && args[0] === 'test' && scenario === 'tests-fail') process.exit(1);
if (command === 'pnpm' && args.includes('pack')) {
  const name = args[1];
  if (scenario === 'late-pack-fail' && name === 'station-tauri') process.exit(1);
  const directory = path.join(process.cwd(), 'packages', manifests.find(item=>item.name===name).directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  const staging = args[args.indexOf('--pack-destination')+1];
  const content = fs.mkdtempSync(path.join(staging,'content-'));
  const packRoot = path.join(content,'package');
  fs.mkdirSync(packRoot);
  function file(relative) {
    if (!relative || relative.includes('*')) return;
    const target = path.join(packRoot, relative);
    fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,'fixture');
  }
  function collect(value) {
    if (typeof value === 'string' && value.startsWith('./')) file(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  file('LICENSE'); file('README.md'); file(manifest.main); file(manifest.types);
  collect(manifest.exports); collect(manifest.imports); collect(manifest.bin);
  fs.writeFileSync(path.join(packRoot,'package.json'),JSON.stringify(manifest).replaceAll('workspace:*',manifest.version));
  execFileSync('tar',['-czf',path.join(staging,name.replace(/^@/,'').replaceAll('/','-')+'-'+manifest.version+'.tgz'),'-C',content,'package']);
}
`;
    for (const name of ["git", "npm", "pnpm"]) writeFileSync(resolve(root, "bin", name), stub, { mode: 0o755 });
    const log = resolve(root, "commands.jsonl");
    const result = spawnSync(process.execPath, [resolve(root, "scripts/release-npm.mjs"), ...args], {
      cwd: root, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, PATH: `${resolve(root, "bin")}${delimiter}${process.env.PATH}`, STATION_TEST_LOG: log, STATION_TEST_SCENARIO: scenario },
    });
    const commands = (() => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } })();
    return { status: result.status, output: result.stdout + result.stderr, commands };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("all builds, checks, archives and publish dry runs precede any upload", () => {
  const result = release();
  assert.equal(result.status, 0, result.output);
  const commands = result.commands;
  const uploads = commands.filter((c) => c.command === "npm" && c.args[0] === "publish" && !c.args.includes("--dry-run"));
  assert.equal(uploads.length, 20);
  const firstUpload = commands.indexOf(uploads[0]);
  const accessCheck = commands.findIndex(c => c.command === 'npm' && c.args[0] === 'access');
  assert.ok(accessCheck >= 0 && accessCheck < firstUpload);
  assert.equal(commands.filter(c => c.command === 'npm' && c.args[0] === 'view' && c.args[2] === 'name').length, 20);
  assert.ok(!commands.some(c => c.command === 'npm' && c.args[0] === 'owner'), 'effective grants include team permissions; maintainers are not the permission boundary');
  for (const action of ["build", "typecheck", "test:browser:install", "test"]) {
    const index = commands.findIndex((c) => c.command === "pnpm" && c.args[0] === action);
    assert.ok(index >= 0 && index < firstUpload, action);
  }
  assert.equal(commands.slice(0, firstUpload).filter((c) => c.args.includes("pack")).length, 20);
  assert.equal(commands.slice(0, firstUpload).filter((c) => c.command === "npm" && c.args.includes("--dry-run")).length, 20);
  assert.ok(uploads.findIndex((c) => c.args[1].includes("station-browser-")) > uploads.findIndex((c) => c.args[1].includes("station-beacon-")));
});

test("a late package failure prevents every upload", () => {
  const result = release([], "late-pack-fail");
  assert.notEqual(result.status, 0);
  assert.ok(!result.commands.some((c) => c.command === "npm" && c.args[0] === "publish"));
});

test("a failed test preflight prevents packing and publishing", () => {
  const result = release([], "tests-fail");
  assert.notEqual(result.status, 0);
  assert.ok(!result.commands.some((c) => c.args.includes("pack") || c.args[0] === "publish"));
});

test("dry-run never uploads and resume still rebuilds dependencies", () => {
  const result = release(["--dry-run", "--resume", "--allow-dirty", "--skip-checks"], "resume");
  assert.equal(result.status, 0, result.output);
  assert.ok(result.commands.some((c) => c.command === "pnpm" && c.args[0] === "build"));
  const publishes = result.commands.filter((c) => c.command === "npm" && c.args[0] === "publish");
  assert.equal(publishes.length, 19);
  assert.ok(publishes.every((c) => c.args.includes("--dry-run") && !c.args[1].includes("station-signal-")));
});

test("an unlisted public package blocks a release", () => {
  const result = release([], "", true);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /station-forgotten is missing from releaseOrder/);
  assert.ok(!result.commands.some((c) => c.command === "npm"));
});

test("live releases cannot bypass clean-tree or test checks", () => {
  for (const flag of ["--allow-dirty", "--skip-checks"]) {
    const result = release([flag]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /only supported with --dry-run/);
    assert.equal(result.commands.length, 0);
  }
});

test("foreign-owned or read-only existing package blocks every upload before building", () => {
  for (const scenario of ['foreign-package', 'read-only']) {
    const result = release([], scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /no verified write access to existing package station-tauri/);
    assert.ok(!result.commands.some(c => c.command === 'pnpm' || c.args[0] === 'publish'));
  }
});

test("unverifiable authenticated access and package availability fail closed", () => {
  for (const scenario of ['access-unavailable', 'access-malformed', 'name-unavailable']) {
    const result = release(['--dry-run', '--allow-dirty', '--skip-checks'], scenario);
    assert.notEqual(result.status, 0);
    assert.ok(!result.commands.some(c => c.command === 'pnpm' || c.args[0] === 'publish'));
  }
});

test("missing npm authentication blocks live release but permits explicitly unverified packaging dry run", () => {
  const live = release([], 'unauthenticated');
  assert.notEqual(live.status, 0);
  assert.match(live.output, /Could not verify authenticated npm identity/);
  assert.ok(!live.commands.some(c => c.command === 'pnpm' || c.args[0] === 'publish'));
  const dry = release(['--dry-run', '--allow-dirty', '--skip-checks'], 'unauthenticated');
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /publish access is NOT verified/);
  assert.ok(dry.commands.filter(c => c.args[0] === 'publish').every(c => c.args.includes('--dry-run')));
});

test("available new package names pass preflight without claiming a reservation", () => {
  const result = release(['--dry-run', '--allow-dirty', '--skip-checks'], 'new-name');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /availability is not a reservation/);
});
