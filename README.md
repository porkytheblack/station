# station

A lightweight, type-safe background job framework for TypeScript.

## Features

- Type-safe signal definitions with Zod schema validation
- Fire-and-forget execution via isolated child processes (`spawn` + `unref`)
- Auto-discovery of signal files from a directory
- Built-in timeout detection and configurable retries
- Recurring jobs with simple interval syntax (`"every 5m"`)
- Pluggable storage adapters (memory, SQLite, or bring your own)

## Quick start

### 1. Install

```bash
pnpm add station-signal
```

### 2. Define a signal

```ts
// src/signals/send-email.ts
import { signal, z } from "station-signal";

export const sendEmail = signal("sendEmail")
  .input(z.object({ to: z.string(), subject: z.string(), body: z.string() }))
  .timeout(30_000)
  .retries(2)
  .run(async (input) => {
    // send the email...
    console.log(`Sending email to ${input.to}`);
  });
```

### 3. Start the runner

```ts
// src/runner.ts
import { SignalRunner } from "station-signal";

const runner = new SignalRunner({
  signalsDir: "./src/signals",
});

await runner.start();
```

### Trigger from anywhere

```ts
import { sendEmail } from "./signals/send-email.js";

await sendEmail.trigger({ to: "user@example.com", subject: "Hello", body: "World" });
```

## Packages

| Package | Description |
|---------|-------------|
| [`station-signal`](./packages/station-signal) | Core framework -- signals, runner, queue, adapters |
| [`station-broadcast`](./packages/station-broadcast) | DAG workflow orchestration for signals |
| [`station-adapter-sqlite`](./packages/station-adapter-sqlite) | SQLite adapter using better-sqlite3 |
| [`station-kit`](./packages/station-kit) | Dashboard — inspect and control signals and broadcasts |

## License

MIT
