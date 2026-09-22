#!/usr/bin/env node
import { parseArgs, run } from "./commands.js";
import { serializeCliError, cliErrorExitCode } from "./errors.js";
const jsonErrors = process.argv.slice(2).some(value => value === "--json-errors" || value.startsWith("--json-errors="));
try { await run(parseArgs(process.argv.slice(2))); }
catch (error) { console.error(jsonErrors ? JSON.stringify(serializeCliError(error)) : `station: ${error instanceof Error ? error.message : "Operation failed."}`); process.exitCode = cliErrorExitCode(error); }
