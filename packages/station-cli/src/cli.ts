#!/usr/bin/env node
import { parseArgs, run } from "./commands.js";
try { await run(parseArgs(process.argv.slice(2))); }
catch (error) { console.error(`station: ${error instanceof Error ? error.message : "Operation failed."}`); process.exitCode = 1; }
