import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A private worker's retained state cannot be reassigned by editing its tenant configuration. */
export function bindStationTenant(dataDir: string, tenantId?: string): void {
  const path = join(dataDir, "execution-tenant.json");
  if (tenantId !== undefined) {
    try { writeFileSync(path, JSON.stringify({ tenantId }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && tenantId === undefined) return; throw new Error("Unable to verify execution tenant ownership."); }
  if (!saved || typeof saved !== "object" || !Object.hasOwn(saved, "tenantId") || (saved as { tenantId: unknown }).tenantId !== tenantId) throw new Error("Execution data is bound to another tenant; use a fresh data directory for reassignment.");
}
