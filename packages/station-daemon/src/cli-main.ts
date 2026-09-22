import { loadConfig } from "./config/loader.js";
import { createStation } from "./server/index.js";
import { parseArgs, printUsage } from "./cli/parse-args.js";

// Parse CLI arguments
const cliArgs = parseArgs(process.argv.slice(2));

if (cliArgs.help) {
  printUsage();
  process.exit(0);
}

if (cliArgs.subcommand === "deploy") {
  await import("./cli/deploy.js");
  process.exit(0);
}

if (cliArgs.subcommand) {
  console.error(`[station] Unknown command: ${cliArgs.subcommand}`);
  printUsage();
  process.exit(1);
}

const cwd = process.cwd();
const config = await loadConfig(cwd, cliArgs.config);

// Apply CLI overrides
if (cliArgs.port !== undefined) config.port = cliArgs.port;
if (cliArgs.host !== undefined) config.host = cliArgs.host;
if (cliArgs.dir !== undefined) config.stationDir = cliArgs.dir;
if (cliArgs.noRunners) config.runRunners = false;

const station = await createStation(config, cwd);
await station.start();
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try { await station.stop(); process.exitCode = 0; }
  catch (error) { console.error(error); process.exitCode = 1; }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
