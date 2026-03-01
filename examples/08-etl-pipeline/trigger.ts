import { configure } from "station-signal";
import { etlPipeline } from "./broadcasts/etl-pipeline.js";

// Trigger remotely via a running Station server
configure({
  endpoint: process.env.STATION_ENDPOINT ?? "http://localhost:4400",
  apiKey: process.env.STATION_API_KEY!,
});

const id = await etlPipeline.trigger({ source: "legacy-crm.acme.io", batchSize: 50 });

console.log(`ETL pipeline triggered remotely: ${id}`);
process.exit(0);
