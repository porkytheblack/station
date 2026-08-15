import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryAdapter } from "station-signal";
import { resolveConfig } from "../../src/config/schema.js";
import { createStation } from "../../src/server/index.js";

const signalsDir = fileURLToPath(new URL("./fixtures/signals", import.meta.url));
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve("tsx"));

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

test("v1 routes remain usable when authentication is intentionally disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-no-auth-v1-"));
  const port = await getFreePort();
  const station = await createStation(resolveConfig({
    host: "127.0.0.1",
    port,
    open: false,
    signalsDir,
    stationDir: "station",
    adapter: new MemoryAdapter(),
    runner: { pollIntervalMs: 10, maxConcurrent: 1 },
  }), dir);

  try {
    await station.start();
    const apiBase = `http://127.0.0.1:${port}/api/v1`;

    const catalogResponse = await fetch(`${apiBase}/signals`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { data: Array<{ name: string }> };
    assert.ok(catalog.data.some((signal) => signal.name === "ping"));

    const triggerResponse = await fetch(`${apiBase}/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signalName: "ping", input: { label: "release-smoke" } }),
    });
    assert.equal(triggerResponse.status, 201);
    const triggered = await triggerResponse.json() as { data: { id: string } };
    assert.ok(triggered.data.id);
  } finally {
    await station.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
