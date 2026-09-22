import { navigationUrl } from "./navigation.js";
export interface BrowserViewport { width: number; height: number }
export interface BrowserOpenOptions { profileId?: string; viewport?: BrowserViewport; idleTimeoutMs?: number }
export interface BrowserProfile { id: string; inUse: boolean }
export interface BrowserPage { id: string; url: string; title: string; selected: boolean }
export interface BrowserArtifact { id: string; name: string; mimeType: string; bytes: number; createdAt: string }
export interface BrowserUpload { name: string; mimeType: string; base64: string }
export type BrowserTarget = ({ by: "selector" | "text" | "label" | "testId"; value: string; exact?: boolean } | { by: "role"; role: string; name?: string; exact?: boolean }) & { frame?: string[]; nth?: number };
export type BrowserTargetInput = { selector: string; target?: never } | { target: BrowserTarget; selector?: never };
export interface BrowserPoint { x: number; y: number }
export interface BrowserInspectionElement { index: number; tag: string; text: string; role?: string; label?: string; testId?: string; type?: string; value?: string; checked?: boolean; disabled?: boolean; box?: { x: number; y: number; width: number; height: number } }
export interface BrowserInspection { url: string; title: string; coordinateSpace: "main-viewport" | "frame-viewport"; elements: BrowserInspectionElement[]; truncated: boolean }
export interface BrowserDiagnostic { at: string; kind: "console" | "request" | "response" | "requestfailed" | "dialog"; level?: string; message?: string; method?: string; url?: string; status?: number; action?: string }
export interface BrowserTraceState { status: "idle" | "recording" | "stopped" | "limit" | "error"; startedAt?: string; stoppedAt?: string }
export interface BrowserDiagnostics { provider?: { name: string; sessionId: string; connected?: boolean }; reliability?: import("./reliability.js").BrowserReliabilityState; events: BrowserDiagnostic[]; consoleText: boolean; trace: BrowserTraceState }
export type BrowserCommand =
  | ({ op: "fill"; value: string } & BrowserTargetInput)
  | ({ op: "select"; values: string[] } & BrowserTargetInput)
  | ({ op: "check"; checked: boolean } & BrowserTargetInput)
  | ({ op: "hover" | "click" | "focus" } & BrowserTargetInput)
  | ({ op: "press"; key: string } & BrowserTargetInput)
  | { op: "scroll"; x: number; y: number }
  | ({ op: "waitFor"; state?: "attached" | "detached" | "visible" | "hidden" } & BrowserTargetInput)
  | { op: "content" | "back" | "forward" | "reload" | "pages" | "traceStart" | "traceStop" }
  | { op: "newPage"; url?: string }
  | { op: "selectPage" | "closePage"; pageId: string }
  | ({ op: "upload"; files: BrowserUpload[] } & BrowserTargetInput)
  | ({ op: "download" } & BrowserTargetInput)
  | { op: "downloadRead" | "downloadDelete"; artifactId: string }
  | { op: "mouseClick"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: 1 | 2 }
  | { op: "mouseMove"; x: number; y: number }
  | { op: "drag"; source: BrowserTarget; destination: BrowserTarget }
  | { op: "dragCoordinates"; from: BrowserPoint; to: BrowserPoint; steps?: number }
  | { op: "inspect"; target?: BrowserTarget; maxElements?: number; maxTextLength?: number }
  | { op: "accessibility"; target?: BrowserTarget; depth?: number; boxes?: boolean }
  | { op: "dialog"; action: "accept" | "dismiss"; promptText?: string; expiresInMs?: number }
  | { op: "diagnostics"; consoleText?: boolean; clear?: boolean };
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
    fill: ["selector", "target", "value"], select: ["selector", "target", "values"], check: ["selector", "target", "checked"], hover: ["selector", "target"], click: ["selector", "target"], focus: ["selector", "target"], press: ["selector", "target", "key"], scroll: ["x", "y"], waitFor: ["selector", "target", "state"],
    mouseClick: ["x", "y", "button", "clickCount"], mouseMove: ["x", "y"], drag: ["source", "destination"], dragCoordinates: ["from", "to", "steps"], inspect: ["target", "maxElements", "maxTextLength"], accessibility: ["target", "depth", "boxes"], dialog: ["action", "promptText", "expiresInMs"], diagnostics: ["consoleText", "clear"], traceStart: [], traceStop: [],
    content: [], back: [], forward: [], reload: [], pages: [], newPage: ["url"], selectPage: ["pageId"], closePage: ["pageId"], upload: ["selector", "target", "files"], download: ["selector", "target"], downloadRead: ["artifactId"], downloadDelete: ["artifactId"],
  };
  if (typeof value.op !== "string" || !Object.hasOwn(layouts, value.op)) return invalid();
  const keys = layouts[value.op];
  if (Object.keys(value).some((key) => key !== "op" && !keys.includes(key))) return invalid();
  if (keys.includes("selector") && ((value.selector === undefined) === (value.target === undefined))) return invalid();
  if (value.selector !== undefined && (!text(value.selector) || !value.selector)) return invalid();
  if (value.target !== undefined) validateBrowserTarget(value.target);
  if (value.op === "press" && (!text(value.key, 256) || !value.key)) return invalid();
  if (["mouseClick", "mouseMove"].includes(value.op) && !point({ x: value.x, y: value.y })) return invalid();
  if (value.button !== undefined && !["left", "right", "middle"].includes(value.button as string)) return invalid();
  if (value.clickCount !== undefined && ![1, 2].includes(value.clickCount as number)) return invalid();
  if (value.op === "drag") { validateBrowserTarget(value.source); validateBrowserTarget(value.destination); }
  if (value.op === "dragCoordinates" && (!point(value.from) || !point(value.to))) return invalid();
  for (const [key, max] of [["steps", 100], ["maxElements", 500], ["maxTextLength", 4096], ["depth", 20], ["expiresInMs", 30000]] as const) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > max)) return invalid();
  for (const key of ["boxes", "consoleText", "clear"]) if (value[key] !== undefined && typeof value[key] !== "boolean") return invalid();
  if (value.op === "dialog" && (!["accept", "dismiss"].includes(value.action as string) || (value.promptText !== undefined && (!text(value.promptText, 4096) || value.action !== "accept")))) return invalid();
  if (value.op === "fill" && !text(value.value)) return invalid();
  if (value.op === "select" && (!Array.isArray(value.values) || value.values.length > 100 || value.values.some((item) => !text(item)))) return invalid();
  if (value.op === "check" && typeof value.checked !== "boolean") return invalid();
  if (value.op === "scroll" && [value.x, value.y].some((n) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 10_000_000)) return invalid();
  if (value.op === "waitFor" && value.state !== undefined && !["attached", "detached", "visible", "hidden"].includes(value.state as string)) return invalid();
  if (value.op === "newPage" && value.url !== undefined) { if (!text(value.url)) return invalid(); navigationUrl(value.url); }
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

const roles = new Set("alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem".split(" "));
function point(input: unknown): input is BrowserPoint { if (!input || typeof input !== "object" || Array.isArray(input)) return false; const p = input as Record<string, unknown>; return Object.keys(p).every((key) => ["x", "y"].includes(key)) && [p.x, p.y].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100000); }
export function validateBrowserTarget(input: unknown): BrowserTarget {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>; const role = value.by === "role";
  if (!["selector", "text", "label", "testId", "role"].includes(value.by as string) || Object.keys(value).some((key) => !["by", "exact", "frame", "nth", ...(role ? ["role", "name"] : ["value"])].includes(key))) return invalid();
  if (role ? !roles.has(value.role as string) || (value.name !== undefined && !text(value.name, 4096)) : !text(value.value, 4096) || !value.value) return invalid();
  if (value.exact !== undefined && typeof value.exact !== "boolean") return invalid();
  if (value.nth !== undefined && (!Number.isSafeInteger(value.nth) || (value.nth as number) < 0 || (value.nth as number) > 999)) return invalid();
  if (value.frame !== undefined && (!Array.isArray(value.frame) || value.frame.length > 8 || value.frame.some((item) => !text(item, 4096) || !item))) return invalid();
  return JSON.parse(JSON.stringify(value));
}
