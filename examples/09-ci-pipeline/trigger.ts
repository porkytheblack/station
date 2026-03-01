import { configure } from "station-signal";
import { ciPipeline } from "./broadcasts/ci-pipeline.js";

// Trigger remotely via a running Station server
configure({
  endpoint: process.env.STATION_ENDPOINT ?? "http://localhost:4400",
  apiKey: process.env.STATION_API_KEY!,
});

const branch = process.argv[2] || "main";
const sha = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

const id = await ciPipeline.trigger({
  repo: "acme/web-app",
  branch,
  commitSha: sha,
});

console.log(`CI pipeline triggered remotely: ${id}`);
console.log(`  repo:   acme/web-app`);
console.log(`  branch: ${branch}`);
console.log(`  commit: ${sha.slice(0, 7)}`);
process.exit(0);
