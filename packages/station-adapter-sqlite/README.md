# station-adapter-sqlite

SQLite storage adapter for station-signal using better-sqlite3.

## Install

```bash
pnpm add station-adapter-sqlite
```

Requires `station-signal` as a peer dependency.

### pnpm 10+

better-sqlite3 is a native Node.js addon that compiles C++ code during installation. pnpm 10 blocks dependency lifecycle scripts by default. You must explicitly allow better-sqlite3 to build by adding this to your project's `package.json`:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}
```

Then reinstall:

```bash
pnpm install
```

Without this, you will see: `The native binary for better-sqlite3 hasn't been compiled.`

## Usage

Configure globally:

```ts
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

configure({ adapter: new SqliteAdapter() });
```

## Options

```ts
interface SqliteAdapterOptions {
  /** Path to the SQLite database file. Defaults to "station-signal.db". */
  dbPath?: string;
  /** Table name. Defaults to "entries". */
  tableName?: string;
}
```

Example with options:

```ts
const adapter = new SqliteAdapter({
  dbPath: "./data/jobs.db",
  tableName: "signal_entries",
});
```

## With SignalRunner

The `configModule` pattern lets you share a single adapter instance across the runner and all spawned child processes.

1. Create a config module (e.g. `src/adapter.config.ts`):

```ts
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

configure({ adapter: new SqliteAdapter({ dbPath: "./jobs.db" }) });
```

2. Pass it to the runner:

```ts
import { SignalRunner } from "station-signal";
import { fileURLToPath } from "node:url";

const runner = new SignalRunner({
  signalsDir: "./src/signals",
  configModule: fileURLToPath(new URL("./adapter.config.ts", import.meta.url)),
});

await runner.start();
```

The runner imports the config module on startup and passes its path to every spawned child process via an environment variable, so they all connect to the same SQLite database.

## Graceful shutdown

```ts
const adapter = new SqliteAdapter();
// ... use adapter ...
adapter.close();
```

## Details

- WAL mode is enabled by default for better concurrent read/write performance.
- Table and indexes are created automatically on first use (`CREATE TABLE IF NOT EXISTS`).
- Date fields are stored as ISO-8601 text strings.
- All methods are async (to satisfy the `SignalQueueAdapter` interface) but use synchronous better-sqlite3 under the hood.
