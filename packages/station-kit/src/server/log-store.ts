import Database from "better-sqlite3";
import type { LogEntry } from "./log-buffer.js";

export class LogStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private selectStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        signal_name TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_run_id ON logs(run_id)`);

    this.insertStmt = this.db.prepare(
      `INSERT INTO logs (run_id, signal_name, level, message, timestamp) VALUES (?, ?, ?, ?, ?)`,
    );
    this.selectStmt = this.db.prepare(
      `SELECT run_id, signal_name, level, message, timestamp FROM logs WHERE run_id = ? ORDER BY id`,
    );
  }

  add(entry: LogEntry): void {
    this.insertStmt.run(entry.runId, entry.signalName, entry.level, entry.message, entry.timestamp);
  }

  get(runId: string): LogEntry[] {
    const rows = this.selectStmt.all(runId) as Array<{
      run_id: string;
      signal_name: string;
      level: string;
      message: string;
      timestamp: string;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      signalName: row.signal_name,
      level: row.level as "stdout" | "stderr",
      message: row.message,
      timestamp: row.timestamp,
    }));
  }

  close(): void {
    this.db.close();
  }
}
