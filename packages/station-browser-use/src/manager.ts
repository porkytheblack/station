import { BrowserStateStore, safeCheckpointUrl, type BrowserCheckpoint, type DurableBrowserAuditEntry } from "./state-store.js";
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
  private readonly sessions = new Map<string, { browser: BrowserSession; busy: boolean; handle: BrowserHandle; activity: number; options: BrowserOpenOptions; control?: { token: string; expiresAt: number } }>();
  private opening = 0;
  private closed = false;
  private readonly openings = new Set<Promise<BrowserHandle>>();
  private readonly closings = new Set<Promise<void>>();
  private readonly cancelledOpenings = new WeakSet<Error>();
  private closing?: Promise<void>;
  private readonly recordings = new Map<string, RecordingState>();
  private readonly recordingOptions: Required<Omit<BrowserRecordingOptions, "recordingRootDir" | "stateRootDir" | "tenantId">>;
  private readonly recordingStore?: RecordingStore;
  private maintenance?: ReturnType<typeof setInterval>;
  private recordingStorageFailed = false;
  private readonly auditEntries: DurableBrowserAuditEntry[] = [];
  private readonly stateStore?: BrowserStateStore;
  private stateFailed = false;
  private auditSequence = 0;
  private tenantInitialized = false;
  private tenantId?: string;
  private binding?: Promise<void>;
  private used = false;
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
    if (recordingOptions.tenantId !== undefined) {
      if (typeof recordingOptions.tenantId !== "string" || !recordingOptions.tenantId || recordingOptions.tenantId.length > 200 || /[\0\r\n]/.test(recordingOptions.tenantId)) throw new BrowserUseError("invalid_input", "Invalid tenant identity.");
      this.tenantInitialized = true; this.tenantId = recordingOptions.tenantId;
    }
    if (recordingOptions.stateRootDir) this.stateStore = new BrowserStateStore(recordingOptions.stateRootDir, recordingOptions.tenantId);
    try {
    if (recordingOptions.recordingRootDir) {
      this.recordingStore = new RecordingStore(recordingOptions.recordingRootDir, recordingOptions.tenantId);
      try {
        for (const metadata of this.recordingStore.recover()) { this.recordings.set(metadata.id, { metadata, frames: new Map() }); this.recordingBytes += metadata.bytes; }
        this.cleanupRecordings(true);
      } catch (error) { this.recordingStore.close(); throw error; }
      this.ensureMaintenance();
    }
    } catch (error) { this.stateStore?.close(); throw error; }
  }
  async bindTenant(tenantId?: string): Promise<void> {
    if (tenantId !== undefined && (typeof tenantId !== "string" || !tenantId || tenantId.length > 200 || /[\0\r\n]/.test(tenantId))) throw new BrowserUseError("invalid_input", "Invalid tenant identity.");
    if (this.tenantInitialized && this.tenantId !== tenantId) throw new BrowserUseError("invalid_state", "Browser manager belongs to another tenant.");
    if (this.binding) return this.binding;
    this.checkState();
    if (!this.tenantInitialized && tenantId !== undefined && this.used) throw new BrowserUseError("invalid_state", "Existing browser work cannot be assigned to a tenant.");
    this.tenantInitialized = true; this.tenantId = tenantId;
    const binding = (async () => {
      try { this.stateStore?.bindTenant(tenantId); this.recordingStore?.bindTenant(tenantId); await this.adapter.bindTenant?.(tenantId); }
      catch (error) { this.stateFailed = true; throw error; }
    })();
    this.binding = binding;
    try { await binding; } finally { if (this.binding === binding) this.binding = undefined; }
  }
  get recordingPersistence(): "memory" | "disk" { return this.recordingStore ? "disk" : "memory"; }
  private ensureMaintenance() {
    if (this.maintenance || this.closed) return;
    this.maintenance = setInterval(() => {
      try { this.cleanupRecordings(); } catch { this.recordingStorageFailed = true; }
      for (const [id, session] of this.sessions) {
        if (Date.now() - session.activity >= session.handle.idleTimeoutMs!) {
          try { this.recordAudit(id, "idle-expired"); } catch { /* Still reap the expired browser when durable audit storage fails. */ }
          void this.closeSession(id).catch(() => undefined);
        }
      }
    }, 100);
    this.maintenance.unref?.();
  }
  get statePersistence(): "memory" | "disk" { return this.stateStore ? "disk" : "memory"; }
  private checkState() {
    if (this.binding) throw new BrowserUseError("busy", "Browser tenant binding is in progress.");
    if (this.closed || this.stateFailed) throw new BrowserUseError("unavailable", "Browser state storage is unavailable or closing.");
  }
  private recordAudit(sessionId: string, event: BrowserAuditEntry["event"], operation?: string, outcome?: BrowserAuditEntry["outcome"], phase?: "started" | "finished") {
    const entry = { at: new Date().toISOString(), sessionId, backend: this.adapter.name, event, ...(operation ? { operation } : {}), ...(outcome ? { outcome } : {}), ...(phase ? { phase } : {}) };
    try { this.stateStore?.append(entry, this.recordingOptions.auditLimit); }
    catch { this.stateFailed = true; throw new BrowserUseError("storage_error", "Browser action journal could not be persisted."); }
    this.auditEntries.push({ ...entry, sequence: ++this.auditSequence });
    if (this.auditEntries.length > this.recordingOptions.auditLimit) this.auditEntries.splice(0, this.auditEntries.length - this.recordingOptions.auditLimit);
  }
  audit(): DurableBrowserAuditEntry[] { return this.stateStore?.audit() ?? this.auditEntries.map((entry) => ({ ...entry })); }
  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserUseError("not_found", "Browser session not found.");
    if (session.control && session.control.expiresAt <= Date.now()) session.control = undefined;
    return session;
  }
  control(id: string): { mode: "automation" | "human"; expiresAt?: string } {
    const control = this.session(id).control;
    return control ? { mode: "human", expiresAt: new Date(control.expiresAt).toISOString() } : { mode: "automation" };
  }
  private controlTtl(ttl = 30_000) {
    if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 120_000) throw new BrowserUseError("invalid_input", "Control leases must be 1–120 seconds.");
    return ttl;
  }
  acquireControl(id: string, ttlMs?: number) {
    this.checkState(); const ttl = this.controlTtl(ttlMs), session = this.session(id);
    if (session.control || session.busy) throw new BrowserUseError("busy", "Browser already has an owner or active operation.");
    this.recordAudit(id, "action", "controlAcquire", "ok");
    session.control = { token: randomUUID(), expiresAt: Date.now() + ttl };
    session.activity = Date.now();
    return { token: session.control.token, expiresAt: new Date(session.control.expiresAt).toISOString() };
  }
  renewControl(id: string, token: string, ttlMs?: number) {
    this.checkState(); const ttl = this.controlTtl(ttlMs), session = this.session(id);
    if (!session.control || session.control.token !== token) throw new BrowserUseError("busy", "Browser control lease was lost.");
    session.control.expiresAt = Date.now() + ttl; session.activity = Date.now();
    return { expiresAt: new Date(session.control.expiresAt).toISOString() };
  }
  releaseControl(id: string, token: string) {
    const session = this.session(id);
    if (!session.control || session.control.token !== token) throw new BrowserUseError("busy", "Browser control lease was lost.");
    session.control = undefined;
    this.recordAudit(id, "action", "controlRelease", "ok");
  }
  private authorizeControl(id: string, token?: string) {
    const session = this.session(id); this.checkState();
    if (session.control ? session.control.token !== token : token !== undefined) throw new BrowserUseError("busy", "Browser control lease is required or has expired.");
    return session;
  }
  async liveFrame(id: string) {
    this.checkState(); const session = this.session(id);
    if (session.busy) throw new BrowserUseError("busy", "Browser has an operation in progress.");
    session.busy = true;
    try { return { mimeType: "image/png" as const, base64: Buffer.from(await session.browser.screenshot()).toString("base64"), capturedAt: new Date().toISOString() }; }
    finally { session.busy = false; }
  }
  listCheckpoints(): BrowserCheckpoint[] { return this.stateStore?.checkpoints() ?? []; }
  async checkpoint(id: string, controlToken?: string): Promise<BrowserCheckpoint> {
    if (!this.stateStore) throw new BrowserUseError("unsupported", "Durable browser state storage is not configured.");
    const session = this.authorizeControl(id, controlToken);
    const pages = await this.execute(id, { op: "pages" }, controlToken) as import("./commands.js").BrowserPage[];
    const checkpoint: BrowserCheckpoint = { id: randomUUID(), sessionId: id, createdAt: new Date().toISOString(), backend: this.adapter.name, options: { ...session.options }, urls: pages.map(page => safeCheckpointUrl(page.url)), selectedPage: Math.max(0, pages.findIndex(page => page.selected)) };
    this.stateStore.save(checkpoint); this.recordAudit(id, "action", "checkpoint", "ok"); return structuredClone(checkpoint);
  }
  deleteCheckpoint(id: string) { this.checkState(); if (!this.stateStore) throw new BrowserUseError("unsupported", "Durable browser state storage is not configured."); this.stateStore.delete(id); }
  async resumeCheckpoint(id: string): Promise<BrowserHandle> {
    this.checkState(); const checkpoint = this.listCheckpoints().find(item => item.id === id);
    if (!checkpoint) throw new BrowserUseError("not_found", "Checkpoint not found.");
    if (checkpoint.backend !== this.adapter.name) throw new BrowserUseError("unsupported", "Checkpoint backend differs from this worker.");
    const handle = await this.open(checkpoint.options);
    try {
      await this.perform(handle.id, "navigate", checkpoint.urls[0]);
      for (const url of checkpoint.urls.slice(1)) await this.execute(handle.id, { op: "newPage", url });
      const pages = await this.execute(handle.id, { op: "pages" }) as import("./commands.js").BrowserPage[];
      if (pages[checkpoint.selectedPage]) await this.execute(handle.id, { op: "selectPage", pageId: pages[checkpoint.selectedPage].id });
      this.recordAudit(handle.id, "action", "resumeCheckpoint", "ok"); return handle;
    } catch (error) { await this.closeSession(handle.id).catch(() => undefined); throw error; }
  }
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
    this.checkState();
    if (this.sessions.size + this.opening + this.closings.size >= this.maxSessions) throw new BrowserUseError("capacity", "Browser session capacity reached.");
    this.used = true;
    this.opening++;
    try {
      const browser = await this.adapter.open(options);
      if (this.closed) {
        await browser.close();
        const cancelled = new BrowserUseError("unavailable", "Browser worker is closing.");
        this.cancelledOpenings.add(cancelled);
        throw cancelled;
      }
      const id = randomUUID();
      const handle: BrowserHandle = { id, backend: this.adapter.name, ...(options.profileId ? { profileId: options.profileId } : {}), createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), idleTimeoutMs: options.idleTimeoutMs ?? this.recordingOptions.idleTimeoutMs };
      this.sessions.set(id, { browser, busy: false, handle, activity: Date.now(), options: { ...options } });
      try { this.recordAudit(id, "opened"); } catch (error) { this.sessions.delete(id); await browser.close(); throw error; }
      this.ensureMaintenance();
      return { ...handle };
    } finally { this.opening--; }
  }
  list(): BrowserHandle[] { return [...this.sessions.values()].map((session) => ({ ...session.handle })); }
  async perform(id: string, action: BrowserAction, value?: string, controlToken?: string): Promise<unknown> {
    const session = this.authorizeControl(id, controlToken);
    if (session.busy) throw new BrowserUseError("busy", "Browser session has an operation in progress.");
    if (action !== "screenshot") validateInput(value!);
    this.recordAudit(id, "action", action, undefined, "started");
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
    } catch (error) { outcome = "error"; throw error; } finally { session.busy = false; session.activity = Date.now(); this.recordAudit(id, "action", action, outcome, "finished"); }
  }
  async execute(id: string, input: BrowserCommand, controlToken?: string): Promise<unknown> {
    const command = validateBrowserCommand(input);
    const session = this.authorizeControl(id, controlToken);
    if (!session.browser.execute) throw new BrowserUseError("unsupported", "Structured browser commands are not supported by this backend.");
    if (session.busy) throw new BrowserUseError("busy", "Browser session has an operation in progress.");
    this.recordAudit(id, "action", command.op, undefined, "started");
    session.busy = true; session.activity = Date.now(); session.handle.lastActivityAt = new Date().toISOString();
    let outcome: "ok" | "error" = "error";
    try { const result = await session.browser.execute(command); outcome = "ok"; return result; }
    finally { session.busy = false; session.activity = Date.now(); this.recordAudit(id, "action", command.op, outcome, "finished"); }
  }
  startRecording(sessionId: string): BrowserRecording {
    this.checkState();
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
  async requestCloseSession(id: string, controlToken?: string) {
    const session = this.session(id);
    if (session.control ? session.control.token !== controlToken : controlToken !== undefined) throw new BrowserUseError("busy", "Browser control lease is required or has expired.");
    await this.closeSession(id);
  }
  async closeSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserUseError("not_found", "Browser session not found.");
    this.sessions.delete(id);
    // Cleanup must run even if the journal is unavailable.
    let auditError: unknown;
    try { this.recordAudit(id, "closed"); } catch (error) { auditError = error; }
    const recordings = [...this.recordings.values()].filter((state) => state.metadata.sessionId === id);
    for (const state of recordings) this.finishRecording(state);
    const closing = Promise.resolve().then(async () => {
      // Close first to interrupt any recording screenshot blocked in the backend.
      try { await session.browser.close(); }
      finally { await Promise.all(recordings.map((state) => state.capture)); }
    });
    this.closings.add(closing);
    try { await closing; if (auditError) throw auditError; } finally { this.closings.delete(closing); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.maintenance); this.maintenance = undefined;
    for (const state of this.recordings.values()) this.finishRecording(state);
    this.closing = (async () => {
      const results = await Promise.allSettled([
        ...(this.binding ? [this.binding] : []), ...this.openings, ...this.closings,
        ...[...this.sessions.keys()].map((id) => this.closeSession(id)),
      ]);
      // Opening requests reject when shutdown wins the race; they close their own browser.
      try { await this.adapter.close?.(); } catch (reason) { results.push({ status: "rejected", reason }); }
      // Each storage owner must be released even if another release fails.
      for (const store of [this.recordingStore, this.stateStore]) {
        try { store?.close(); } catch (reason) { results.push({ status: "rejected", reason }); }
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected" && !(result.reason instanceof Error && this.cancelledOpenings.has(result.reason)));
      if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Browser shutdown failed.");
    })();
    return this.closing;
  }
}
