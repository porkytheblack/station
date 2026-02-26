# Basic example

The simplest possible usage: define a signal, start the runner, trigger it.

## Run

```bash
# Terminal 1 — start the runner
npx tsx examples/basic/runner.ts

# Terminal 2 — trigger the signal
npx tsx examples/basic/trigger.ts
```

The runner discovers `greet.ts` automatically from the `signals/` directory. When triggered, the signal logs a greeting to the runner's stdout.
