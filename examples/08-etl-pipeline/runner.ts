import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "simple-broadcast";
import { SqliteAdapter } from "simple-adapter-sqlite";
import { BroadcastSqliteAdapter } from "simple-adapter-sqlite/broadcast";
import { etlPipeline } from "./broadcasts/etl-pipeline.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  adapter: new BroadcastSqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

broadcastRunner.register(etlPipeline);

// Trigger the ETL pipeline after a short delay
setTimeout(async () => {
  const id = await etlPipeline.trigger({ source: "legacy-crm.acme.io", batchSize: 50 });
  console.log(`\nTriggered ETL pipeline: ${id}`);
  console.log(`Data persisted in ${DB_PATH}`);
  console.log("Open Station to watch the pipeline execute step by step.\n");
}, 500);

// Start both runners
signalRunner.start();
broadcastRunner.start();
