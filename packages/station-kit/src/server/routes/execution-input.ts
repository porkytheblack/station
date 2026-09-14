import { SandboxError } from "station-sandbox";
import { validateBrowserCommand, validateBrowserOpenOptions } from "station-browser-use";
export type RequestBody = Record<string, unknown> & { method: string };
const invalid = (): never => { throw new SandboxError("invalid_input", "Invalid execution request."); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const only = (value: unknown, keys: string[]) => { const o = object(value); if (Object.keys(o).some(key => !keys.includes(key))) invalid(); return o; };
const string = (value: unknown, max = 65_536, nonempty = false): string => typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= max && (!nonempty || value.trim()) ? value : invalid();
const integer = (value: unknown, min: number, max: number) => { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid(); };
const optionalInteger = (value: unknown, min: number, max: number) => { if (value !== undefined) integer(value, min, max); };
const boolean = (value: unknown) => { if (value !== undefined && typeof value !== "boolean") invalid(); };
function serviceOptions(value: unknown) {
  const o = only(value, ["name", "command", "cwd", "restart"]);
  string(o.name, 128, true); string(o.command, 65_536, true);
  if (o.cwd !== undefined) string(o.cwd, 4096);
  if (o.restart !== undefined) {
    const r = only(o.restart, ["policy", "maxRestarts", "delayMs"]);
    if (!["never", "on-failure", "always"].includes(r.policy as string)) invalid();
    integer(r.maxRestarts, 0, 1000); integer(r.delayMs, 100, 3_600_000);
  }
}
export function validateExecutionRequest(primitive: string, input: unknown): RequestBody {
  const b = object(input) as RequestBody;
  const layouts: Record<string, string[]> = primitive === "sandbox" ? {
    create: [], list: [], get: ["id"], destroy: ["id"], exec: ["id", "command", "cwd", "timeoutMs"], command: ["id", "runId"], cancel: ["id", "runId"],
    listFiles: ["id", "path", "options"], readFile: ["id", "path", "options"], writeFile: ["id", "path", "options"], removeFile: ["id", "path", "options"],
    startService: ["id", "options"], services: ["id"], service: ["id", "serviceId"], stopService: ["id", "serviceId"], restartService: ["id", "serviceId"], removeService: ["id", "serviceId"],
    openTerminal: ["id", "options"], terminals: ["id"], terminal: ["id", "terminalId", "offset"], terminalInput: ["id", "terminalId", "data"], resizeTerminal: ["id", "terminalId", "cols", "rows"], closeTerminal: ["id", "terminalId"],
  } : primitive === "browser" ? {
    open: ["options"], list: [], action: ["id", "action", "value", "controlToken"], close: ["id", "controlToken"], execute: ["id", "command", "controlToken"], profiles: [], profileDelete: ["id"], audit: [],
    control: ["id"], controlAcquire: ["id", "ttlMs"], controlRenew: ["id", "controlToken", "ttlMs"], controlRelease: ["id", "controlToken"], liveFrame: ["id"],
    checkpoints: [], checkpoint: ["id", "controlToken"], checkpointDelete: ["id"], checkpointResume: ["id"],
    recordingStart: ["id"], recordingStop: ["id"], recordings: [], recording: ["id"], recordingFrame: ["id", "frameId"], recordingDelete: ["id"],
  } : {};
  if (typeof b.method !== "string" || !Object.hasOwn(layouts, b.method)) invalid();
  const keys = layouts[b.method];
  only(b, ["method", ...keys]);
  for (const key of ["id", "runId", "frameId", "serviceId", "terminalId"]) {
    if (keys.includes(key) && (typeof b[key] !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b[key] as string))) invalid();
  }
  if (keys.includes("controlToken")) {
    if (b.controlToken !== undefined || ["controlRenew", "controlRelease"].includes(b.method)) {
      if (typeof b.controlToken !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b.controlToken)) invalid();
    }
  }
  if (keys.includes("ttlMs")) optionalInteger(b.ttlMs, 1000, 120000);
  if (keys.includes("path")) {
    if (b.method === "listFiles" && b.path === undefined) {} else string(b.path, 4096, true);
  }
  if (b.method === "exec") {
    string(b.command, 65_536, true); if (b.cwd !== undefined) string(b.cwd, 4096);
    optionalInteger(b.timeoutMs, 1, 2_147_483_647);
  }
  if (b.method === "action") {
    if (!["navigate", "evaluate", "click", "type", "press", "screenshot"].includes(b.action as string)) invalid();
    if (b.action === "screenshot") { if (b.value !== undefined) invalid(); } else string(b.value);
  }
  if (primitive === "browser" && b.method === "open" && b.options !== undefined) validateBrowserOpenOptions(b.options);
  if (b.method === "execute") validateBrowserCommand(b.command);
  if (b.method === "listFiles" || b.method === "readFile") {
    if (b.options !== undefined) {
      const opts = only(b.options, b.method === "listFiles" ? ["offset", "limit"] : ["offset", "length"]);
      optionalInteger(opts.offset, 0, Number.MAX_SAFE_INTEGER);
      optionalInteger(opts.limit, 1, 1000); optionalInteger(opts.length, 1, 4 * 1024 * 1024);
    }
  }
  if (b.method === "writeFile") {
    const opts = only(b.options, ["base64", "createParents"]);
    const encoded = string(opts.base64, 6 * 1024 * 1024);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || Buffer.from(encoded, "base64").length > 4 * 1024 * 1024) invalid();
    boolean(opts.createParents);
  }
  if (b.method === "removeFile" && b.options !== undefined) boolean(only(b.options, ["recursive"]).recursive);
  if (b.method === "startService") serviceOptions(b.options);
  if (b.method === "openTerminal" && b.options !== undefined) {
    const opts = only(b.options, ["cwd", "cols", "rows"]);
    if (opts.cwd !== undefined) string(opts.cwd, 4096);
    optionalInteger(opts.cols, 2, 500); optionalInteger(opts.rows, 1, 500);
  }
  if (b.method === "terminal") optionalInteger(b.offset, 0, Number.MAX_SAFE_INTEGER);
  if (b.method === "terminalInput") string(b.data);
  if (b.method === "resizeTerminal") { integer(b.cols, 2, 500); integer(b.rows, 1, 500); }
  return b;
}
export function isFileTransfer(body: RequestBody): boolean {
  return body.method === "writeFile" || (body.method === "execute" && (body.command as Record<string, unknown>)?.op === "upload");
}
