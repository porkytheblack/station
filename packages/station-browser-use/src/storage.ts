import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { BrowserUseError } from "./browser.js";
export const safeId = (id: string): string => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new BrowserUseError("invalid_input", "Invalid resource identifier.");
  return id;
};
export function directory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new BrowserUseError("invalid_state", "Storage directory is invalid.");
  return realpathSync(path);
}
export function ownedPath(root: string, id: string): string {
  const path = join(root, safeId(id));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new BrowserUseError("invalid_state", "Storage links are not supported.");
  return path;
}
export function atomicWrite(path: string, value: string | Uint8Array) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new BrowserUseError("invalid_state", "Storage file is invalid.");
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const parent = openSync(resolve(path, ".."), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
}
export function readBounded(path: string, max: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new BrowserUseError("invalid_state", "Storage file exceeds limits or is invalid.");
  return readFileSync(path);
}
/** Exclusive single-host ownership. Live/remote/invalid locks fail closed. */
export function lockDirectory(root: string): () => void {
  const path = join(root, ".station-owner.json");
  const identity = { pid: process.pid, hostname: hostname(), token: randomUUID() };
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const recovery = join(root, ".station-recovery");
    try { mkdirSync(recovery, { mode: 0o700 }); } catch { throw new BrowserUseError("busy", "Storage ownership recovery is already in progress."); }
    try {
      let previous: typeof identity;
      try { previous = JSON.parse(readBounded(path, 4096).toString()); } catch { throw new BrowserUseError("busy", "Storage ownership cannot be verified."); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || previous.hostname !== hostname()) throw new BrowserUseError("busy", "Storage belongs to another owner.");
      try { process.kill(previous.pid, 0); throw new BrowserUseError("busy", "Storage already has a live owner."); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw new BrowserUseError("busy", "Storage already has an owner."); }
      rmSync(path);
      try { fd = openSync(path, "wx", 0o600); } catch { throw new BrowserUseError("busy", "Storage owner changed."); }
    } finally { rmSync(recovery, { recursive: true, force: true }); }
  }
  try { writeFileSync(fd, JSON.stringify(identity)); fsyncSync(fd); } finally { closeSync(fd); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (existsSync(path) && JSON.parse(readBounded(path, 4096).toString()).token === identity.token) rmSync(path);
  };
}
export function entries(root: string): string[] { return readdirSync(root).filter((name) => !name.startsWith(".")); }
export function namespaceRoot(root: string, kind: "recordings" | "profiles"): void {
  const path = join(root, ".station-store.json");
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600); writeFileSync(fd, JSON.stringify({ version: 1, kind })); fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let value;
    try { value = JSON.parse(readBounded(path, 4096).toString()); } catch { throw new BrowserUseError("invalid_state", "Storage namespace cannot be verified."); }
    if (value.version !== 1 || value.kind !== kind) throw new BrowserUseError("invalid_state", "Storage root belongs to a different resource type.");
  } finally { if (fd !== undefined) closeSync(fd); }
}
