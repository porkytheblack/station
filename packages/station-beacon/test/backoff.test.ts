import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffMs, shouldResetBackoff, shouldRestart } from "../src/backoff.js";
import type { BackoffConfig } from "../src/types.js";

const CFG: BackoffConfig = { baseMs: 1_000, factor: 2, maxMs: 30_000, resetAfterMs: 60_000 };

test("computeBackoffMs grows exponentially and caps at max", () => {
  assert.equal(computeBackoffMs(0, CFG), 1_000);
  assert.equal(computeBackoffMs(1, CFG), 2_000);
  assert.equal(computeBackoffMs(2, CFG), 4_000);
  assert.equal(computeBackoffMs(3, CFG), 8_000);
  // 1000 * 2^5 = 32000, capped to 30000
  assert.equal(computeBackoffMs(5, CFG), 30_000);
  // very large attempt still capped
  assert.equal(computeBackoffMs(50, CFG), 30_000);
});

test("computeBackoffMs treats negative attempts as the first attempt", () => {
  assert.equal(computeBackoffMs(-3, CFG), 1_000);
});

test("computeBackoffMs with factor 1 is constant", () => {
  const flat: BackoffConfig = { ...CFG, factor: 1 };
  assert.equal(computeBackoffMs(0, flat), 1_000);
  assert.equal(computeBackoffMs(9, flat), 1_000);
});

test("shouldRestart: never restarts when the operator wants it stopped", () => {
  assert.equal(shouldRestart("always", "failure", "stopped"), false);
  assert.equal(shouldRestart("always", "clean", "stopped"), false);
});

test("shouldRestart: never restarts an operator-initiated stop", () => {
  assert.equal(shouldRestart("always", "stopped", "running"), false);
  assert.equal(shouldRestart("on-failure", "stopped", "running"), false);
});

test("shouldRestart: policy 'never' never restarts", () => {
  assert.equal(shouldRestart("never", "failure", "running"), false);
  assert.equal(shouldRestart("never", "clean", "running"), false);
  assert.equal(shouldRestart("never", "stalled", "running"), false);
});

test("shouldRestart: policy 'on-failure' restarts only on failure or stall", () => {
  assert.equal(shouldRestart("on-failure", "failure", "running"), true);
  assert.equal(shouldRestart("on-failure", "stalled", "running"), true);
  assert.equal(shouldRestart("on-failure", "clean", "running"), false);
});

test("shouldRestart: policy 'always' restarts on clean and failure exits", () => {
  assert.equal(shouldRestart("always", "clean", "running"), true);
  assert.equal(shouldRestart("always", "failure", "running"), true);
  assert.equal(shouldRestart("always", "stalled", "running"), true);
});

test("shouldResetBackoff compares uptime against the reset threshold", () => {
  assert.equal(shouldResetBackoff(70_000, CFG), true);
  assert.equal(shouldResetBackoff(60_000, CFG), true);
  assert.equal(shouldResetBackoff(59_999, CFG), false);
});
