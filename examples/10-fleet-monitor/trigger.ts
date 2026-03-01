import { configure } from "station-signal";
import { fullHealthCheck } from "./broadcasts/full-health-check.js";

// Trigger remotely via a running Station server
configure({
  endpoint: process.env.STATION_ENDPOINT ?? "http://localhost:4400",
  apiKey: process.env.STATION_API_KEY!,
});

const id = await fullHealthCheck.trigger({ label: `remote-${Date.now().toString(36)}` });

console.log(`Health check triggered remotely: ${id}`);
process.exit(0);
