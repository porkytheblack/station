import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLog } from "../src/logs.js";
test("local logs follow append, rotation and truncation, and abort without stopping the service", async t => {
  const dir = await mkdtemp(join(tmpdir(), "station-logs-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "daemon.log"); await writeFile(path, "start\n");
  const controller = new AbortController();
  const log = followLog(path, { signal: controller.signal, follow: true, pollMs: 1 });
  assert.equal((await log.next()).value?.toString(), "start\n");
  await appendFile(path, "next\n"); assert.equal((await log.next()).value?.toString(), "next\n");
  await rename(path, path + ".old"); await writeFile(path, "rotated\n");
  assert.equal((await log.next()).value?.toString(), "rotated\n");
  await writeFile(path, "x\n"); assert.equal((await log.next()).value?.toString(), "x\n");
  controller.abort(); assert.equal((await log.next()).done, true);
});
