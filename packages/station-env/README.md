# station-env

Runtime-managed environment variables for [Station](../..) signals and beacons.

Define variables once — globally or scoped to specific signals/beacons — instead
of exporting everything into the Station process. Require a variable's presence
for a run, mark values as write-only secrets, and change them from the dashboard
while Station is running (Vercel-like environments). Resolved variables are
injected into each run's `process.env` over the private IPC channel, so secrets
never appear in the child's spawn environment (`/proc/<pid>/environ`).

## Concepts

- **`EnvVar`** — a `{ key, value, secret, targets }` record. Empty `targets` means
  the variable is **global** (injected into every signal and beacon); a non-empty
  list scopes it, and a scoped variable **overrides** a global one with the same key.
- **`EnvStorageAdapter`** — pluggable storage. Built-ins: `MemoryEnvStorage` (tests)
  and `FileEnvStorage` (JSON file, single-process default). Durable adapters ship
  from `station-adapter-{sqlite,postgres,mysql,redis}/env`.
- **`EnvStore`** — validation, secret masking, conflict detection, and resolution
  over an adapter. Structurally satisfies the `EnvProvider` interface the Station
  runners accept.

## Usage

```ts
import { EnvStore, FileEnvStorage } from "station-env";

const store = new EnvStore(new FileEnvStorage({ filePath: "./station-env.json" }));

// Global secret — injected into every run.
await store.create({ key: "STRIPE_API_KEY", value: "sk_live_…", secret: true });

// Scoped to one signal — overrides a global of the same key for that signal.
await store.create({
  key: "DB_URL",
  value: "postgres://…",
  targets: [{ kind: "signal", name: "charge" }],
});

// What a given run gets injected (global + its scoped vars).
const env = await store.resolveFor({ kind: "signal", name: "charge" });
```

## Requiring variables

Declare requirements in signal/beacon code with `.env()`:

```ts
import { signal, z } from "station-signal";

export const charge = signal("charge")
  .input(z.object({ amount: z.number() }))
  .env("STRIPE_API_KEY")   // run fails fast if unset (store or host env)
  .run(async (input) => {
    await stripe(process.env.STRIPE_API_KEY!).charge(input.amount);
  });
```

The runner checks each required key against the resolved store map and the host
`process.env` before dispatch: a **signal** run fails with a clear error listing
the missing keys; a **beacon** is marked `errored` (terminal until restarted).

## With station-kit

`station-kit` wires an `EnvStore` automatically (default `FileEnvStorage` at
`<dataDir>/station-env.json`) and injects it into both runners. Pass a durable
adapter for production:

```ts
import { defineConfig } from "station-kit";
import { EnvPostgresAdapter } from "station-adapter-postgres/env";

export default defineConfig({
  envStorage: new EnvPostgresAdapter({ connectionString: process.env.DATABASE_URL }),
});
```

The dashboard's **Environment** page manages variables and flags any
required-but-undefined keys per signal/beacon.

## License

MIT
