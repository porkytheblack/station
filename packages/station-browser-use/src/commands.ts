export interface BrowserViewport { width: number; height: number }
export interface BrowserOpenOptions { profileId?: string; viewport?: BrowserViewport; idleTimeoutMs?: number }
export interface BrowserProfile { id: string; inUse: boolean }
export interface BrowserPage { id: string; url: string; title: string; selected: boolean }
export interface BrowserArtifact { id: string; name: string; mimeType: string; bytes: number; createdAt: string }
export interface BrowserUpload { name: string; mimeType: string; base64: string }
export type BrowserCommand =
  | { op: "fill"; selector: string; value: string }
  | { op: "select"; selector: string; values: string[] }
  | { op: "check"; selector: string; checked: boolean }
  | { op: "hover"; selector: string }
  | { op: "scroll"; x: number; y: number }
  | { op: "waitFor"; selector: string; state?: "attached" | "detached" | "visible" | "hidden" }
  | { op: "content" | "back" | "forward" | "reload" | "pages" }
  | { op: "newPage"; url?: string }
  | { op: "selectPage" | "closePage"; pageId: string }
  | { op: "upload"; selector: string; files: BrowserUpload[] }
  | { op: "download"; selector: string }
  | { op: "downloadRead" | "downloadDelete"; artifactId: string };
export interface BrowserAuditEntry { at: string; event: "opened" | "closed" | "action" | "idle-expired"; sessionId: string; backend: string; operation?: string; outcome?: "ok" | "error" }

import { BrowserUseError } from "./browser.js";
const invalid = (): never => { throw new BrowserUseError("invalid_input", "Invalid browser command or options."); };
const text = (value: unknown, max = 65536): value is string => typeof value === "string" && Buffer.byteLength(value) <= max;
const identifier = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function validateBrowserOpenOptions(input: unknown = {}): BrowserOpenOptions {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["profileId", "viewport", "idleTimeoutMs"].includes(key))) return invalid();
  if (value.profileId !== undefined && !identifier(value.profileId)) return invalid();
  if (value.idleTimeoutMs !== undefined && (!Number.isSafeInteger(value.idleTimeoutMs) || (value.idleTimeoutMs as number) < 100 || (value.idleTimeoutMs as number) > 86_400_000)) return invalid();
  if (value.viewport !== undefined) {
    if (!value.viewport || typeof value.viewport !== "object" || Array.isArray(value.viewport)) return invalid();
    const viewport = value.viewport as Record<string, unknown>;
    if (Object.keys(viewport).some((key) => !["width", "height"].includes(key)) || [viewport.width, viewport.height].some((n) => !Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 4096)) return invalid();
  }
  return { ...value, ...(value.viewport ? { viewport: { ...value.viewport as BrowserViewport } } : {}) } as BrowserOpenOptions;
}
export function validateBrowserCommand(input: unknown): BrowserCommand {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  const layouts: Record<string, string[]> = {
    fill: ["selector", "value"], select: ["selector", "values"], check: ["selector", "checked"], hover: ["selector"], scroll: ["x", "y"], waitFor: ["selector", "state"],
    content: [], back: [], forward: [], reload: [], pages: [], newPage: ["url"], selectPage: ["pageId"], closePage: ["pageId"], upload: ["selector", "files"], download: ["selector"], downloadRead: ["artifactId"], downloadDelete: ["artifactId"],
  };
  if (typeof value.op !== "string" || !Object.hasOwn(layouts, value.op)) return invalid();
  const keys = layouts[value.op];
  if (Object.keys(value).some((key) => key !== "op" && !keys.includes(key))) return invalid();
  if (keys.includes("selector") && (!text(value.selector) || !value.selector)) return invalid();
  if (value.op === "fill" && !text(value.value)) return invalid();
  if (value.op === "select" && (!Array.isArray(value.values) || value.values.length > 100 || value.values.some((item) => !text(item)))) return invalid();
  if (value.op === "check" && typeof value.checked !== "boolean") return invalid();
  if (value.op === "scroll" && [value.x, value.y].some((n) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 10_000_000)) return invalid();
  if (value.op === "waitFor" && value.state !== undefined && !["attached", "detached", "visible", "hidden"].includes(value.state as string)) return invalid();
  if (value.op === "newPage" && value.url !== undefined && !text(value.url)) return invalid();
  if (keys.includes("pageId") && !identifier(value.pageId)) return invalid();
  if (keys.includes("artifactId") && !identifier(value.artifactId)) return invalid();
  if (value.op === "upload") {
    if (!Array.isArray(value.files) || value.files.length > 16) return invalid();
    let bytes = 0;
    for (const file of value.files) {
      if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some((key) => !["name", "mimeType", "base64"].includes(key))) return invalid();
      if (!text(file.name, 255) || !file.name || /[\\/\0]/.test(file.name) || file.name === "." || file.name === ".." || !text(file.mimeType, 255)) return invalid();
      if (typeof file.base64 !== "string" || file.base64.length > 6 * 1024 * 1024 || (file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64) || Buffer.from(file.base64, "base64").toString("base64") !== file.base64)) return invalid();
      bytes += Buffer.byteLength(file.base64, "base64");
      if (bytes > 4 * 1024 * 1024) throw new BrowserUseError("output_limit", "Uploads exceed the 4 MiB input limit.");
    }
  }
  return JSON.parse(JSON.stringify(value)) as BrowserCommand;
}
