import { test } from "node:test";
import assert from "node:assert/strict";
import { beacon } from "../src/beacon.js";
import { isBeacon } from "../src/util.js";
import { DEFAULT_BACKOFF, DEFAULT_STOP_TIMEOUT_MS } from "../src/types.js";
import type { BeaconContext } from "../src/context.js";
import { z } from "station-signal";

test("rejects invalid beacon names", () => {
  assert.throws(() => beacon("1-bad"), /Invalid beacon name/);
  assert.throws(() => beacon("has space"), /Invalid beacon name/);
});

test("applies sensible defaults", () => {
  const b = beacon("defaults").run(async () => {});
  assert.equal(b.name, "defaults");
  assert.equal(b.mode, "run");
  assert.equal(b.restartPolicy, "on-failure");
  assert.equal(b.startMode, "auto");
  assert.equal(b.autoStart, true);
  assert.equal(b.maxInstances, undefined, "unset means the runner's default cap applies");
  assert.equal(b.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
  assert.deepEqual(b.backoff, DEFAULT_BACKOFF);
  assert.equal(b.heartbeatIntervalMs, undefined);
  assert.ok(isBeacon(b));
});

test("config schema and default config are captured", () => {
  const b = beacon("configured")
    .config(z.object({ port: z.number().default(8080) }))
    .withConfig({ port: 3000 })
    .run(async () => {});
  assert.deepEqual(b.defaultConfig, { port: 3000 });
  assert.equal(b.configSchema.safeParse({}).success, true);
  assert.deepEqual(b.configSchema.parse({}), { port: 8080 });
});

test("restart / stopTimeout / manualStart are recorded", () => {
  const b = beacon("controls")
    .restart("always")
    .stopTimeout("2s")
    .manualStart()
    .run(async () => {});
  assert.equal(b.restartPolicy, "always");
  assert.equal(b.stopTimeoutMs, 2_000);
  assert.equal(b.startMode, "manual");
  assert.equal(b.autoStart, false);
});

test("start modes select how instances come into existence", () => {
  const auto = beacon("m-auto").run(async () => {});
  const manual = beacon("m-manual").manualStart().run(async () => {});
  const onDemand = beacon("m-demand").onDemand().run(async () => {});
  assert.deepEqual(
    [auto.startMode, manual.startMode, onDemand.startMode],
    ["auto", "manual", "on-demand"],
  );
  // autoStart stays available as the derived boolean.
  assert.deepEqual([auto.autoStart, manual.autoStart, onDemand.autoStart], [true, false, false]);

  // .startMode() is the general form the shorthands delegate to.
  assert.equal(beacon("m-x").startMode("on-demand").run(async () => {}).startMode, "on-demand");
});

test("maxInstances is recorded and must be a positive integer", () => {
  assert.equal(beacon("cap").maxInstances(5).run(async () => {}).maxInstances, 5);
  assert.throws(() => beacon("cap2").maxInstances(0), /positive integer/);
  assert.throws(() => beacon("cap3").maxInstances(2.5), /positive integer/);
  assert.throws(() => beacon("cap4").maxInstances(-1), /positive integer/);
});

test("backoff parses intervals and validates factor", () => {
  const b = beacon("bo").backoff("2s", { factor: 3, max: "1m", resetAfter: "30s" }).run(async () => {});
  assert.deepEqual(b.backoff, { baseMs: 2_000, factor: 3, maxMs: 60_000, resetAfterMs: 30_000 });
  assert.throws(() => beacon("bad").backoff("1s", { factor: 0.5 }), /factor must be >= 1/);
});

test("heartbeat sets interval and derives a default timeout", () => {
  const b = beacon("hb").heartbeat("10s").run(async () => {});
  assert.equal(b.heartbeatIntervalMs, 10_000);
  assert.equal(b.heartbeatTimeoutMs, 30_000); // 3x default
  const b2 = beacon("hb2").heartbeat("10s", { timeout: "45s" }).run(async () => {});
  assert.equal(b2.heartbeatTimeoutMs, 45_000);
  assert.throws(() => beacon("hb3").heartbeat("10s", { timeout: "5s" }), /timeout must be greater/);
});

test("builder is immutable — branching does not mutate the original", () => {
  const base = beacon("immut");
  const always = base.restart("always");
  const never = base.restart("never");
  assert.equal(always.run(async () => {}).restartPolicy, "always");
  assert.equal(never.run(async () => {}).restartPolicy, "never");
});

test("poll() produces a poll-mode beacon whose loop marks ready and ticks until aborted", async () => {
  const controller = new AbortController();
  let calls = 0;
  let readyCount = 0;

  const b = beacon("poller").poll(5, async () => {
    calls++;
    if (calls >= 3) controller.abort();
  });

  assert.equal(b.mode, "poll");
  assert.equal(b.pollIntervalMs, 5);

  const ctx: BeaconContext<Record<string, never>> = {
    name: "poller",
    config: {},
    incarnation: 1,
    signal: controller.signal,
    ready: () => {
      readyCount++;
    },
    heartbeat: () => {},
    log: () => {},
    onStop: () => {},
    untilStopped: () => Promise.resolve(),
  };

  await b.handler(ctx);
  assert.equal(readyCount, 1, "ready() called once at loop start");
  assert.equal(calls, 3, "loop ran until the abort");
});
