import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { createHash, timingSafeEqual } from "node:crypto";
import { SandboxError } from "station-sandbox";
import { BrowserUseError, type BrowserAction } from "station-browser-use";
import type { StationNetworkAdapter, StationRole, StationNode } from "station-network";
import type { ExecutionConfig } from "../../config/schema.js";
import { requireScope } from "../middleware/scope-guard.js";

export interface ExecutionDeps {
  execution: ExecutionConfig;
  adapter: StationNetworkAdapter;
  networkId: string;
  stationId: string;
  role: StationRole;
}
type RequestBody = Record<string, unknown> & { method: string };
const actions = new Set(["navigate", "evaluate", "click", "type", "press", "screenshot"]);
const messages = {
  invalid_input: "Invalid execution request.", not_found: "Execution resource not found.",
  busy: "Execution resource is busy.", capacity: "Execution capacity reached.",
  unavailable: "Execution worker unavailable.", unsupported: "Execution capability unavailable.",
  invalid_state: "Execution state unavailable.",
} as const;
const statuses = { invalid_input: 400, not_found: 404, busy: 409, capacity: 429, unavailable: 503, unsupported: 503, invalid_state: 503 } as const;
const invalid = (): never => { throw new SandboxError("invalid_input", messages.invalid_input); };
function validate(primitive: string, input: unknown): RequestBody {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid();
  const b = input as RequestBody;
  const layouts: Record<string, string[]> = primitive === "sandbox"
    ? { create: [], list: [], get: ["id"], destroy: ["id"], exec: ["id", "command", "cwd", "timeoutMs"], command: ["id", "runId"], cancel: ["id", "runId"] }
    : primitive === "browser" ? { open: [], list: [], action: ["id", "action", "value"], close: ["id"] } : {};
  if (typeof b.method !== "string" || !Object.hasOwn(layouts, b.method)) return invalid();
  const keys = layouts[b.method];
  if (Object.keys(b).some((key) => key !== "method" && !keys.includes(key))) return invalid();
  for (const key of ["id", "runId"]) {
    if (keys.includes(key) && (typeof b[key] !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(b[key] as string))) return invalid();
  }
  if (b.method === "exec") {
    if (typeof b.command !== "string" || !b.command.trim() || b.command.length > 65_536) return invalid();
    if (b.cwd !== undefined && (typeof b.cwd !== "string" || b.cwd.length > 4096)) return invalid();
    if (b.timeoutMs !== undefined && (!Number.isSafeInteger(b.timeoutMs) || (b.timeoutMs as number) < 1 || (b.timeoutMs as number) > 2_147_483_647)) return invalid();
  }
  if (b.method === "action") {
    if (typeof b.action !== "string" || !actions.has(b.action)) return invalid();
    if (b.action !== "screenshot" && (typeof b.value !== "string" || b.value.length > 65_536)) return invalid();
    if (b.action === "screenshot" && b.value !== undefined) return invalid();
  }
  return b;
}
function assertAvailable(node: StationNode | null, networkId: string, primitive: string, body: RequestBody) {
  if (!node || node.networkId !== networkId) throw new SandboxError("unavailable", messages.unavailable);
  if (node.status === "offline" || node.leaseExpiresAt.getTime() <= Date.now()) throw new SandboxError("unavailable", messages.unavailable);
  const cleanup = primitive === "sandbox"
    ? ["list", "get", "command", "cancel", "destroy"].includes(body.method)
    : ["list", "close"].includes(body.method);
  if (node.status !== "online" && !(node.status === "draining" && cleanup)) throw new SandboxError("unavailable", messages.unavailable);
}
async function dispatch(config: ExecutionConfig, primitive: string, b: RequestBody): Promise<unknown> {
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
    }
  }
  if (primitive === "browser" && config.browser) {
    const a = config.browser;
    switch (b.method) {
      case "open": return a.open();
      case "list": return a.list();
      case "action": return a.perform(b.id as string, b.action as BrowserAction, b.value as string | undefined);
      case "close": await a.closeSession(b.id as string); return null;
    }
  }
  throw new SandboxError("unsupported", messages.unsupported);
}
function failure(c: Context, error: unknown) {
  if (error instanceof HTTPException && error.status === 413) return c.json({ error: "payload_too_large" }, 413);
  if ((error instanceof SandboxError || error instanceof BrowserUseError) && Object.hasOwn(statuses, error.code)) {
    const code = error.code as keyof typeof statuses;
    return c.json({ error: code, message: messages[code] }, statuses[code]);
  }
  // Adapter/transport exceptions may contain filesystem paths, URLs or credentials.
  return c.json({ error: "unavailable", message: messages.unavailable }, 503);
}
async function readBody(c: Context) {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return invalid();
  try { return validate(c.req.param("primitive") ?? "", await c.req.json()); }
  catch (e) {
    if (e instanceof Error && e.name === "BodyLimitError") throw new HTTPException(413);
    if (e instanceof SandboxError || e instanceof HTTPException) throw e;
    return invalid();
  }
}
const limit = () => bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: "payload_too_large" }, 413) });

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
      if (!node.endpoint) return c.json({ error: "unavailable" }, 503);
      const endpoint = new URL(node.endpoint);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return c.json({ error: "unavailable" }, 503);
      endpoint.pathname = `/internal/execution/${c.req.param("primitive")}`;
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${deps.execution.token}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Never forward arbitrary upstream error text or authentication headers.
        const status = [400, 404, 409, 413, 429].includes(response.status) ? response.status as 400 | 404 | 409 | 413 | 429 : 503;
        return c.json({ error: "execution_failed", message: "Worker could not complete the operation." }, status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 33 * 1024 * 1024) throw new Error("Response limit exceeded");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!result || !Object.hasOwn(result, "data")) throw new Error("Invalid response");
      return c.json({ data: result.data });
    } catch (error) { return failure(c, error); }
  });
  return app;
}
