import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserRecording } from "./recording.js";
import { atomicWrite, directory, entries, lockDirectory, ownedPath, readBounded, safeId, namespaceRoot } from "./storage.js";
import { BrowserUseError } from "./browser.js";

/** Dedicated directory, exclusively owned by one manager. Frame commit precedes metadata commit. */
export class RecordingStore {
  readonly root: string;
  private closed = false;
  private check() { if (this.closed) throw new BrowserUseError("unavailable", "Recording storage is closed."); }
  private readonly release: () => void;
  constructor(root: string, tenantId?: string) {
    this.root = directory(root); namespaceRoot(this.root, "recordings"); this.release = lockDirectory(this.root);
    try { this.bindTenant(tenantId); } catch (reason) { this.close(); throw reason; }
  }
  bindTenant(tenantId?: string): void {
    this.check();
    if (tenantId !== undefined && (typeof tenantId !== "string" || !tenantId || tenantId.length > 200 || /[\0\r\n]/.test(tenantId))) throw new BrowserUseError("invalid_input", "Invalid tenant identity.");
    const path = join(this.root, ".station-tenant.json");
    if (existsSync(path)) {
      if (JSON.parse(readBounded(path, 4096).toString()).tenantId !== tenantId) throw new BrowserUseError("invalid_state", "Recording storage belongs to another tenant.");
    } else if (tenantId !== undefined) {
      if (entries(this.root).length) throw new BrowserUseError("invalid_state", "Existing recordings cannot be assigned to a tenant.");
      atomicWrite(path, JSON.stringify({ tenantId }));
    }
  }
  recover(): BrowserRecording[] {
    this.check();
    const result: BrowserRecording[] = [];
    try {
      for (const id of entries(this.root)) {
        const dir = directory(ownedPath(this.root, id));
        const metadataPath = join(dir, "recording.json");
        if (!existsSync(metadataPath)) {
          // A crash during the first atomic metadata commit can leave only temp files.
          const abandoned = /^[a-f0-9-]{36}$/.test(id) && entries(dir).every((file) => /^recording\.json\.[a-f0-9-]{36}\.tmp$/.test(file));
          if (!abandoned) throw new Error("Unknown recording directory");
          rmSync(dir, { recursive: true }); continue;
        }
        const metadata = JSON.parse(readBounded(metadataPath, 4 * 1024 * 1024).toString()) as BrowserRecording;
        if (!metadata || metadata.id !== id || !Array.isArray(metadata.frames) || metadata.frames.length > 10000 ||
          !["recording", "stopped", "error", "limit"].includes(metadata.status) ||
          !Number.isFinite(Date.parse(metadata.startedAt)) || typeof metadata.backend !== "string" || metadata.backend.length > 100 ||
          !Number.isSafeInteger(metadata.intervalMs) || metadata.intervalMs < 100 || metadata.intervalMs > 3_600_000 ||
          (metadata.status !== "recording" && (!metadata.stoppedAt || !Number.isFinite(Date.parse(metadata.stoppedAt)))) ||
          !Number.isSafeInteger(metadata.skipped) || metadata.skipped < 0) throw new Error("Invalid recording metadata");
        safeId(metadata.sessionId);
        let bytes = 0;
        const frameNames = new Set<string>();
        for (const frame of metadata.frames) {
          safeId(frame.id);
          if (frameNames.has(`${frame.id}.png`) || !Number.isFinite(Date.parse(frame.capturedAt))) throw new Error("Invalid frame metadata");
          const image = readBounded(join(dir, `${frame.id}.png`), 24 * 1024 * 1024);
          if (frame.bytes !== image.byteLength) throw new Error("Invalid frame size");
          bytes += image.byteLength; frameNames.add(`${frame.id}.png`);
        }
        metadata.bytes = bytes;
        if (metadata.status === "recording") { metadata.status = "stopped"; metadata.stoppedAt = new Date().toISOString(); metadata.recovered = true; }
        for (const file of entries(dir)) {
          if (file !== "recording.json" && !frameNames.has(file)) rmSync(join(dir, file), { recursive: true, force: true });
        }
        this.save(metadata);
        result.push(metadata);
      }
      return result;
    } catch { this.release(); throw new BrowserUseError("invalid_state", "Recording storage cannot be recovered safely."); }
  }
  save(metadata: BrowserRecording): void {
    this.check();
    const dir = directory(ownedPath(this.root, metadata.id));
    atomicWrite(join(dir, "recording.json"), JSON.stringify(metadata));
  }
  frame(recordingId: string, frameId: string, image?: Uint8Array): Buffer {
    this.check();
    const dir = directory(ownedPath(this.root, recordingId));
    const path = join(dir, `${safeId(frameId)}.png`);
    if (image) atomicWrite(path, image);
    return image ? Buffer.from(image) : readBounded(path, 24 * 1024 * 1024);
  }
  delete(id: string): void { this.check(); rmSync(ownedPath(this.root, id), { recursive: true, force: true }); }
  close(): void { if (!this.closed) { this.closed = true; this.release(); } }
}
