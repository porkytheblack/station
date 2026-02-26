# With SQLite example

Demonstrates persistent job storage using `@simple-signal/adapter-sqlite`. Entries survive process restarts because they're stored in an SQLite database file.

## Run

```bash
# Terminal 1 — start the runner
npx tsx examples/with-sqlite/runner.ts

# Terminal 2 — trigger a signal
npx tsx examples/with-sqlite/trigger.ts
```

The trigger script imports `adapter.config.ts` so it writes to the same `jobs.db` that the runner reads from. You can stop and restart the runner — pending entries will still be picked up.

## Key pattern: configModule

The `adapter.config.ts` file calls `configure()` with a `SqliteAdapter`. The runner imports it on startup and passes its path to every spawned child process via environment variable, so all processes share the same database.
