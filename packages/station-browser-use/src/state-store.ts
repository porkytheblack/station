import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, directory, lockDirectory, namespaceRoot, readBounded, safeId } from "./storage.js";
import { BrowserUseError } from "./browser.js";
import { validateBrowserOpenOptions, type BrowserAuditEntry, type BrowserOpenOptions } from "./commands.js";

export interface DurableBrowserAuditEntry extends BrowserAuditEntry { sequence: number; phase?: "started" | "finished" }
export interface BrowserCheckpoint {
  id: string; sessionId: string; createdAt: string; backend: string;
  options: BrowserOpenOptions; urls: string[]; selectedPage: number;
}
interface State { version: 1; sequence: number; audit: DurableBrowserAuditEntry[]; checkpoints: BrowserCheckpoint[] }
/** Bounded, atomic single-worker journal. External storage fencing is required for failover. */
export class BrowserStateStore {
  private readonly root: string;
  private readonly release: () => void;
  private closed = false;
  private state: State = { version: 1, sequence: 0, audit: [], checkpoints: [] };
  constructor(root: string, tenantId?: string) {
    this.root = directory(root); namespaceRoot(this.root, "browser-state"); this.release = lockDirectory(this.root);
    try {
      this.bindTenant(tenantId);
      const file = join(this.root, "state.json");
      if (existsSync(file)) {
        const value = JSON.parse(readBounded(file, 16 * 1024 * 1024).toString()) as State;
        if (value.version !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.audit) || value.audit.length > 10000 || !Array.isArray(value.checkpoints) || value.checkpoints.length > 64) throw Error("Invalid journal");
        let previous = 0;
        for (const entry of value.audit) {
          if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previous || entry.sequence > value.sequence || !Number.isFinite(Date.parse(entry.at)) || !["opened", "closed", "action", "idle-expired"].includes(entry.event) || typeof entry.backend !== "string" || entry.backend.length > 100 || (entry.operation !== undefined && !/^[a-zA-Z_-]{1,100}$/.test(entry.operation)) || (entry.outcome !== undefined && !["ok", "error"].includes(entry.outcome)) || (entry.phase !== undefined && !["started", "finished"].includes(entry.phase))) throw Error("Invalid audit entry");
          safeId(entry.sessionId); previous = entry.sequence;
        }
        for (const checkpoint of value.checkpoints) {
          safeId(checkpoint.id); safeId(checkpoint.sessionId);
          if (!Number.isFinite(Date.parse(checkpoint.createdAt)) || typeof checkpoint.backend !== "string" || checkpoint.backend.length > 100 || !Array.isArray(checkpoint.urls) || checkpoint.urls.length > 64 || !checkpoint.urls.length || !Number.isInteger(checkpoint.selectedPage) || checkpoint.selectedPage < 0 || checkpoint.selectedPage >= checkpoint.urls.length) throw Error("Invalid checkpoint");
          for (const url of checkpoint.urls) if (safeCheckpointUrl(url) !== url) throw Error("Invalid checkpoint URL");
          validateBrowserOpenOptions(checkpoint.options);
        }
        this.state = value;
      }
    } catch { this.release(); throw new BrowserUseError("invalid_state", "Browser state cannot be recovered safely."); }
  }
  bindTenant(tenantId?: string) {
    this.check();
    if (tenantId !== undefined && (typeof tenantId !== "string" || !tenantId || tenantId.length > 200 || /[\0\r\n]/.test(tenantId))) throw new BrowserUseError("invalid_input", "Invalid tenant identity.");
    const path = join(this.root, ".station-tenant.json");
    if (existsSync(path)) { if (JSON.parse(readBounded(path, 4096).toString()).tenantId !== tenantId) throw new BrowserUseError("invalid_state", "Browser state belongs to another tenant."); }
    else if (tenantId !== undefined) {
      if (existsSync(join(this.root, "state.json"))) throw new BrowserUseError("invalid_state", "Existing browser state cannot be assigned to a tenant.");
      atomicWrite(path, JSON.stringify({ tenantId }));
    }
  }
  private check() { if (this.closed) throw new BrowserUseError("unavailable", "Browser state store is closed."); }
  private commit(state: State) { this.check(); const json = JSON.stringify(state); if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new BrowserUseError("capacity", "Browser state journal exceeds 8 MiB."); atomicWrite(join(this.root, "state.json"), json); this.state = state; }
  audit(): DurableBrowserAuditEntry[] { this.check(); return structuredClone(this.state.audit); }
  append(entry: BrowserAuditEntry & { phase?: "started" | "finished" }, limit: number) {
    const audit = [...this.state.audit, { ...entry, sequence: this.state.sequence + 1 }].slice(-limit);
    this.commit({ ...this.state, sequence: this.state.sequence + 1, audit });
  }
  checkpoints(): BrowserCheckpoint[] { this.check(); return structuredClone(this.state.checkpoints); }
  save(checkpoint: BrowserCheckpoint) {
    if (this.state.checkpoints.length >= 64) throw new BrowserUseError("capacity", "Checkpoint capacity reached; delete a checkpoint first.");
    this.commit({ ...this.state, checkpoints: [...this.state.checkpoints, structuredClone(checkpoint)] });
  }
  delete(id: string) { safeId(id); if (!this.state.checkpoints.some(item => item.id === id)) throw new BrowserUseError("not_found", "Checkpoint not found."); this.commit({ ...this.state, checkpoints: this.state.checkpoints.filter(item => item.id !== id) }); }
  close() { if (!this.closed) { this.closed = true; this.release(); } }
}
/** Recovery intentionally omits URL secrets and only repeats explicit HTTP(S) navigation. */
export function safeCheckpointUrl(value: string): string {
  if (value === "about:blank") return value;
  if (typeof value !== "string" || value.length > 8192) throw new BrowserUseError("invalid_input", "Checkpoint URL exceeds limits.");
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserUseError("invalid_input", "Checkpoint requires HTTP(S) pages."); }
  if (!["https:", "http:"].includes(url.protocol)) throw new BrowserUseError("invalid_input", "Checkpoint requires HTTP(S) pages.");
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.toString();
}
