# station-schedules

Runtime-editable schedule store and reconciler shared by `station-signal` and `station-broadcast`. Lets users define, edit, enable/disable, and remove schedules at runtime — distinct from the file-defined `.every()` schedules in signals/broadcasts, which remain in code.

## Install

```bash
pnpm add station-schedules
```

## What's in the box

- `Schedule` / `SchedulePatch` types — the persisted record.
- `ScheduleAdapter` interface — pluggable storage.
- `ScheduleMemoryAdapter` — in-process implementation, useful for tests.
- `ScheduleReconciler` — the polling + claim + trigger loop, identical semantics for both runners.

Persistent adapter implementations live in their own packages:

- `station-adapter-sqlite/schedules`
- `station-adapter-postgres/schedules`
- `station-adapter-mysql/schedules`
- `station-adapter-redis/schedules`

## Schedule

```ts
type ScheduleKind = "signal" | "broadcast-static" | "broadcast-dynamic";

interface Schedule {
  id: string;
  kind: ScheduleKind;
  /** signal name OR broadcast name OR dynamic broadcast name */
  target: string;
  /** Exactly one timing mode is set. */
  interval?: string;
  cron?: string;             // five-field cron
  timezone?: string;         // IANA name, default UTC
  overlapPolicy?: "skip" | "allow";
  misfirePolicy?: "skip" | "fire-once" | "catch-up";
  misfireGraceMs?: number;
  input?: unknown;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastRunStatus?: string;
  lastRunId?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}
```

## ScheduleAdapter

```ts
interface ScheduleAdapter {
  add(schedule: Schedule): Promise<void>;
  get(id: string): Promise<Schedule | null>;
  list(filter?: { kind?: ScheduleKind; enabled?: boolean; due?: boolean }): Promise<Schedule[]>;
  update(id: string, patch: SchedulePatch): Promise<void>;
  delete(id: string): Promise<boolean>;
  /**
   * Atomically advance `nextRunAt` only if the stored value still matches
   * `expectedNextRunAt`. Returns true if the caller successfully claimed
   * the schedule. Required for multi-instance correctness.
   */
  claimDue?(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean>;
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}
```

Adapters that don't implement `claimDue` will fall back to a non-atomic advance and emit a warning — fine for single-process dev, unsafe for multi-runner deployments.

## ScheduleReconciler

The reconciler is what actually fires schedules. Each runner constructs one and ticks it from its main poll loop:

```ts
import { ScheduleReconciler } from "station-schedules";
import { parseInterval } from "station-signal";

const reconciler = new ScheduleReconciler({
  adapter: scheduleAdapter,
  kinds: ["signal"], // this reconciler only handles signal schedules
  parseInterval,
  triggerFn: (s, scheduledFor) => signalRunner.triggerSignal(
    s.target, s.input ?? {}, { id: s.id, scheduledFor },
  ),
  hasPendingOrRunning: (s) => signalRunner.hasPendingOrRunningForSignal(s.target),
  onError: (err, schedule) => console.error("schedule error:", err, schedule?.id),
});

// In your tick loop:
await reconciler.tick();
```

### What `tick()` does

1. Lists schedules with `enabled = true` and `nextRunAt <= now`.
2. For each schedule whose kind this reconciler handles:
   1. Calls `claimDue(id, currentNextRunAt, newNextRunAt)`. If another runner already claimed, bails — at-most-once.
   2. Applies the schedule's misfire and overlap policy.
   3. Calls `triggerFn(schedule, scheduledFor)`.
   4. Records `lastRunAt`, `lastRunId`, and `lastRunStatus` (`"triggered"` or `"errored"`).

If `triggerFn` throws, the schedule still has its `nextRunAt` advanced (via the claim) and records an error status — schedules can never busy-loop on a recurring failure.

## Multi-instance safety

When two Station processes share the same schedule store, the atomic `claimDue` ensures each fire happens on exactly one of them. Adapter implementations:

- **SQLite** — `UPDATE WHERE next_run_at = ?`, single-writer DB serializes
- **Postgres** — `UPDATE … RETURNING id`, atomic across connections
- **MySQL** — `UPDATE … WHERE …`, `affectedRows > 0` decides the winner
- **Redis** — Lua `EVAL` script compares `ZSCORE` and updates atomically

The in-memory adapter is single-process only.

## License

MIT
