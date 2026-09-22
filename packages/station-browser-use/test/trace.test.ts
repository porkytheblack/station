import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext } from "playwright";
import { PlaywrightTools } from "../src/playwright-tools.js";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("trace startup/export failures close the context rather than leaving unknown writers active", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-trace-failure-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const startupFailure of [true, false]) {
    let closed = 0;
    const context = { tracing: { start: async () => { if (startupFailure) throw new Error("start failed"); }, stop: async () => { throw new Error("stop failed"); } }, close: async () => { closed++; } } as unknown as BrowserContext;
    const tools = new PlaywrightTools(context, join(root, String(startupFailure)), () => 1024, () => {}, () => { throw new Error("Unexpected artifact"); });
    if (startupFailure) await assert.rejects(tools.traceStart());
    else { await tools.traceStart(); await assert.rejects(tools.traceStop()); }
    assert.equal(closed, 1); assert.equal(tools.diagnostics({}).trace.status, "error"); await tools.close();
  }
});
test("trace limit abort closes the context if stopping the underlying trace fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-trace-limit-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  let closed = 0;
  const context = { tracing: { start: async () => { writeFileSync(join(root, "trace"), "over budget"); }, stop: async () => { throw new Error("stop failed"); } }, close: async () => { closed++; } } as unknown as BrowserContext;
  const tools = new PlaywrightTools(context, root, () => 1, () => {}, () => { throw new Error("Unexpected artifact"); });
  await tools.traceStart(); const deadline = Date.now() + 3000; while (!closed && Date.now() < deadline) await pause(10);
  assert.equal(closed, 1); assert.equal(tools.diagnostics({}).trace.status, "limit");
  await assert.rejects(tools.traceStop(), { code: "output_limit" }); await tools.close();
});
