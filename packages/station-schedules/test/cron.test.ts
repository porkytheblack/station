import { test } from "node:test";
import assert from "node:assert/strict";
import { nextCronOccurrence, nextScheduleOccurrence, validateCron } from "../src/index.js";

test("cron occurrences honor the configured IANA timezone", () => {
  const next = nextCronOccurrence("0 17 * * *", "Africa/Nairobi", new Date("2026-08-15T12:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-08-15T14:00:00.000Z");
});

test("interval schedules advance from the planned occurrence without drift", () => {
  const planned = new Date("2026-08-15T14:00:00.000Z");
  const next = nextScheduleOccurrence({ interval: "5m" }, planned, () => 300_000);
  assert.equal(next.toISOString(), "2026-08-15T14:05:00.000Z");
});

test("cron validation rejects malformed expressions and timezones", () => {
  assert.throws(() => validateCron("0 17 * *"), /five fields/);
  assert.throws(() => validateCron("0 17 * * *", "Not/AZone"));
  assert.throws(() => validateCron("*/2/3 * * * *"), /Invalid cron step/);
  assert.throws(() => validateCron("1, * * * *"), /empty list/);
});

test("impossible calendar expressions fail without scanning minute by minute", () => {
  assert.throws(
    () => nextCronOccurrence("0 0 31 2 *", "UTC", new Date("2026-01-01T00:00:00Z")),
    /cannot occur/,
  );
});
