import type { ScheduleAdapter } from "./adapters/index.js";
import type { Schedule, ScheduleKind } from "./types.js";
import { nextScheduleOccurrence } from "./cron.js";

export interface ScheduleReconcilerOptions {
  adapter: ScheduleAdapter;
  /** Which schedule kinds this reconciler is responsible for. */
  kinds: ScheduleKind[];
  /** Trigger the schedule's target with its input. Returns the run ID. */
  triggerFn: (schedule: Schedule, scheduledFor: Date) => Promise<string>;
  /** Returns true if a pending or running run already exists for this schedule's target. */
  hasPendingOrRunning?: (schedule: Schedule) => Promise<boolean>;
  /** Parse "5m" → 300_000. Both runners already have this — pass it in. */
  parseInterval: (interval: string) => number;
  /** Optional logger for diagnostics. */
  onError?: (err: Error, schedule?: Schedule) => void;
}

/**
 * Polls the schedule store, fires due schedules, advances `nextRunAt`, and
 * records the result. Used by both SignalRunner and BroadcastRunner so the
 * semantics stay identical.
 *
 * The reconciler is idempotent across multiple instances: when the adapter
 * supports `claimDue`, two workers can't both fire the same schedule.
 */
export class ScheduleReconciler {
  private opts: ScheduleReconcilerOptions;

  constructor(opts: ScheduleReconcilerOptions) {
    this.opts = opts;
  }

  /**
   * Run one reconciliation pass. Safe to call from a runner's tick loop.
   * Skips schedules whose kind isn't in `opts.kinds`.
   */
  async tick(): Promise<void> {
    let due: Schedule[];
    try {
      due = await this.opts.adapter.list({ due: true });
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const ourKinds = new Set(this.opts.kinds);

    for (const schedule of due) {
      if (!ourKinds.has(schedule.kind)) continue;

      try {
        await this.fireOne(schedule);
      } catch (err) {
        this.opts.onError?.(
          err instanceof Error ? err : new Error(String(err)),
          schedule,
        );
      }
    }
  }

  private async fireOne(schedule: Schedule): Promise<void> {
    // Always claim first — the claim is the gate, the only thing that
    // guarantees at-most-once across multiple runners. The pending/running
    // check below is an additional optimisation that runs *after* a successful
    // claim, never before it.
    const occurrence = schedule.nextRunAt;
    const now = new Date();
    const misfire = schedule.misfirePolicy ?? "fire-once";
    let newNext = nextScheduleOccurrence(schedule, occurrence, this.opts.parseInterval);
    if (misfire !== "catch-up") {
      while (newNext <= now) newNext = nextScheduleOccurrence(schedule, newNext, this.opts.parseInterval);
    }
    if (this.opts.adapter.claimDue) {
      const claimed = await this.opts.adapter.claimDue(
        schedule.id,
        schedule.nextRunAt,
        newNext,
      );
      if (!claimed) return;
    } else {
      // No atomic claim available — fall back to a best-effort advance so we
      // don't busy-loop on the same schedule. This is racy for multi-instance
      // deployments; adapters should implement claimDue.
      console.warn(
        "[station-schedules] Schedule adapter has no claimDue — multi-runner deployments may double-fire schedules.",
      );
      await this.opts.adapter.update(schedule.id, { nextRunAt: newNext });
    }

    const lateByMs = now.getTime() - occurrence.getTime();
    if (misfire === "skip" && lateByMs > (schedule.misfireGraceMs ?? 60_000)) {
      await this.opts.adapter.update(schedule.id, {
        lastRunAt: now,
        lastRunStatus: "skipped:misfire",
      });
      return;
    }

    if ((schedule.overlapPolicy ?? "skip") === "skip" && this.opts.hasPendingOrRunning) {
      try {
        const pending = await this.opts.hasPendingOrRunning(schedule);
        if (pending) {
          // We've already advanced nextRunAt via the claim; just record we
          // skipped and bail.
          await this.opts.adapter.update(schedule.id, {
            lastRunAt: new Date(),
            lastRunStatus: "skipped:overlap",
          });
          return;
        }
      } catch (err) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), schedule);
        // Fall through and trigger anyway — better to overlap than to drop.
      }
    }

    let runId: string | undefined;
    let status = "triggered";
    try {
      runId = await this.opts.triggerFn(schedule, occurrence);
    } catch (err) {
      status = "errored";
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)), schedule);
    }

    await this.opts.adapter.update(schedule.id, {
      lastRunAt: new Date(),
      lastRunId: runId,
      lastRunStatus: status,
    });
  }
}
