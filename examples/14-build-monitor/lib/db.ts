import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_PATH = process.env.BUILD_MONITOR_DB ?? ".station/data/builds.db";

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");

export const db = drizzle(sqlite, { schema });

// Run migrations inline (simple for this example)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    "commit" TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at INTEGER,
    finished_at INTEGER,
    duration INTEGER,
    triggered_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS test_results (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL REFERENCES builds(id),
    suite TEXT NOT NULL,
    passed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    duration INTEGER
  );
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL REFERENCES builds(id),
    environment TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    url TEXT,
    deployed_at INTEGER
  );
`);
