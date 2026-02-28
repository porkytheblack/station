import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "simple-broadcast";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";
import { BroadcastSqliteAdapter } from "@simple-signal/adapter-sqlite/broadcast";
import { ciPipeline } from "./broadcasts/ci-pipeline.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
  maxConcurrent: 4,
  retryBackoffMs: 500,
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  adapter: new BroadcastSqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

broadcastRunner.register(ciPipeline);

const branch = process.argv[2] || "main";
const sha = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

setTimeout(async () => {
  const id = await ciPipeline.trigger({
    repo: "acme/web-app",
    branch,
    commitSha: sha,
  });

  console.log(`\nTriggered CI pipeline: ${id}`);
  console.log(`  repo:   acme/web-app`);
  console.log(`  branch: ${branch}`);
  console.log(`  commit: ${sha.slice(0, 7)}`);
  console.log(`\nProd deploy ${branch === "main" ? "enabled" : "skipped"} (branch guard).`);
  console.log("Open Station to watch the pipeline.\n");
}, 500);

signalRunner.start();
broadcastRunner.start();
