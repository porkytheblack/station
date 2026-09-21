import { supervise } from "./lifecycle.js";
await supervise(process.argv[2]).catch(() => { console.error("Station service supervisor failed. Inspect its local launch configuration."); process.exitCode = 1; });
