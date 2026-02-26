# Recurring example

Demonstrates a recurring signal using `.every("5s")`. The heartbeat signal fires every 5 seconds and logs the current timestamp.

## Run

```bash
npx tsx examples/recurring/runner.ts
```

No separate trigger needed — recurring signals are automatically scheduled when the runner discovers them. Press Ctrl+C to stop.
