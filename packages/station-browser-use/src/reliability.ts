import type { Page } from "playwright";
import { BrowserUseError } from "./browser.js";

export interface BrowserReliabilityOptions {
  detectChallenges?: boolean;
  /** Minimum interval between agent actions on one origin; no automatic retries. */
  minIntervalMs?: number;
  maxConcurrentPerOrigin?: number;
  maxBackoffMs?: number;
}
export interface BrowserReliabilityState {
  status: "ready" | "challenge" | "blocked" | "throttled" | "unknown";
  reason?: "challenge-page" | "http-403" | "http-429";
  retryAfterMs?: number;
}
/** Conservative page-level signals, not a CAPTCHA solver or a network firewall. */
export class BrowserTrafficPolicy {
  private readonly enabled: boolean;
  private readonly detect: boolean;
  private readonly interval: number;
  private readonly concurrent: number;
  private readonly backoff: number;
  private readonly sites = new Map<string, { active: number; next: number; blockedUntil: number }>();
  private readonly responses = new WeakMap<Page, number>();
  constructor(options?: BrowserReliabilityOptions) {
    this.enabled = options !== undefined; this.detect = options?.detectChallenges ?? true;
    const bounded = (n: number | undefined, fallback: number, min: number, max: number) => {
      const value = n ?? fallback;
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new BrowserUseError("invalid_input", "Invalid browser traffic limits.");
      return value;
    };
    this.interval = bounded(options?.minIntervalMs, 250, 0, 60000);
    this.concurrent = bounded(options?.maxConcurrentPerOrigin, 2, 1, 64);
    this.backoff = bounded(options?.maxBackoffMs, 60000, 1000, 3600000);
  }
  private site(url: string) {
    let origin: string;
    try { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol)) return; origin = parsed.origin; } catch { return; }
    let state = this.sites.get(origin);
    if (!state) {
      if (this.sites.size >= 1024) for (const [key, value] of this.sites) if (!value.active && Math.max(value.next, value.blockedUntil) <= Date.now()) this.sites.delete(key);
      if (this.sites.size >= 1024) throw new BrowserUseError("capacity", "Browser origin tracking capacity reached.");
      state = { active: 0, next: 0, blockedUntil: 0 }; this.sites.set(origin, state);
    }
    return state;
  }
  watch(page: Page) {
    if (!this.enabled) return;
    page.on("response", response => {
      try {
        if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
        this.responses.set(page, response.status());
        if (response.status() === 429) {
          const site = this.site(response.url()); if (!site) return;
          const header = response.headers()["retry-after"];
          const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : this.backoff;
          site.blockedUntil = Date.now() + Math.min(this.backoff, Math.max(1000, Number.isFinite(delay) ? delay : this.backoff));
        }
      } catch { /* Closed pages cannot contribute new response state. */ }
    });
  }
  async inspect(page: Page | undefined): Promise<BrowserReliabilityState> {
    if (!this.enabled) return { status: "ready" };
    if (!page || page.isClosed()) return { status: "unknown" };
    const site = this.site(page.url());
    if (site && site.blockedUntil > Date.now()) return { status: "throttled", reason: "http-429", retryAfterMs: site.blockedUntil - Date.now() };
    if (this.detect) {
      try {
        const challenge = await page.evaluate(() => {
          const title = document.title.toLowerCase();
          const body = (document.body?.innerText ?? "").slice(0, 12000).toLowerCase();
          const visible = (el: Element) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
          const widget = Array.from(document.querySelectorAll('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], #challenge-running, #challenge-stage')).some(visible);
          const titleMatch = /^(just a moment|attention required|verify (you are|you're) human|security check)/.test(title);
          const interstitial = body.length < 3000 && /verify (you are|you're) (a )?human|unusual traffic from your computer network|checking your browser before accessing/.test(body);
          return widget || titleMatch || interstitial;
        });
        if (challenge) return { status: "challenge", reason: "challenge-page" };
      } catch { return { status: "unknown" }; }
    }
    if (this.responses.get(page) === 403) return { status: "blocked", reason: "http-403" };
    return { status: "ready" };
  }
  private assert(state: BrowserReliabilityState) {
    if (state.status === "throttled") throw new BrowserUseError("rate_limited", "Site throttled this session. Inspect diagnostics and wait before another action.");
    if (state.status === "challenge" || state.status === "blocked") throw new BrowserUseError("challenge_required", "Page requires human review. Pause the agent and use live takeover; do not retry blindly.");
    if (state.status === "unknown") throw new BrowserUseError("unavailable", "Page state could not be inspected.");
  }
  async run<T>(page: Page, action: () => Promise<T>, human: boolean, url?: string, current: () => Page = () => page): Promise<T> {
    if (!this.enabled || human) return action();
    this.assert(await this.inspect(page));
    const site = this.site(url ?? page.url());
    if (site && (site.active >= this.concurrent || Math.max(site.next, site.blockedUntil) > Date.now())) throw new BrowserUseError("rate_limited", "Browser origin action limit reached. Wait before another action.");
    if (site) { site.active++; site.next = Date.now() + this.interval; }
    try { const result = await action(); this.assert(await this.inspect(current())); return result; }
    finally { if (site) site.active--; }
  }
}
