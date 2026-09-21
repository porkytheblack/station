import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindStationTenant } from "../../src/server/tenant-binding.js";

test("tenant data ownership survives restart and rejects reassignment, removal and corrupt markers", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "station-tenant-binding-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  bindStationTenant(dir);
  bindStationTenant(dir, "customer-a");
  bindStationTenant(dir, "customer-a");
  assert.throws(() => bindStationTenant(dir, "customer-b"), /another tenant/);
  assert.throws(() => bindStationTenant(dir), /another tenant/);
  writeFileSync(join(dir, "execution-tenant.json"), "not-json");
  assert.throws(() => bindStationTenant(dir, "customer-a"), /verify/);
});
