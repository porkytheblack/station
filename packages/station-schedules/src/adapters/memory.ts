import { randomUUID } from "node:crypto";
import type { Schedule, SchedulePatch } from "../types.js";
import type { ScheduleAdapter, ScheduleListFilter } from "./index.js";

export class ScheduleMemoryAdapter implements ScheduleAdapter {
  private schedules = new Map<string, Schedule>();

  async add(schedule: Schedule): Promise<void> {
    if (this.schedules.has(schedule.id)) {
      throw new Error(`Schedule with id "${schedule.id}" already exists`);
    }
    this.schedules.set(schedule.id, { ...schedule });
  }

  async get(id: string): Promise<Schedule | null> {
    const s = this.schedules.get(id);
    return s ? { ...s } : null;
  }

  async list(filter?: ScheduleListFilter): Promise<Schedule[]> {
    const now = new Date();
    // Return *copies* — the adapter is the source of truth, and mutations to
    // its internal state via claimDue/update must not be visible to callers
    // already holding a previously-listed schedule reference.
    return Array.from(this.schedules.values())
      .filter((s) => {
        if (filter?.kind && s.kind !== filter.kind) return false;
        if (filter?.enabled !== undefined && s.enabled !== filter.enabled) return false;
        if (filter?.due) {
          if (!s.enabled) return false;
          if (s.nextRunAt > now) return false;
        }
        return true;
      })
      .map((s) => ({ ...s }));
  }

  async update(id: string, patch: SchedulePatch): Promise<void> {
    const existing = this.schedules.get(id);
    if (!existing) return;
    const next = { ...existing } as Schedule & Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    next.updatedAt = new Date();
    this.schedules.set(id, next);
  }

  async delete(id: string): Promise<boolean> {
    return this.schedules.delete(id);
  }

  async claimDue(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean> {
    const s = this.schedules.get(id);
    if (!s || !s.enabled) return false;
    if (s.nextRunAt.getTime() !== expectedNextRunAt.getTime()) return false;
    s.nextRunAt = newNextRunAt;
    s.updatedAt = new Date();
    return true;
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // No resources to release; the adapter may be shared in process.
  }
}
