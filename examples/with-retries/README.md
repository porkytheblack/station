# With retries example

Demonstrates timeout and retry behaviour. The signal randomly fails ~50% of the time and is configured with `.retries(3)` (4 total attempts) and a 5-second timeout.

## Run

```bash
# Terminal 1 — start the runner
npx tsx examples/with-retries/runner.ts

# Terminal 2 — trigger the signal
npx tsx examples/with-retries/trigger.ts
```

Watch the runner output to see retry attempts. If all 4 attempts fail, the entry is marked as "failed".
