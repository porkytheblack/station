import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import { SandboxError, type FileWrite, type ServiceInput, type TerminalInput } from "station-sandbox";
import { BrowserUseError, type BrowserAction, type BrowserCommand, type BrowserOpenOptions } from "station-browser-use";
import type { StationNetworkAdapter, StationRole, StationNode } from "station-network";
import type { ExecutionConfig } from "../../config/schema.js";
import { requireScope } from "../middleware/scope-guard.js";
import { validateExecutionRequest, isFileTransfer, type RequestBody } from "./execution-input.js";

export interface ExecutionDeps {
  execution: ExecutionConfig;
  adapter: StationNetworkAdapter;
  networkId: string;
  stationId: string;
  role: StationRole;
}

/** Dashboard discovery uses advertised capabilities, never guesses from labels. */
export function executionCatalogRoutes(deps: Omit<ExecutionDeps, "execution"> & { enabled: boolean }): Hono {
  const app = new Hono();
  app.get("/execution", requireScope("admin"), async (c) => {
    if (!deps.enabled) return c.json({ data: [] });
    const stations = await deps.adapter.listStations({ networkId: deps.networkId });
    const now = Date.now();
    return c.json({ data: stations
      .filter((node) => (deps.role === "headquarters" ? node.role === "station" || node.id === deps.stationId : node.id === deps.stationId))
      .filter((node) => node.definitions.execution?.sandbox || node.definitions.execution?.browser)
      .map((node) => {
        let reachable = node.id === deps.stationId;
        if (!reachable && node.endpoint) {
          try {
            const url = new URL(node.endpoint);
            reachable = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
          } catch { /* An invalid registered endpoint is unavailable. */ }
        }
        return {
          stationId: node.id, name: node.name, role: node.role, status: node.status,
          capabilities: { sandbox: Boolean(node.definitions.execution?.sandbox), browser: Boolean(node.definitions.execution?.browser) },
          backends: { sandbox: node.definitions.execution?.sandbox?.backend, browser: node.definitions.execution?.browser?.backend },
          features: { sandbox: node.definitions.execution?.sandbox?.capabilities, browser: node.definitions.execution?.browser?.capabilities },
          available: reachable && node.status !== "offline" && node.leaseExpiresAt.getTime() > now,
        };
      }) });
  });
  return app;
}
const messages = {
  invalid_input: "Invalid execution request.", not_found: "Execution resource not found.",
  busy: "Execution resource is busy.", capacity: "Execution capacity reached.",
  unavailable: "Execution worker unavailable.", unsupported: "Execution capability unavailable.",
  invalid_state: "Execution state unavailable.",
  challenge_required: "Page requires human review. Pause the agent and use live takeover.",
  rate_limited: "Browser or provider rate limit reached. Inspect diagnostics and wait before retrying.",
  provider_auth: "Browser provider credentials or permissions were rejected.",
  provider_disconnected: "Remote browser disconnected. Check provider expiry and reconcile before creating a replacement.",
  provider_capacity: "Browser provider session capacity reached.",
  provider_unavailable: "Browser provider unavailable; reconcile session state before retrying.",
} as const;
const statuses = { provider_disconnected: 503, challenge_required: 409, rate_limited: 429, provider_auth: 503, provider_capacity: 429, provider_unavailable: 503, invalid_input: 400, not_found: 404, busy: 409, capacity: 429, unavailable: 503, unsupported: 503, invalid_state: 503 } as const;
const invalid = (): never => { throw new SandboxError("invalid_input", messages.invalid_input); };
export function assertAvailable(node: StationNode | null, networkId: string, primitive: string, body: RequestBody) {
  if (!node || node.networkId !== networkId) throw new SandboxError("unavailable", messages.unavailable);
  if (node.status === "offline" || node.leaseExpiresAt.getTime() <= Date.now()) throw new SandboxError("unavailable", messages.unavailable);
  const cleanup = primitive === "sandbox"
    ? ["list", "get", "command", "cancel", "destroy", "listFiles", "readFile", "services", "service", "stopService", "removeService", "terminals", "terminal", "closeTerminal"].includes(body.method)
    : ["list", "close", "recordings", "recording", "recordingFrame", "recordingStop", "recordingDelete", "profiles", "profileDelete", "audit", "control", "controlRelease", "liveFrame", "checkpoints", "checkpointDelete"].includes(body.method) || (body.method === "execute" && ["pages", "downloadRead", "downloadDelete", "closePage"].includes((body.command as BrowserCommand).op));
  if (node.status !== "online" && !(node.status === "draining" && cleanup)) throw new SandboxError("unavailable", messages.unavailable);
}
export async function dispatch(config: ExecutionConfig, primitive: string, b: RequestBody): Promise<unknown> {
  if (primitive === "sandbox" && config.sandbox) {
    const a = config.sandbox;
    switch (b.method) {
      case "create": return a.create();
      case "list": return a.list();
      case "get": return a.get(b.id as string);
      case "destroy": await a.destroy(b.id as string); return null;
      case "exec": return a.exec(b.id as string, { command: b.command as string, cwd: b.cwd as string | undefined, timeoutMs: b.timeoutMs as number | undefined });
      case "command": return a.command(b.id as string, b.runId as string);
      case "cancel": return a.cancel(b.id as string, b.runId as string);
      case "listFiles": if (a.listFiles) return a.listFiles(b.id as string, b.path as string | undefined, b.options as { offset?: number; limit?: number } | undefined); break;
      case "readFile": if (a.readFile) return a.readFile(b.id as string, b.path as string, b.options as { offset?: number; length?: number } | undefined); break;
      case "writeFile": if (a.writeFile) return a.writeFile(b.id as string, b.path as string, b.options as FileWrite); break;
      case "removeFile": if (a.removeFile) { await a.removeFile(b.id as string, b.path as string, b.options as { recursive?: boolean } | undefined); return null; } break;
      case "startService": if (a.startService) return a.startService(b.id as string, b.options as ServiceInput); break;
      case "services": if (a.services) return a.services(b.id as string); break;
      case "service": if (a.service) return a.service(b.id as string, b.serviceId as string); break;
      case "stopService": if (a.stopService) return a.stopService(b.id as string, b.serviceId as string); break;
      case "restartService": if (a.restartService) return a.restartService(b.id as string, b.serviceId as string); break;
      case "removeService": if (a.removeService) { await a.removeService(b.id as string, b.serviceId as string); return null; } break;
      case "openTerminal": if (a.openTerminal) return a.openTerminal(b.id as string, b.options as TerminalInput | undefined); break;
      case "terminals": if (a.terminals) return a.terminals(b.id as string); break;
      case "terminal": if (a.terminal) return a.terminal(b.id as string, b.terminalId as string, b.offset as number | undefined); break;
      case "terminalInput": if (a.terminalInput) { await a.terminalInput(b.id as string, b.terminalId as string, b.data as string); return null; } break;
      case "resizeTerminal": if (a.resizeTerminal) { await a.resizeTerminal(b.id as string, b.terminalId as string, b.cols as number, b.rows as number); return null; } break;
      case "closeTerminal": if (a.closeTerminal) { await a.closeTerminal(b.id as string, b.terminalId as string); return null; } break;
    }
  }
  if (primitive === "browser" && config.browser) {
    const a = config.browser;
    switch (b.method) {
      case "open": return a.open(b.options as BrowserOpenOptions | undefined);
      case "list": return a.list();
      case "execute": return a.execute(b.id as string, b.command as BrowserCommand, b.controlToken as string | undefined);
      case "profiles": return a.listProfiles();
      case "profileDelete": await a.deleteProfile(b.id as string); return null;
      case "audit": return a.audit();
      case "control": return a.control(b.id as string);
      case "controlAcquire": return a.acquireControl(b.id as string, b.ttlMs as number | undefined);
      case "controlRenew": return a.renewControl(b.id as string, b.controlToken as string, b.ttlMs as number | undefined);
      case "controlRelease": a.releaseControl(b.id as string, b.controlToken as string); return null;
      case "liveFrame": return a.liveFrame(b.id as string);
      case "checkpoints": return a.listCheckpoints();
      case "checkpoint": return a.checkpoint(b.id as string, b.controlToken as string | undefined);
      case "checkpointDelete": a.deleteCheckpoint(b.id as string); return null;
      case "checkpointResume": return a.resumeCheckpoint(b.id as string);
      case "action": return a.perform(b.id as string, b.action as BrowserAction, b.value as string | undefined, b.controlToken as string | undefined);
      case "close": await a.requestCloseSession(b.id as string, b.controlToken as string | undefined); return null;
      case "recordingStart": return a.startRecording(b.id as string);
      case "recordingStop": return a.stopRecording(b.id as string);
      case "recordings": return a.listRecordings();
      case "recording": return a.getRecording(b.id as string);
      case "recordingFrame": return a.recordingFrame(b.id as string, b.frameId as string);
      case "recordingDelete": await a.deleteRecording(b.id as string); return null;
    }
  }
  throw new SandboxError("unsupported", messages.unsupported);
}
export function failure(c: Context, error: unknown) {
  if (error instanceof HTTPException && error.status === 413) return c.json({ error: "payload_too_large" }, 413);
  if ((error instanceof SandboxError || error instanceof BrowserUseError) && Object.hasOwn(statuses, error.code)) {
    const code = error.code as keyof typeof statuses;
    return c.json({ error: code, message: messages[code] }, statuses[code]);
  }
  // Adapter/transport exceptions may contain filesystem paths, URLs or credentials.
  return c.json({ error: "unavailable", message: messages.unavailable }, 503);
}
export async function readBody(c: Context) {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return invalid();
  try {
    const raw = await c.req.text();
    const input = JSON.parse(raw);
    const transfer = input && typeof input === "object" && isFileTransfer(input);
    if (!transfer && Buffer.byteLength(raw) > 128 * 1024) throw new HTTPException(413);
    return validateExecutionRequest(c.req.param("primitive") ?? "", input);
  }
  catch (e) {
    if (e instanceof Error && e.name === "BodyLimitError") throw new HTTPException(413);
    if (e instanceof SandboxError || e instanceof HTTPException) throw e;
    return invalid();
  }
}
export const limit = () => bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) });

