import { managedSession, validateTimeout } from "./session.js";
import type { BrowserAdapter, BrowserSession } from "./browser.js";

/** An independent browser process per session, matching the Bun adapter boundary. */
export class PlaywrightBrowserAdapter implements BrowserAdapter {
  readonly name = "playwright";
  readonly capabilities = { screenshots: true, independentSessions: true } as const;
  constructor(private readonly options: { executablePath?: string; timeoutMs?: number } = {}) {}
  async open(): Promise<BrowserSession> {
    const timeoutMs = validateTimeout(this.options.timeoutMs ?? 30_000);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, executablePath: this.options.executablePath, timeout: timeoutMs });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.setDefaultTimeout(timeoutMs);
      return managedSession({
        navigate: async (url) => { await page.goto(url); },
        evaluate: (expression) => page.evaluate(expression),
        click: (selector) => page.locator(selector).click(),
        type: (text) => page.keyboard.insertText(text),
        press: (key) => page.keyboard.press(key),
        screenshot: () => page.screenshot({ type: "png" }),
        close: () => browser.close(),
      }, timeoutMs);
    } catch (error) { await browser.close(); throw error; }
  }
}
