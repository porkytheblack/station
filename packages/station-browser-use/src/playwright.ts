import { managedSession, validateTimeout } from "./session.js";
import { BrowserUseError, type BrowserAdapter, type BrowserSession } from "./browser.js";
import { validateBrowserCommand, validateBrowserOpenOptions, type BrowserArtifact, type BrowserCommand, type BrowserOpenOptions, type BrowserPage, type BrowserProfile, type BrowserViewport } from "./commands.js";
import { directory, entries, lockDirectory, ownedPath, safeId, namespaceRoot } from "./storage.js";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
export interface PlaywrightBrowserOptions {
  executablePath?: string;
  timeoutMs?: number;
  profileRootDir?: string;
  viewport?: BrowserViewport;
  /** Operator configuration only. Never returned in session/audit metadata. */
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  maxPages?: number;
  /** Aggregate bytes retained by downloads in one session; default 4 MiB. */
  maxArtifactBytes?: number;
  maxArtifacts?: number;
}
export class PlaywrightBrowserAdapter implements BrowserAdapter {
  readonly name = "playwright";
  readonly capabilities: BrowserAdapter["capabilities"];
  private readonly profileRoot?: string;
  constructor(private readonly options: PlaywrightBrowserOptions = {}) {
    this.capabilities = { screenshots: true, independentSessions: true, isolated: false, networkRestricted: false, profiles: Boolean(options.profileRootDir), pages: true, commands: true, uploads: true, downloads: true };
    validateTimeout(options.timeoutMs ?? 30_000);
    validateBrowserOpenOptions({ viewport: options.viewport });
    for (const [value, max] of [[options.maxPages ?? 8, 64], [options.maxArtifacts ?? 16, 128], [options.maxArtifactBytes ?? 4 * 1024 * 1024, 16 * 1024 * 1024]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new BrowserUseError("invalid_input", "Invalid browser resource limits.");
    }
    if (options.profileRootDir) { this.profileRoot = directory(options.profileRootDir); namespaceRoot(this.profileRoot, "profiles"); }
  }
  async listProfiles(): Promise<BrowserProfile[]> {
    if (!this.profileRoot) return [];
    return entries(this.profileRoot).map((id) => ({ id: safeId(id), inUse: existsSync(join(ownedPath(this.profileRoot!, id), ".station-owner.json")) }));
  }
  async deleteProfile(id: string): Promise<void> {
    if (!this.profileRoot) throw new BrowserUseError("unsupported", "Persistent profiles are not configured.");
    const path = ownedPath(this.profileRoot, id);
    if (!existsSync(path)) throw new BrowserUseError("not_found", "Browser profile not found.");
    const release = lockDirectory(path);
    const deleted = join(this.profileRoot, `.deleted-${randomUUID()}`);
    try { renameSync(path, deleted); } finally { release(); }
    rmSync(deleted, { recursive: true, force: true });
  }
  async open(input: BrowserOpenOptions = {}): Promise<BrowserSession> {
    const options = validateBrowserOpenOptions(input);
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const { chromium } = await import("playwright");
    const downloadsPath = mkdtempSync(join(tmpdir(), "station-browser-downloads-"));
    let release: (() => void) | undefined;
    let context: BrowserContext | undefined;
    let closeProcess: (() => Promise<void>) | undefined;
    try {
      const settings = { headless: true, executablePath: this.options.executablePath, timeout: timeoutMs, proxy: this.options.proxy, downloadsPath };
      const viewport = options.viewport ?? this.options.viewport ?? { width: 1280, height: 720 };
      if (options.profileId) {
        if (!this.profileRoot) throw new BrowserUseError("unsupported", "Persistent profiles are not configured.");
        const path = directory(ownedPath(this.profileRoot, options.profileId));
        release = lockDirectory(path);
        context = await chromium.launchPersistentContext(path, { ...settings, viewport, acceptDownloads: true });
        closeProcess = () => context!.close();
      } else {
        const browser = await chromium.launch(settings);
        closeProcess = () => browser.close();
        context = await browser.newContext({ viewport, acceptDownloads: true });
      }
      context.setDefaultTimeout(timeoutMs);
      const pages = new Map<string, Page>();
      const maxPages = this.options.maxPages ?? 8;
      let selected = "";
      let downloadPage: Page | undefined;
      let acceptedDownload: import("playwright").Download | undefined;
      const maxBytes = this.options.maxArtifactBytes ?? 4 * 1024 * 1024;
      const artifacts = new Map<string, { metadata: BrowserArtifact; bytes: Buffer }>();
      let artifactBytes = 0;
      const register = (page: Page) => {
        if ([...pages.values()].includes(page)) return;
        if (pages.size >= maxPages) { void page.close().catch(() => undefined); return; }
        const id = randomUUID(); pages.set(id, page); selected ||= id;
        page.on("close", () => { pages.delete(id); if (selected === id) selected = pages.keys().next().value ?? ""; });
        page.on("download", (download) => {
          if (downloadPage === page && !acceptedDownload) acceptedDownload = download;
          else void download.cancel().then(() => download.delete()).catch(() => undefined);
        });
      };
      context.on("page", register);
      for (const page of context.pages()) register(page);
      if (!pages.size) register(await context.newPage());
      const current = () => { const page = pages.get(selected); if (!page) throw new BrowserUseError("not_found", "Selected page is closed."); return page; };
      const listPages = async (): Promise<BrowserPage[]> => Promise.all([...pages].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title(), selected: id === selected })));
      const execute = async (input: BrowserCommand): Promise<unknown> => {
        const command = validateBrowserCommand(input);
        if (!["pages", "newPage", "selectPage", "closePage", "downloadRead", "downloadDelete"].includes(command.op)) current();
        const page = pages.get(selected)!;
        switch (command.op) {
          case "fill": await page.locator(command.selector).fill(command.value); return null;
          case "select": return page.locator(command.selector).selectOption(command.values);
          case "check": await page.locator(command.selector).setChecked(command.checked); return null;
          case "hover": await page.locator(command.selector).hover(); return null;
          case "scroll": await page.mouse.wheel(command.x, command.y); return null;
          case "waitFor": await page.locator(command.selector).waitFor({ state: command.state ?? "visible" }); return null;
          case "content": { const html = await page.content(); if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw new BrowserUseError("output_limit", "Page content exceeds 4 MiB."); return html; }
          case "back": await page.goBack(); return null;
          case "forward": await page.goForward(); return null;
          case "reload": await page.reload(); return null;
          case "pages": return listPages();
          case "newPage": {
            if (pages.size >= maxPages) throw new BrowserUseError("capacity", "Page capacity reached.");
            const next = await context!.newPage(); register(next);
            selected = [...pages].find(([, value]) => value === next)![0];
            if (command.url) await next.goto(command.url);
            return (await listPages()).find((entry) => entry.id === selected);
          }
          case "selectPage": if (!pages.has(command.pageId)) throw new BrowserUseError("not_found", "Page not found."); selected = command.pageId; return null;
          case "closePage": {
            const target = pages.get(command.pageId);
            if (!target) throw new BrowserUseError("not_found", "Page not found.");
            if (pages.size === 1) throw new BrowserUseError("invalid_input", "Close the session to close its last page.");
            await target.close(); return null;
          }
          case "upload": await page.locator(command.selector).setInputFiles(command.files.map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.base64, "base64") }))); return null;
          case "download": {
            if (artifacts.size >= (this.options.maxArtifacts ?? 16) || artifactBytes >= maxBytes) throw new BrowserUseError("capacity", "Download artifact capacity reached.");
            downloadPage = page; acceptedDownload = undefined;
            const pending = page.waitForEvent("download"); void pending.catch(() => undefined);
            let download: import("playwright").Download | undefined;
            let guard: ReturnType<typeof setInterval> | undefined;
            try {
              await page.locator(command.selector).click(); download = await pending;
              guard = setInterval(() => {
                try {
                  const bytes = readdirSync(downloadsPath).reduce((sum, file) => sum + statSync(join(downloadsPath, file)).size, 0);
                  if (bytes > maxBytes - artifactBytes) void download!.cancel().catch(() => undefined);
                } catch { /* Download files can disappear during cancellation/cleanup. */ }
              }, 50);
              const stream = await download.createReadStream();
              if (!stream) throw new BrowserUseError("unavailable", "Download did not produce a file.");
              const chunks: Buffer[] = []; let bytes = 0;
              for await (const chunk of stream) {
                bytes += chunk.length;
                if (bytes > maxBytes - artifactBytes) { stream.destroy(); throw new BrowserUseError("output_limit", "Download exceeds session artifact budget."); }
                chunks.push(Buffer.from(chunk));
              }
              const id = randomUUID();
              const metadata: BrowserArtifact = { id, name: download.suggestedFilename().replace(/[\\/\x00-\x1f]/g, "_").slice(0, 255) || "download", mimeType: "application/octet-stream", bytes, createdAt: new Date().toISOString() };
              artifacts.set(id, { metadata, bytes: Buffer.concat(chunks) }); artifactBytes += bytes;
              return { ...metadata };
            } finally { downloadPage = undefined; acceptedDownload = undefined; clearInterval(guard); await download?.cancel().catch(() => undefined); await download?.delete().catch(() => undefined); }
          }
          case "downloadRead": { const artifact = artifacts.get(command.artifactId); if (!artifact) throw new BrowserUseError("not_found", "Download artifact not found."); return { ...artifact.metadata, base64: artifact.bytes.toString("base64") }; }
          case "downloadDelete": { const artifact = artifacts.get(command.artifactId); if (!artifact) throw new BrowserUseError("not_found", "Download artifact not found."); artifactBytes -= artifact.bytes.length; artifacts.delete(command.artifactId); return null; }
        }
      };
      let closing: Promise<void> | undefined;
      return managedSession({
        navigate: async (url) => { await current().goto(url); }, evaluate: (expression) => current().evaluate(expression), click: (selector) => current().locator(selector).click(),
        type: (text) => current().keyboard.insertText(text), press: (key) => current().keyboard.press(key), screenshot: () => current().screenshot({ type: "png" }), execute,
        close: () => closing ??= (async () => { try { await closeProcess!(); } finally { release?.(); artifacts.clear(); rmSync(downloadsPath, { recursive: true, force: true }); } })(),
      }, timeoutMs);
    } catch (error) {
      try { await closeProcess?.(); } finally { release?.(); rmSync(downloadsPath, { recursive: true, force: true }); }
      throw error;
    }
  }
}