/** Mounted outside browser/session authentication; only the worker secret is accepted. */
export function internalExecutionRoutes(deps: ExecutionDeps): Hono {
  if (typeof deps.execution.token !== "string" || deps.execution.token.length < 32) throw new Error("execution.token must contain at least 32 characters.");
  const app = new Hono();
  const bearer = createHash("sha256").update(`Bearer ${deps.execution.token}`).digest();
  app.post("/execution/:primitive", async (c, next) => {
    const actual = createHash("sha256").update(c.req.header("authorization") ?? "").digest();
    if (!timingSafeEqual(actual, bearer)) return c.json({ error: "unauthorized" }, 401);
    return next();
  }, limit(), async (c) => {
    try {
      const tenantId = c.req.header("x-station-execution-tenant");
      if (tenantId !== undefined && (!deps.execution.tenantId || tenantId !== deps.execution.tenantId)) return c.json({ error: "not_found" }, 404);
      const body = await readBody(c);
      assertAvailable(await deps.adapter.getStation(deps.stationId), deps.networkId, c.req.param("primitive"), body);
      return c.json({ data: await dispatch(deps.execution, c.req.param("primitive"), body) });
    }
    catch (error) { return failure(c, error); }
  });
  return app;
}

/** Owner station is explicit: no automatic migration or retry of stateful mutations. */
export function publicExecutionRoutes(deps: ExecutionDeps): Hono {
  const app = new Hono();
  app.post("/stations/:stationId/execution/:primitive", requireScope("admin"), limit(), async (c) => {
    try {
      const body = await readBody(c);
      const owner = c.req.param("stationId");
      if (owner === deps.stationId) {
        assertAvailable(await deps.adapter.getStation(owner), deps.networkId, c.req.param("primitive"), body);
        return c.json({ data: await dispatch(deps.execution, c.req.param("primitive"), body) });
      }
      if (deps.role !== "headquarters") return c.json({ error: "not_found" }, 404);
      const node = await deps.adapter.getStation(owner);
      if (!node || node.networkId !== deps.networkId || node.role !== "station") return c.json({ error: "not_found" }, 404);
      assertAvailable(node, deps.networkId, c.req.param("primitive"), body);
      return await forwardExecution(c, deps, node, body);
    } catch (error) { return failure(c, error); }
  });
  return app;
}

