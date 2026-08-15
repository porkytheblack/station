import type { Schedule } from "./types.js";

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayAny: boolean;
  weekdayAny: boolean;
}

export function nextScheduleOccurrence(
  schedule: Pick<Schedule, "interval" | "cron" | "timezone">,
  after: Date,
  parseInterval: (interval: string) => number,
): Date {
  if (schedule.interval) return new Date(after.getTime() + parseInterval(schedule.interval));
  if (schedule.cron) return nextCronOccurrence(schedule.cron, schedule.timezone ?? "UTC", after);
  throw new Error("Schedule requires either interval or cron.");
}

export function validateCron(expression: string, timeZone = "UTC"): void {
  parseCron(expression);
  // Intl validates IANA timezone names and gives us host-tzdata-backed DST
  // conversion without adding a heavyweight date library.
  new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
}

/** Return the first matching minute strictly after `after`. */
export function nextCronOccurrence(expression: string, timeZone: string, after: Date): Date {
  const cron = parseCron(expression);
  if (cron.weekdayAny && !cron.dayAny && !hasPossibleCalendarDay(cron)) {
    throw new Error(`Cron "${expression}" cannot occur in the selected month(s).`);
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    year: "numeric",
  });
  let cursor = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const limit = cursor.getTime() + 366 * 24 * 60 * 60_000 * 5;

  while (cursor.getTime() <= limit) {
    const parts = Object.fromEntries(
      formatter.formatToParts(cursor).map((part) => [part.type, part.value]),
    );
    const minute = Number(parts.minute);
    // Some Intl implementations represent midnight as hour 24.
    const hour = Number(parts.hour) % 24;
    const day = Number(parts.day);
    const month = Number(parts.month);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
    const dayMatch = cron.day.has(day);
    const weekdayMatch = cron.weekday.has(weekday);
    // Traditional cron uses OR when both day-of-month and weekday are
    // restricted; a wildcard leaves the restricted field authoritative.
    const calendarDay =
      (cron.dayAny && cron.weekdayAny) ||
      (cron.dayAny && weekdayMatch) ||
      (cron.weekdayAny && dayMatch) ||
      (!cron.dayAny && !cron.weekdayAny && (dayMatch || weekdayMatch));

    if (
      cron.minute.has(minute) && cron.hour.has(hour) &&
      cron.month.has(month) && calendarDay
    ) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error(`No cron occurrence found within five years for "${expression}".`);
}

function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Cron must contain five fields: minute hour day month weekday.");
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    day: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    weekday: parseField(fields[4], 0, 7, true),
    dayAny: fields[2] === "*",
    weekdayAny: fields[4] === "*",
  };
}

function parseField(source: string, min: number, max: number, weekday = false): Set<number> {
  const out = new Set<number>();
  for (const part of source.split(",")) {
    if (!part) throw new Error("Cron fields cannot contain empty list entries.");
    const stepParts = part.split("/");
    if (stepParts.length > 2) throw new Error(`Invalid cron step "${part}".`);
    const [base, stepRaw] = stepParts;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}".`);

    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const pair = base.split("-").map(Number);
      if (pair.length !== 2) throw new Error(`Invalid cron range "${part}".`);
      [start, end] = pair;
    } else {
      start = Number(base);
      // `5/10` means every ten units beginning at 5 through the field max.
      end = stepRaw === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Cron value "${part}" is outside ${min}-${max}.`);
    }
    for (let value = start; value <= end; value += step) out.add(weekday && value === 7 ? 0 : value);
  }
  return out;
}

function hasPossibleCalendarDay(cron: CronFields): boolean {
  const daysByMonth = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const month of cron.month) {
    for (const day of cron.day) {
      if (day <= daysByMonth[month]) return true;
    }
  }
  return false;
}
