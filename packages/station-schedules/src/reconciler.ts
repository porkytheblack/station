import type { ScheduleAdapter } from "./adapters/index.js";
import type { Schedule, ScheduleKind } from "./types.js";

export interface ScheduleReconcilerOptions {
  adapter: ScheduleAdapter;
  /** Which schedule kinds this reconciler is responsible for. */
  kinds: ScheduleKind[];
  /** Trigger the schedule's target with its input. Returns the run ID. */
  triggerFn: (schedule: Schedule) => Promise<string>;
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
    if (this.opts.hasPendingOrRunning) {
      const pending = await this.opts.hasPendingOrRunning(schedule);
      if (pending) {
        // Skip firing but still advance nextRunAt so we don't busy-loop.
        await this.advance(schedule, undefined, undefined);
        return;
      }
    }

    // Atomic claim when supported — prevents double-fire across multiple runners.
    if (this.opts.adapter.claimDue) {
      const newNext = new Date(Date.now() + this.opts.parseInterval(schedule.interval));
      const claimed = await this.opts.adapter.claimDue(
        schedule.id,
        schedule.nextRunAt,
        newNext,
      );
      if (!claimed) return;
      const runId = await this.opts.triggerFn(schedule);
      await this.opts.adapter.update(schedule.id, {
        lastRunAt: new Date(),
        lastRunId: runId,
        lastRunStatus: "triggered",
      });
      return;
    }

    // Non-atomic fallback.
    const runId = await this.opts.triggerFn(schedule);
    await this.advance(schedule, runId, "triggered");
  }

  private async advance(
    schedule: Schedule,
    lastRunId: string | undefined,
    lastRunStatus: string | undefined,
  ): Promise<void> {
    const next = new Date(Date.now() + this.opts.parseInterval(schedule.interval));
    await this.opts.adapter.update(schedule.id, {
      nextRunAt: next,
      lastRunAt: new Date(),
      lastRunId,
      lastRunStatus,
    });
  }
}
