import { RecordingStore } from "./recording-store.js";
import { validateBrowserCommand, validateBrowserOpenOptions, type BrowserCommand, type BrowserOpenOptions, type BrowserAuditEntry, type BrowserProfile } from "./commands.js";
import type { BrowserRecording, BrowserRecordingOptions } from "./recording.js";
import { validateInput } from "./session.js";
import { randomUUID } from "node:crypto";
import { BrowserUseError, type BrowserAdapter, type BrowserSession } from "./browser.js";

export type BrowserAction = "navigate" | "evaluate" | "click" | "type" | "press" | "screenshot";
export interface BrowserHandle { id: string; backend: string; profileId?: string; createdAt?: string; lastActivityAt?: string; idleTimeoutMs?: number }

interface RecordingState {
  metadata: BrowserRecording;
  frames: Map<string, Buffer>;
  timer?: ReturnType<typeof setInterval>;
  capture?: Promise<void>;
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, { browser: BrowserSession; busy: boolean; handle: BrowserHandle; activity: number }>();
  private opening = 0;
  private closed = false;
  private readonly openings = new Set<Promise<BrowserHandle>>();
  private readonly closings = new Set<Promise<void>>();
  private closing?: Promise<void>;
  private readonly recordings = new Map<string, RecordingState>();
  private readonly recordingOptions: Required<Omit<BrowserRecordingOptions, "recordingRootDir" | "tenantId">>;
  private readonly recordingStore?: RecordingStore;
  private maintenance?: ReturnType<typeof setInterval>;
  private recordingStorageFailed = false;
  private readonly auditEntries: BrowserAuditEntry[] = [];
  private recordingBytes = 0;
  constructor(readonly adapter: BrowserAdapter, private readonly maxSessions = 4, recordingOptions: BrowserRecordingOptions = {}) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new BrowserUseError("invalid_input", "maxSessions must be a positive integer.");
    const bound = (value: number | undefined, fallback: number, min: number, max: number): number => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || result < min || result > max) throw new BrowserUseError("invalid_input", "Recording options exceed supported bounds.");
      return result;
    };
    this.recordingOptions = {
      recordingTtlMs: bound(recordingOptions.recordingTtlMs, 7 * 86400_000, 100, 365 * 86400_000),
      idleTimeoutMs: bound(recordingOptions.idleTimeoutMs, 900_000, 100, 86400_000),
      auditLimit: bound(recordingOptions.auditLimit, 1000, 1, 10000),
      intervalMs: bound(recordingOptions.intervalMs, 5000, 100, 3_600_000),
      maxFrames: bound(recordingOptions.maxFrames, 120, 1, 10_000),
      maxRecordings: bound(recordingOptions.maxRecordings, 16, 1, 1024),
      maxTotalBytes: bound(recordingOptions.maxTotalBytes, 64 * 1024 * 1024, 1, 1024 * 1024 * 1024),
    };
    if (recordingOptions.recordingRootDir) {
      this.recordingStore = new RecordingStore(recordingOptions.recordingRootDir, recordingOptions.tenantId);
      try {
        for (const metadata of this.recordingStore.recover()) { this.recordings.set(metadata.id, { metadata, frames: new Map() }); this.recordingBytes += metadata.bytes; }
        this.cleanupRecordings(true);
      } catch (error) { this.recordingStore.close(); throw error; }
      this.ensureMaintenance();
    }
  }
  async bindTenant(tenantId?: string): Promise<void> {
    if (this.closed) throw new BrowserUseError("unavailable", "Browser worker is closing.");
    this.recordingStore?.bindTenant(tenantId);
    await this.adapter.bindTenant?.(tenantId);
  }
  get recordingPersistence(): "memory" | "disk" { return this.recordingStore ? "disk" : "memory"; }
  private ensureMaintenance() {
    if (this.maintenance || this.closed) return;
    this.maintenance = setInterval(() => {
      try { this.cleanupRecordings(); } catch { this.recordingStorageFailed = true; }
      for (const [id, session] of this.sessions) {
        if (Date.now() - session.activity >= session.handle.idleTimeoutMs!) {
          this.recordAudit(id, "idle-expired");
          void this.closeSession(id).catch(() => undefined);
        }
      }
    }, 100);
    this.maintenance.unref?.();
  }
  private recordAudit(sessionId: string, event: BrowserAuditEntry["event"], operation?: string, outcome?: BrowserAuditEntry["outcome"]) {
    this.auditEntries.push({ at: new Date().toISOString(), sessionId, backend: this.adapter.name, event, ...(operation ? { operation } : {}), ...(outcome ? { outcome } : {}) });
    if (this.auditEntries.length > this.recordingOptions.auditLimit) this.auditEntries.splice(0, this.auditEntries.length - this.recordingOptions.auditLimit);
  }
  audit(): BrowserAuditEntry[] { return this.auditEntries.map((entry) => ({ ...entry })); }
  async listProfiles(): Promise<BrowserProfile[]> {
    if (!this.adapter.listProfiles) throw new BrowserUseError("unsupported", "This browser backend does not support profiles.");
    return this.adapter.listProfiles();
  }
  async deleteProfile(id: string): Promise<void> {
    if (!this.adapter.deleteProfile) throw new BrowserUseError("unsupported", "This browser backend does not support profiles.");
    await this.adapter.deleteProfile(id);
  }
  open(options: BrowserOpenOptions = {}): Promise<BrowserHandle> {
    const opening = this.openSession(validateBrowserOpenOptions(options));
    this.openings.add(opening);
    void opening.finally(() => this.openings.delete(opening)).catch(() => undefined);
    return opening;
  }
  private async openSession(options: BrowserOpenOptions): Promise<BrowserHandle> {
    if (this.closed) throw new BrowserUseError("unavailable", "Browser worker is closing.");
    if (this.sessions.size + this.opening + this.closings.size >= this.maxSessions) throw new BrowserUseError("capacity", "Browser session capacity reached.");
    this.opening++;
    try {
      const browser = await this.adapter.open(options);
      if (this.closed) { await browser.close(); throw new BrowserUseError("unavailable", "Browser worker is closing."); }
      const id = randomUUID();
      const handle: BrowserHandle = { id, backend: this.adapter.name, ...(options.profileId ? { profileId: options.profileId } : {}), createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), idleTimeoutMs: options.idleTimeoutMs ?? this.recordingOptions.idleTimeoutMs };
      this.sessions.set(id, { browser, busy: false, handle, activity: Date.now() });
      this.recordAudit(id, "opened"); this.ensureMaintenance();
      return { ...handle };
    } finally { this.opening--; }
  }
  list(): BrowserHandle[] { return [...this.sessions.values()].map((session) => ({ ...session.handle })); }
  async perform(id: string, action: BrowserAction, value?: string): Promise<unknown> {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserUseError("not_found", "Browser session not found.");
    if (session.busy) throw new BrowserUseError("busy", "Browser session has an operation in progress.");
    if (action !== "screenshot") validateInput(value!);
    session.busy = true; session.activity = Date.now(); session.handle.lastActivityAt = new Date().toISOString();
    let outcome: "ok" | "error" = "error";
    try {
      outcome = "ok";
      switch (action) {
        case "navigate": await session.browser.navigate(value!); return null;
        case "evaluate": return await session.browser.evaluate(value!);
        case "click": await session.browser.click(value!); return null;
        case "type": await session.browser.type(value!); return null;
        case "press": await session.browser.press(value!); return null;
        case "screenshot": return { mimeType: "image/png", base64: Buffer.from(await session.browser.screenshot()).toString("base64") };
        default: throw new BrowserUseError("invalid_input", "Unknown browser action.");
      }
    } catch (error) { outcome = "error"; throw error; } finally { session.busy = false; session.activity = Date.now(); this.recordAudit(id, "action", action, outcome); }
  }
  async execute(id: string, input: BrowserCommand): Promise<unknown> {
    const command = validateBrowserCommand(input);
    const session = this.sessions.get(id);
    if (!session) throw new BrowserUseError("not_found", "Browser session not found.");
    if (!session.browser.execute) throw new BrowserUseError("unsupported", "Structured browser commands are not supported by this backend.");
    if (session.busy) throw new BrowserUseError("busy", "Browser session has an operation in progress.");
    session.busy = true; session.activity = Date.now(); session.handle.lastActivityAt = new Date().toISOString();
    let outcome: "ok" | "error" = "error";
    try { const result = await session.browser.execute(command); outcome = "ok"; return result; }
    finally { session.busy = false; session.activity = Date.now(); this.recordAudit(id, "action", command.op, outcome); }
  }
  startRecording(sessionId: string): BrowserRecording {
    if (this.closed || this.recordingStorageFailed) throw new BrowserUseError("unavailable", "Browser recording storage is unavailable or closing.");
    this.cleanupRecordings(); this.ensureMaintenance();
    if (!this.sessions.has(sessionId)) throw new BrowserUseError("not_found", "Browser session not found.");
    for (const state of this.recordings.values()) {
      if (state.metadata.sessionId === sessionId && state.metadata.status === "recording") return this.copyRecording(state);
    }
    if (this.recordings.size >= this.recordingOptions.maxRecordings) throw new BrowserUseError("capacity", "Recording capacity reached; delete a retained recording first.");
    const state: RecordingState = {
      metadata: {
        id: randomUUID(), sessionId, backend: this.adapter.name, startedAt: new Date().toISOString(),
        status: "recording", intervalMs: this.recordingOptions.intervalMs, frames: [], bytes: 0, skipped: 0,
      },
      frames: new Map(),
    };
    if (!this.saveRecording(state)) throw new BrowserUseError("storage_error", "Recording could not be persisted.");
    this.recordings.set(state.metadata.id, state);
    state.timer = setInterval(() => this.captureRecording(state), this.recordingOptions.intervalMs);
    state.timer.unref?.();
    this.captureRecording(state);
    return this.copyRecording(state);
  }
  private saveRecording(state: RecordingState): boolean {
    try { this.recordingStore?.save(state.metadata); return true; }
    catch {
      this.recordingStorageFailed = true;
      clearInterval(state.timer); state.timer = undefined;
      state.metadata.status = "error"; state.metadata.error = "Recording persistence failed."; state.metadata.stoppedAt = new Date().toISOString();
      return false;
    }
  }
  private cleanupRecordings(recover = false) {
    if (this.closed && this.recordingStore) return;
    const ordered = [...this.recordings.values()].filter((state) => state.metadata.status !== "recording" && !state.capture).sort((a, b) => (a.metadata.stoppedAt ?? a.metadata.startedAt).localeCompare(b.metadata.stoppedAt ?? b.metadata.startedAt));
    for (const state of ordered) {
      if (Date.now() - Date.parse(state.metadata.stoppedAt ?? state.metadata.startedAt) < this.recordingOptions.recordingTtlMs && !(recover && (this.recordingBytes > this.recordingOptions.maxTotalBytes || this.recordings.size > this.recordingOptions.maxRecordings))) continue;
      this.recordingStore?.delete(state.metadata.id); this.recordings.delete(state.metadata.id); this.recordingBytes -= state.metadata.bytes;
    }
  }
  private copyRecording(state: RecordingState): BrowserRecording {
    return { ...state.metadata, frames: state.metadata.frames.map((frame) => ({ ...frame })) };
  }
  private findRecording(id: string): RecordingState {
    this.cleanupRecordings();
    const state = this.recordings.get(id);
    if (!state) throw new BrowserUseError("not_found", "Browser recording not found.");
    return state;
  }
  private finishRecording(state: RecordingState, status: BrowserRecording["status"] = "stopped") {
    if (state.timer) clearInterval(state.timer);
    state.timer = undefined;
    if (state.metadata.status === "recording") {
      state.metadata.status = status;
      state.metadata.stoppedAt = new Date().toISOString();
      this.saveRecording(state);
    }
  }
  private captureRecording(state: RecordingState): void {
    if (state.metadata.status !== "recording") return;
    const session = this.sessions.get(state.metadata.sessionId);
    if (!session || this.closed || this.recordingStorageFailed) { this.finishRecording(state); return; }
    if (session.busy || state.capture) { state.metadata.skipped++; return; }
    if (state.metadata.frames.length >= this.recordingOptions.maxFrames || this.recordingBytes >= this.recordingOptions.maxTotalBytes) {
      this.finishRecording(state, "limit"); return;
    }
    session.busy = true;
    state.capture = Promise.resolve().then(async () => {
      try {
        const image = await session.browser.screenshot();
        // Stopping discards an unfinished capture; existing frames remain readable.
        if (state.metadata.status !== "recording") return;
        if (image.byteLength > 24 * 1024 * 1024 || image.byteLength > this.recordingOptions.maxTotalBytes - this.recordingBytes) {
          this.finishRecording(state, "limit"); return;
        }
        const frame = { id: randomUUID(), capturedAt: new Date().toISOString(), bytes: image.byteLength };
        if (this.recordingStore) this.recordingStore.frame(state.metadata.id, frame.id, image);
        else state.frames.set(frame.id, Buffer.from(image));
        state.metadata.frames.push(frame);
        state.metadata.bytes += frame.bytes;
        this.recordingBytes += frame.bytes;
        if (!this.saveRecording(state)) return;
        if (state.metadata.frames.length >= this.recordingOptions.maxFrames || this.recordingBytes >= this.recordingOptions.maxTotalBytes) this.finishRecording(state, "limit");
      } catch {
        if (state.metadata.status === "recording") {
          state.metadata.error = "Screenshot capture failed.";
          this.finishRecording(state, "error");
        }
      } finally { session.busy = false; state.capture = undefined; }
    });
  }
  async stopRecording(id: string): Promise<BrowserRecording> {
    const state = this.findRecording(id);
    this.finishRecording(state);
    await state.capture;
    return this.copyRecording(state);
  }
  listRecordings(): BrowserRecording[] { this.cleanupRecordings(); return [...this.recordings.values()].map((state) => this.copyRecording(state)); }
  getRecording(id: string): BrowserRecording { this.cleanupRecordings(); return this.copyRecording(this.findRecording(id)); }
  recordingFrame(id: string, frameId: string): { mimeType: "image/png"; base64: string } {
    if (this.closed && this.recordingStore) throw new BrowserUseError("unavailable", "Recording storage is closed.");
    const state = this.findRecording(id);
    if (!state.metadata.frames.some((frame) => frame.id === frameId)) throw new BrowserUseError("not_found", "Browser recording frame not found.");
    const frame = this.recordingStore ? this.recordingStore.frame(id, frameId) : state.frames.get(frameId);
    if (!frame) throw new BrowserUseError("not_found", "Browser recording frame not found.");
    return { mimeType: "image/png", base64: frame.toString("base64") };
  }
  async deleteRecording(id: string): Promise<void> {
    if (this.closed && this.recordingStore) throw new BrowserUseError("unavailable", "Recording storage is closed.");
    const state = this.findRecording(id);
    await this.stopRecording(id);
    // Concurrent deletes release retained-byte accounting only once.
    this.recordingStore?.delete(id);
    if (this.recordings.delete(id)) this.recordingBytes -= state.metadata.bytes;
  }
  async closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserUseError("not_found", "Browser session not found.");
    this.sessions.delete(id); this.recordAudit(id, "closed");
    const recordings = [...this.recordings.values()].filter((state) => state.metadata.sessionId === id);
    for (const state of recordings) this.finishRecording(state);
    const closing = Promise.resolve().then(async () => {
      // Close first to interrupt any recording screenshot blocked in the backend.
      try { await session.browser.close(); }
      finally { await Promise.all(recordings.map((state) => state.capture)); }
    });
    this.closings.add(closing);
    try { await closing; } finally { this.closings.delete(closing); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.maintenance); this.maintenance = undefined;
    for (const state of this.recordings.values()) this.finishRecording(state);
    this.closing = (async () => {
      const results = await Promise.allSettled([
        ...this.openings, ...this.closings,
        ...[...this.sessions.keys()].map((id) => this.closeSession(id)),
      ]);
      // Opening requests reject when shutdown wins the race; they close their own browser.
      try { await this.adapter.close?.(); } finally { this.recordingStore?.close(); }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected" && !(result.reason instanceof BrowserUseError && result.reason.code === "unavailable"));
      if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Browser shutdown failed.");
    })();
    return this.closing;
  }
}
