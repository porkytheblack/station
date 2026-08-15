export type ScheduleKind = "signal" | "broadcast-static" | "broadcast-dynamic";

export interface Schedule {
  id: string;
  kind: ScheduleKind;
  /** Signal name OR broadcast name OR dynamic broadcast name. */
  target: string;
  /** Interval string (e.g. "5m", "1h") understood by station-signal's parseInterval. */
  interval?: string;
  /** Five-field cron expression for calendar-aware schedules. */
  cron?: string;
  /** IANA time zone used by `cron`. @default "UTC" */
  timezone?: string;
  /** What to do when the previous occurrence is still pending/running. @default "skip" */
  overlapPolicy?: "allow" | "skip";
  /** What to do with occurrences missed while Headquarters was unavailable. @default "fire-once" */
  misfirePolicy?: "skip" | "fire-once" | "catch-up";
  /** Lateness allowed before `misfirePolicy` applies. @default 60000 */
  misfireGraceMs?: number;
  /** JSON-serializable input passed to the target on each fire. */
  input?: unknown;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastRunStatus?: string;
  /** ID of the last triggered run for click-through. */
  lastRunId?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}

export type SchedulePatch = Partial<Omit<Schedule, "id" | "kind" | "target" | "createdAt">>;
