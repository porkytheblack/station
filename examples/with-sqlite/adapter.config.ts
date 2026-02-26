import { configure } from "simple-signal";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";

configure({
  adapter: new SqliteAdapter({ dbPath: "./examples/with-sqlite/jobs.db" }),
});
