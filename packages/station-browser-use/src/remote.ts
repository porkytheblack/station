import { chromium, type Browser } from "playwright";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PlaywrightBrowserAdapter, type PlaywrightBrowserOptions, type PlaywrightConnection } from "./playwright.js";
import { BrowserUseError, type BrowserSession } from "./browser.js";
import type { BrowserOpenOptions, BrowserProfile } from "./commands.js";
import { atomicWrite, directory, lockDirectory, readBounded, safeId } from "./storage.js";

export interface RemoteBrowserOptions extends Pick<PlaywrightBrowserOptions, "timeoutMs" | "maxPages" | "maxArtifacts" | "maxArtifactBytes" | "reliability"> {
  apiKey: string;
  projectId: string;
  /** Private controller storage. Holds IDs/ownership, never API keys or CDP URLs. */
  rootDir: string;
  tenantId?: string;
  /** Local profile aliases -> pre-provisioned provider context/profile IDs. */
  profiles?: Record<string, string>;
  /** Hard provider lifetime; defaults to 15 minutes, independent of Station idle expiry. */
  sessionTimeoutMs?: number;
  /** Operator attestation after verifying the provider deployment's tenant/egress policies. */
  deployment?: { isolated: boolean; networkRestricted: boolean };
  /** Trusted transport injection for testing; never an agent argument. */
  fetch?: typeof globalThis.fetch;
}
export interface BrowserbaseBrowserOptions extends RemoteBrowserOptions {
  proxies?: boolean | Array<Record<string, unknown>>;
  region?: "us-west-2" | "us-east-1" | "eu-central-1" | "ap-southeast-1";
  browserSettings?: { solveCaptchas?: boolean; verified?: boolean; blockAds?: boolean };
}
export interface SteelBrowserOptions extends RemoteBrowserOptions {
  useProxy?: boolean | Record<string, unknown>;
  proxyUrl?: string;
  solveCaptcha?: boolean;
}
export interface RemoteSessionRecord { id: string; providerSessionId?: string; profileId?: string; createdAt: string }
type Provider = "browserbase" | "steel";
type Ledger = { version: 1; provider: Provider; projectId: string; tenantId: string | null; profiles: Record<string, string>; sessions: RemoteSessionRecord[] };
class ProviderError extends BrowserUseError { constructor(code: string, readonly definitive: boolean) { super(code, "Browser provider request failed. Inspect provider configuration or reconcile retained session IDs."); } }