/** Shared bounded transport; tenant identity is supplied only by authenticated Headquarters routing. */
export async function forwardExecution(c: Context, deps: ExecutionDeps, node: StationNode, body: RequestBody, tenantId?: string) {
  if (!node.endpoint) return c.json({ error: "unavailable" }, 503);
  const endpoint = new URL(node.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return c.json({ error: "unavailable" }, 503);
  endpoint.pathname = `/internal/execution/${c.req.param("primitive")}`;
  const unknownFailure = () => c.json({ error: "execution_failed", message: "Worker outcome is unknown. Inspect resource state before repeating a mutation.", outcome: "unknown" }, 503);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.execution.token}`, ...(tenantId ? { "x-station-execution-tenant": tenantId } : {}) },
      body: JSON.stringify(body),
    });
    // Error envelopes are small and never forwarded verbatim. Successful frame
    // payloads retain the larger browser transport allowance.
    const maxBytes = response.ok ? 33 * 1024 * 1024 : 16 * 1024;
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) return unknownFailure();
    const reader = response.body?.getReader();
    if (!reader) return unknownFailure();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) return unknownFailure();
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok) {
      const remoteStatuses = { ...statuses, payload_too_large: 413 } as const;
      const remoteMessages = { ...messages, payload_too_large: "Execution request exceeds the input limit." } as const;
      if (result && typeof result === "object" && result.outcome === undefined && typeof result.error === "string" && Object.hasOwn(remoteStatuses, result.error)) {
        const code = result.error as keyof typeof remoteStatuses;
        if (response.status === remoteStatuses[code]) return c.json({ error: code, message: remoteMessages[code], ...(response.status >= 500 ? { outcome: "unknown" } : {}) }, remoteStatuses[code]);
      }
      return unknownFailure();
    }
    if (!result || typeof result !== "object" || Array.isArray(result) || !Object.hasOwn(result, "data") || Object.hasOwn(result, "error")) return unknownFailure();
    return c.json({ data: result.data });
  } catch { return unknownFailure(); }
  finally { clearTimeout(timeout); controller.abort(); }
}
