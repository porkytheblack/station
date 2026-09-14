import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxError } from "./index.js";

/** Conservative host-local ownership. Unknown/cross-host owners are never stolen. */
export function acquireHostRoot(root: string): () => void {
  const lock = join(root, ".station-owner.json");
  const recovery = join(root, ".station-owner-recovery");
  const token = randomUUID();
  const owner = { pid: process.pid, hostname: hostname(), token };
  const busy = (): never => { throw new SandboxError("busy", "Workspace root has an active or unverifiable owner."); };
  const create = () => {
    if (existsSync(recovery)) busy();
    writeFileSync(lock, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    // Reclaimers reserve the root while inspecting old owners.
    if (existsSync(recovery)) { rmSync(lock); busy(); }
  };
  try { create(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try { mkdirSync(recovery, { mode: 0o700 }); } catch { return busy(); }
    try {
      let previous: { pid: number; hostname: string; token: string };
      try {
        const stat = lstatSync(lock);
        if (!stat.isFile() || stat.size > 4096) return busy();
        previous = JSON.parse(readFileSync(lock, "utf8"));
      } catch { return busy(); }
      if (!previous || previous.hostname !== owner.hostname || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || typeof previous.token !== "string") busy();
      try { process.kill(previous.pid, 0); return busy(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new SandboxError("busy", "Workspace root owner is alive or cannot be verified.");
      }
      rmSync(lock);
      writeFileSync(lock, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    } finally { rmSync(recovery, { recursive: true, force: true }); }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lock, "utf8"));
      if (current.token === token) rmSync(lock);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}
