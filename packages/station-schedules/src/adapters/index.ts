import type { Schedule, SchedulePatch, ScheduleKind } from "../types.js";

export interface ScheduleListFilter {
  kind?: ScheduleKind;
  enabled?: boolean;
  /** Only schedules whose `nextRunAt <= now` AND `enabled === true`. */
  due?: boolean;
}

export interface ScheduleAdapter {
  add(schedule: Schedule): Promise<void>;
  get(id: string): Promise<Schedule | null>;
  list(filter?: ScheduleListFilter): Promise<Schedule[]>;
  update(id: string, patch: SchedulePatch): Promise<void>;
  delete(id: string): Promise<boolean>;
  /**
   * Atomically claim a schedule that's due to fire — returns the schedule if
   * the caller successfully claimed it (advancing nextRunAt), or null if
   * another worker beat it.
   *
   * Adapters that don't implement this fall back to a non-atomic check + update.
   */
  claimDue?(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean>;
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

export { ScheduleMemoryAdapter } from "./memory.js";