/** Shared lifecycle journal and CDP attachment. No blind create retries or local fallback. */
export abstract class RemoteBrowserAdapter extends PlaywrightBrowserAdapter {
  private readonly statePath: string;
  private readonly unlock: () => void;
  private readonly ledger: Ledger;
  private readonly live = new Map<string, BrowserSession>();
  private readonly opening = new Set<Promise<BrowserSession>>();
  private readonly activeRecords = new Set<string>();
  private stopped = false;
  private broken = false;
  private closing?: Promise<void>;
  private released = false;
  private reconciling = false;
  protected readonly lifetime: number;
  protected constructor(readonly name: Provider, protected readonly remoteOptions: RemoteBrowserOptions) {
    super({ timeoutMs: remoteOptions.timeoutMs, maxPages: remoteOptions.maxPages, maxArtifacts: remoteOptions.maxArtifacts, maxArtifactBytes: remoteOptions.maxArtifactBytes, reliability: remoteOptions.reliability ?? {} });
    if (typeof remoteOptions.apiKey !== "string" || !remoteOptions.apiKey || /[\r\n]/.test(remoteOptions.apiKey)) throw new BrowserUseError("invalid_input", "Provider API key is required.");
    safeId(remoteOptions.projectId);
    if (remoteOptions.tenantId !== undefined && (typeof remoteOptions.tenantId !== "string" || !remoteOptions.tenantId || remoteOptions.tenantId.length > 200 || /[\0\r\n]/.test(remoteOptions.tenantId))) throw new BrowserUseError("invalid_input", "Invalid tenant identity.");
    this.lifetime = remoteOptions.sessionTimeoutMs ?? 900000;
    if (!Number.isSafeInteger(this.lifetime) || this.lifetime < 60000 || this.lifetime > 21600000) throw new BrowserUseError("invalid_input", "Remote session lifetime must be 1 minute to 6 hours.");
    const profiles = { ...remoteOptions.profiles };
    for (const [alias, id] of Object.entries(profiles)) { safeId(alias); safeId(id); }
    if (new Set(Object.values(profiles)).size !== Object.keys(profiles).length) throw new BrowserUseError("invalid_input", "Provider profiles cannot have multiple aliases.");
    Object.assign(this.capabilities, { profiles: Object.keys(profiles).length > 0, tracing: false, downloads: false,
      isolated: remoteOptions.deployment?.isolated === true, networkRestricted: remoteOptions.deployment?.networkRestricted === true });
    const root = directory(remoteOptions.rootDir); this.statePath = join(root, ".station-remote.json"); this.unlock = lockDirectory(root);
    try {
      const identity = { version: 1 as const, provider: name, projectId: remoteOptions.projectId, tenantId: remoteOptions.tenantId ?? null, profiles };
      this.ledger = existsSync(this.statePath) ? JSON.parse(readBounded(this.statePath, 1024 * 1024).toString()) : { ...identity, sessions: [] };
      const saved = this.ledger;
      if (saved.version !== 1 || saved.provider !== name || saved.projectId !== identity.projectId || saved.tenantId !== identity.tenantId || JSON.stringify(Object.entries(saved.profiles).sort()) !== JSON.stringify(Object.entries(profiles).sort()) || !Array.isArray(saved.sessions) || saved.sessions.length > 1024) throw new BrowserUseError("invalid_state", "Remote storage identity or profile grants changed.");
      const ids = new Set<string>();
      for (const item of saved.sessions) { safeId(item.id); if (ids.has(item.id)) throw new Error(); ids.add(item.id); if (item.providerSessionId) safeId(item.providerSessionId); if (!Number.isFinite(Date.parse(item.createdAt)) || item.profileId && !Object.hasOwn(profiles, item.profileId)) throw new Error(); }
      this.save();
    } catch { this.unlock(); throw new BrowserUseError("invalid_state", "Remote browser storage cannot be verified."); }
  }
  private save() { try { atomicWrite(this.statePath, JSON.stringify(this.ledger)); } catch { this.broken = true; throw new BrowserUseError("unavailable", "Remote lifecycle journal could not be saved."); } }
  private forget(id: string) { this.ledger.sessions = this.ledger.sessions.filter(record => record.id !== id); this.save(); }
  async bindTenant(tenantId?: string) {
    if ((tenantId ?? null) !== this.ledger.tenantId) throw new BrowserUseError("invalid_state", "Remote browser storage belongs to another tenant.");
  }
  override async listProfiles(): Promise<BrowserProfile[]> {
    return Object.keys(this.ledger.profiles).map(id => ({ id, inUse: this.ledger.sessions.some(record => record.profileId === id) }));
  }
  override async deleteProfile(_id: string): Promise<void> { throw new BrowserUseError("unsupported", "Provider profiles are operator-managed; remove them through the provider after releasing sessions."); }
  /** Operator-only recovery view; IDs are not authentication URLs. */
  pendingSessions(): RemoteSessionRecord[] { return this.ledger.sessions.filter(record => !this.activeRecords.has(record.id)).map(record => ({ ...record })); }
  /** Release orphaned known sessions. For uncertain creates, supply a reconciled provider ID,
   * or null only after the operator has verified no live session remains in the provider. */
  async reconcile(resolutions: Record<string, string | null> = {}): Promise<void> {
    if (this.released || this.reconciling || this.opening.size || this.live.size) throw new BrowserUseError("busy", "Stop live sessions before reconciliation on an owned adapter.");
    this.reconciling = true;
    try {
    for (const record of [...this.ledger.sessions]) {
      if (!record.providerSessionId && Object.hasOwn(resolutions, record.id)) {
        if (resolutions[record.id] === null) { this.forget(record.id); continue; }
        record.providerSessionId = safeId(resolutions[record.id]!); this.save();
      }
      if (!record.providerSessionId) throw new BrowserUseError("provider_unavailable", "Uncertain provider creation requires operator reconciliation.");
      await this.releaseProvider(record.providerSessionId); this.forget(record.id);
    }
    } finally { this.reconciling = false; }
  }
  override open(options: BrowserOpenOptions = {}): Promise<BrowserSession> {
    if (this.stopped || this.reconciling || this.broken || this.pendingSessions().length) return Promise.reject(new BrowserUseError("provider_unavailable", "Remote adapter requires reconciliation or is closed."));
    const task = super.open(options).then(session => {
      if (this.stopped) return session.close().then(() => { throw new BrowserUseError("unavailable", "Remote adapter closed during creation."); });
      const id = randomUUID();
      const wrapped = { ...session, close: async () => { try { await session.close(); } finally { this.live.delete(id); } } };
      this.live.set(id, wrapped); return wrapped;
    });
    this.opening.add(task); void task.finally(() => this.opening.delete(task)).catch(() => undefined); return task;
  }
  protected async request(path: string, body: unknown, allowMissing = false): Promise<Record<string, unknown>> {
    const base = this.name === "browserbase" ? "https://api.browserbase.com" : "https://api.steel.dev";
    const auth = this.name === "browserbase" ? "X-BB-API-Key" : "steel-api-key";
    try {
      const response = await (this.remoteOptions.fetch ?? globalThis.fetch)(`${base}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.remoteOptions.timeoutMs ?? 30000),
        headers: { "Content-Type": "application/json", [auth]: this.remoteOptions.apiKey }, body: JSON.stringify(body),
      });
      if (allowMissing && (response.status === 404 || response.status === 410)) { await response.body?.cancel(); return {}; }
      if (!response.ok) {
        await response.body?.cancel();
        const definitive = [400, 401, 403, 404, 409, 422, 429].includes(response.status);
        throw new ProviderError([401, 403].includes(response.status) ? "provider_auth" : response.status === 429 ? "provider_capacity" : "provider_unavailable", definitive);
      }
      const reader = response.body?.getReader(); if (!reader) return {};
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 1024 * 1024) throw new Error(); chunks.push(chunk.value); } }
      finally { await reader.cancel(); }
      if (!bytes) return {};
      const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(); return result;
    } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("provider_unavailable", false); }
  }
  protected abstract createProvider(options: BrowserOpenOptions, requestId: string): Promise<Record<string, unknown>>;
  protected abstract connectionUrl(response: Record<string, unknown>): string;
  protected releaseProvider(id: string) {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}${this.name === "steel" ? "/release" : ""}`, this.name === "browserbase" ? { projectId: this.remoteOptions.projectId, status: "REQUEST_RELEASE" } : {}, true).then(() => undefined);
  }
  /** Overridable for protocol tests. Production always connects to an authenticated provider URL. */
  protected attach(endpoint: string, artifactsDir: string): Promise<Browser> {
    return chromium.connectOverCDP(endpoint, { timeout: this.remoteOptions.timeoutMs ?? 30000, artifactsDir });
  }
  protected override async connectRemote(options: BrowserOpenOptions, artifactsDir: string): Promise<PlaywrightConnection> {
    if (options.profileId && !Object.hasOwn(this.ledger.profiles, options.profileId)) throw new BrowserUseError("not_found", "Provider profile is not granted to this worker.");
    if (options.profileId && this.ledger.sessions.some(record => record.profileId === options.profileId)) throw new BrowserUseError("busy", "Provider profile is already in use or awaiting reconciliation.");
    if (this.ledger.sessions.length >= 1024) throw new BrowserUseError("capacity", "Remote lifecycle journal capacity reached.");
    const record: RemoteSessionRecord = { id: randomUUID(), createdAt: new Date().toISOString(), ...(options.profileId ? { profileId: options.profileId } : {}) };
    this.ledger.sessions.push(record); this.activeRecords.add(record.id);
    let browser: Browser | undefined;
    const release = async () => {
      try { if (record.providerSessionId) { await this.releaseProvider(record.providerSessionId); this.forget(record.id); } }
      finally { this.activeRecords.delete(record.id); await browser?.close().catch(() => undefined); }
    };
    try {
      this.save();
      const response = await this.createProvider(options, record.id);
      record.providerSessionId = safeId(response.id as string); this.save();
      browser = await this.attach(this.connectionUrl(response), artifactsDir);
      const context = browser.contexts()[0]; if (!context) throw new Error();
      let closing: Promise<void> | undefined;
      return { context, provider: { name: this.name, sessionId: record.providerSessionId }, isConnected: () => browser!.isConnected(), close: () => closing ??= release() };
    } catch (error) {
      if (error instanceof ProviderError && error.definitive && !record.providerSessionId) this.forget(record.id);
      try { await release(); } catch { throw new BrowserUseError("provider_unavailable", "Provider session cleanup needs reconciliation."); }
      if (error instanceof ProviderError) throw error;
      throw new BrowserUseError("provider_unavailable", "Remote browser could not connect; inspect pending sessions before retrying.");
    }
  }
  protected profile(id?: string) { return id ? this.ledger.profiles[id] : undefined; }
  async close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped = true;
      try {
        await Promise.allSettled(this.opening);
        await Promise.allSettled([...this.live.values()].map(session => session.close()));
        await this.reconcile();
      } finally { this.released = true; this.unlock(); }
    })();
  }
}

