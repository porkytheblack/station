import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryAdapter, configure, type Run, type SignalSubscriber } from "station-signal";
import { createStation } from "../../src/server/index.js";
import { resolveConfig } from "../../src/config/schema.js";
import { ping } from "./fixtures/signals/ping.js";

const signalsDir = fileURLToPath(new URL("./fixtures/signals", import.meta.url));

// Child processes need tsx to import the .ts fixture.
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve("tsx"));

/** Records which lifecycle events reached a config-supplied subscriber. */
function makeRecorder() {
  const seen: string[] = [];
  const sub: SignalSubscriber = {
    onRunDispatched: ({ run }: { run: Run }) => void seen.push(`dispatched:${run.signalName}`),
    onRunStarted: ({ run }: { run: Run }) => void seen.push(`started:${run.signalName}`),
    onRunCompleted: ({ run }: { run: Run }) => void seen.push(`completed:${run.signalName}`),
  };
  return { seen, sub };
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("subscribers passed through defineConfig receive real run events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-subs-"));
  const adapter = new MemoryAdapter();
  const rec = makeRecorder();

  const station = await createStation(
    resolveConfig({
      port: 0, // let the OS pick a free port
      host: "127.0.0.1",
      adapter,
      signalsDir,
      stationDir: dir,
      subscribers: { signal: [rec.sub] },
    }),
    dir,
  );

  try {
    await station.start();

    // Trigger through the same adapter the station's runner drains.
    configure({ adapter });
    await ping.trigger({ label: "hello" });

    await waitFor(
      () => rec.seen.includes("completed:ping"),
      `the config subscriber to observe a completed run (saw: ${JSON.stringify(rec.seen)})`,
    );
    // The full lifecycle reaches it, not just the terminal event.
    assert.ok(rec.seen.includes("dispatched:ping"), "saw dispatch");
    assert.ok(rec.seen.includes("started:ping"), "saw start");
  } finally {
    await station.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing config subscriber does not break the run or Station's own subscribers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-subs-throw-"));
  const adapter = new MemoryAdapter();
  const rec = makeRecorder();

  const exploding: SignalSubscriber = {
    onRunStarted() {
      throw new Error("subscriber blew up");
    },
  };

  const station = await createStation(
    resolveConfig({
      port: 0,
      host: "127.0.0.1",
      adapter,
      signalsDir,
      stationDir: dir,
      // The throwing one runs first, so it can't be that the good one simply
      // ran before the failure.
      subscribers: { signal: [exploding, rec.sub] },
    }),
    dir,
  );

  try {
    await station.start();
    configure({ adapter });
    const runId = await ping.trigger({ label: "resilient" });

    await waitFor(
      () => rec.seen.includes("completed:ping"),
      `the later subscriber to still run (saw: ${JSON.stringify(rec.seen)})`,
    );

    const run = await adapter.getRun(runId);
    assert.equal(run?.status, "completed", "the run itself still succeeded");
  } finally {
    await station.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig carries subscribers through and defaults them to undefined", () => {
  const sub: SignalSubscriber = {};
  assert.deepEqual(resolveConfig({ subscribers: { signal: [sub] } }).subscribers, {
    signal: [sub],
  });
  assert.equal(resolveConfig({}).subscribers, undefined);
});
