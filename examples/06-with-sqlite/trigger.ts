import path from "node:path";
import { configure } from "simple-signal";
import { SqliteAdapter } from "simple-adapter-sqlite";
import { sendEmail } from "./signals/send-email.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

configure({ adapter: new SqliteAdapter({ dbPath: DB_PATH }) });

const id = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Hello from simple-signal",
  body: "This run was persisted to SQLite and picked up by the runner.",
});

console.log(`Run triggered: ${id}`);
console.log(`Persisted to ${DB_PATH} — start the runner to execute it.`);
