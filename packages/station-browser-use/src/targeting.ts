import type { Page, FrameLocator, Locator } from "playwright";
import type { BrowserTarget, BrowserTargetInput, BrowserInspection } from "./commands.js";
import { BrowserUseError } from "./browser.js";
export function locatorFor(page: Page, target: BrowserTarget): Locator {
  let scope: Page | FrameLocator = page;
  for (const selector of target.frame ?? []) scope = scope.frameLocator(selector);
  let locator: Locator;
  switch (target.by) {
    case "selector": locator = scope.locator(target.value); break;
    case "role": locator = scope.getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: target.exact }); break;
    case "text": locator = scope.getByText(target.value, { exact: target.exact }); break;
    case "label": locator = scope.getByLabel(target.value, { exact: target.exact }); break;
    case "testId": locator = scope.getByTestId(target.value); break;
  }
  return target.nth === undefined ? locator : locator.nth(target.nth);
}
export function commandLocator(page: Page, input: BrowserTargetInput): Locator { return locatorFor(page, input.target ?? { by: "selector", value: input.selector! }); }
export function boundedResult<T>(value: T, maxBytes = 1024 * 1024): T { if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new BrowserUseError("output_limit", "Browser inspection exceeds its output limit."); return value; }
export async function inspect(page: Page, target: BrowserTarget | undefined, maxElements = 100, maxTextLength = 256): Promise<BrowserInspection> {
  const result = await locatorFor(page, target ?? { by: "selector", value: "body" }).evaluate((root, limits) => {
    const clip = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, limits.text);
    const elements: BrowserInspection["elements"] = [];
    const walker = root.ownerDocument.createTreeWalker(root, 1);
    let node: Element | null = root; let truncated = false;
    while (node) {
      if (elements.length >= limits.elements) { truncated = true; break; }
      const el = node as HTMLElement & { value?: string; type?: string; checked?: boolean; disabled?: boolean; labels?: NodeListOf<HTMLLabelElement> };
      const rect = el.getBoundingClientRect();
      const entry: BrowserInspection["elements"][number] = { index: elements.length, tag: el.tagName.toLowerCase(), text: clip(el.textContent), box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      for (const [key, value] of [["role", el.getAttribute("role")], ["label", el.getAttribute("aria-label") ?? (el.labels ? Array.from(el.labels).map((label) => label.textContent).join(" ") : null)], ["testId", el.getAttribute("data-testid")], ["type", el.type]] as const) if (value) entry[key] = clip(value);
      if (typeof el.value === "string" && el.type !== "password" && el.type !== "file") entry.value = clip(el.value);
      if (typeof el.checked === "boolean") entry.checked = el.checked;
      if (typeof el.disabled === "boolean") entry.disabled = el.disabled;
      elements.push(entry); node = walker.nextNode() as Element | null;
    }
    return { url: root.ownerDocument.URL.slice(0, 4096), title: root.ownerDocument.title.slice(0, 1024), elements, truncated };
  }, { elements: maxElements, text: maxTextLength });
  return boundedResult({ ...result, coordinateSpace: target?.frame?.length ? "frame-viewport" : "main-viewport" }, 4 * 1024 * 1024);
}