export class BrowserbaseBrowserAdapter extends RemoteBrowserAdapter {
  constructor(private readonly settings: BrowserbaseBrowserOptions) { super("browserbase", settings); }
  protected createProvider(options: BrowserOpenOptions, requestId: string) {
    return this.request("/v1/sessions", { projectId: this.settings.projectId, timeout: Math.ceil(this.lifetime / 1000), keepAlive: false,
      ...(this.settings.region ? { region: this.settings.region } : {}), proxies: this.settings.proxies ?? false, userMetadata: { stationRequestId: requestId },
      browserSettings: { ...this.settings.browserSettings, ...(options.viewport ? { viewport: options.viewport } : {}),
        ...(options.profileId ? { context: { id: this.profile(options.profileId), persist: true } } : {}) } });
  }
  protected connectionUrl(response: Record<string, unknown>): string {
    const url = new URL(String(response.connectUrl));
    if (url.protocol !== "wss:" || url.username || url.password || !(url.hostname === "connect.browserbase.com" || url.hostname.endsWith(".browserbase.com"))) throw new Error();
    return url.href;
  }
}
export class SteelBrowserAdapter extends RemoteBrowserAdapter {
  constructor(private readonly settings: SteelBrowserOptions) { super("steel", settings); }
  protected createProvider(options: BrowserOpenOptions) {
    return this.request("/v1/sessions", { projectId: this.settings.projectId, timeout: this.lifetime,
      useProxy: this.settings.useProxy ?? false, ...(this.settings.proxyUrl ? { proxyUrl: this.settings.proxyUrl } : {}),
      solveCaptcha: this.settings.solveCaptcha ?? false, debugConfig: { interactive: false },
      ...(options.viewport ? { dimensions: options.viewport } : {}),
      ...(options.profileId ? { profileId: this.profile(options.profileId), persistProfile: true } : {}) });
  }
  protected connectionUrl(response: Record<string, unknown>): string {
    const url = new URL("wss://connect.steel.dev"); url.searchParams.set("apiKey", this.settings.apiKey); url.searchParams.set("sessionId", safeId(response.id as string)); return url.href;
  }
}
