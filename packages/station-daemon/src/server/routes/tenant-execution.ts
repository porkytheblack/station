import { Hono, type Context } from "hono";
import type { ExecutionConfig, StationConfig } from "../../config/schema.js";
import type { StationNode } from "station-network";
import { assertAvailable, failure, forwardExecution, limit, readBody, type ExecutionDeps } from "./execution.js";

const tenantPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const safeBackend = (capabilities: unknown): boolean => {
  const c = capabilities as Record<string, unknown> | undefined;
  return c?.isolated === true && c.networkRestricted === true;
};

/** Configuration is operator-owned. No request may choose or override its tenant identity. */
export function validateExecutionTenancy(config: Pick<StationConfig, "execution" | "role" | "auth">): void {
  const e = config.execution;
  if (!e) return;
  if (e.targets !== undefined) {
    if (config.role !== "headquarters" || !e.targets || typeof e.targets !== "object" || Array.isArray(e.targets) || Object.keys(e.targets).length > 10000) throw new Error("execution.targets requires an operator-owned Headquarters worker map.");
    const tokens = new Set([e.token]);
    for (const [worker, target] of Object.entries(e.targets)) {
      if (!tenantPattern.test(worker) || !target || typeof target.token !== "string" || target.token.length < 32 || tokens.has(target.token)) throw new Error("Execution targets require distinct worker credentials (not the Headquarters token).");
      tokens.add(target.token);
      let url: URL; try { url = new URL(target.endpoint); } catch { throw new Error("Invalid execution target endpoint."); }
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Execution target endpoints require HTTPS (loopback HTTP allowed) and no path or credentials.");
      if (target.tenantId !== undefined && !tenantPattern.test(target.tenantId)) throw new Error("Invalid execution target tenant.");
    }
  }
  if (e.tenantId !== undefined) {
    if (typeof e.tenantId !== "string" || !tenantPattern.test(e.tenantId) || config.role !== "station" || e.tenants) throw new Error("execution.tenantId requires a dedicated station worker and a valid tenant ID.");
    if (!config.auth) throw new Error("Tenant workers require independent authenticated operator APIs.");
    if (!e.sandbox && !e.browser) throw new Error("Tenant workers require an execution backend.");
    if (e.sandbox && (!safeBackend(e.sandbox.capabilities) || typeof e.sandbox.bindTenant !== "function")) throw new Error("Tenant sandbox workers require isolated and networkRestricted capabilities plus persistent tenant binding.");
    if (e.browser && (e.browser.statePersistence !== "disk" || e.browser.recordingPersistence !== "disk")) throw new Error("Tenant browser workers require durable stateRootDir and recordingRootDir storage.");
    if (e.browser && (!safeBackend(e.browser.adapter.capabilities) || typeof e.browser.adapter.bindTenant !== "function")) throw new Error("Tenant browser workers require isolated and networkRestricted capabilities plus persistent tenant binding.");
  }
  if (e.tenants !== undefined) {
    if (config.role !== "headquarters" || !config.auth || e.sandbox || e.browser) throw new Error("execution.tenants requires authenticated Headquarters with execution on dedicated workers.");
    if (!e.targets) throw new Error("Tenant execution requires operator-pinned targets with distinct worker credentials.");
    const mappings = e.tenants?.apiKeyTenants;
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings) || Object.keys(e.tenants).some((key) => !["apiKeyTenants", "limits"].includes(key))) throw new Error("Invalid execution tenant key mapping.");
    if (Object.keys(mappings).length > 10_000) throw new Error("Execution tenant mapping exceeds 10000 keys.");
    const limits = e.tenants.limits;
    if (limits !== undefined && (!limits || typeof limits !== "object" || Array.isArray(limits) || Object.entries(limits).some(([key, value]) => !["requestsPerSecond", "burst", "maxInFlightPerTenant", "maxInFlight"].includes(key) || !Number.isSafeInteger(value) || value < 1 || value > 100_000))) throw new Error("Invalid execution tenant request limits.");
    for (const [key, tenant] of Object.entries(mappings)) {
      if (!key || key.length > 128 || typeof tenant !== "string" || !tenantPattern.test(tenant)) throw new Error("Invalid execution tenant key mapping.");
    }
  }
}

function tenantFor(c: Context, mappings: ReadonlyMap<string, string>): string | undefined {
  if (c.get("authType") !== "api-key") return undefined;
  const scopes = c.get("scopes") as unknown;
  // Customer keys cannot simultaneously grant access to fleet-wide/operator APIs.
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== "execution") return undefined;
  const key = c.get("apiKeyId");
  return typeof key === "string" ? mappings.get(key) : undefined;
}
function eligible(node: StationNode, deps: ExecutionDeps, tenantId: string): boolean {
  const execution = node.definitions.execution;
  const target = Object.hasOwn(deps.execution.targets ?? {}, node.id) ? deps.execution.targets![node.id] : undefined;
  return target?.tenantId === tenantId && node.networkId === deps.networkId && node.role === "station" && execution?.tenantId === tenantId
    && Boolean(execution.sandbox || execution.browser)
    && (!execution.sandbox || safeBackend(execution.sandbox.capabilities))
    && (!execution.browser || safeBackend(execution.browser.capabilities));
}
function reachable(node: StationNode, deps: ExecutionDeps): boolean {
  const endpoint = deps.execution.targets?.[node.id]?.endpoint;
  if (!endpoint) return false;
  try { const u = new URL(endpoint); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}

/** Customer API: only mapped execution-only API keys, only their dedicated private workers. */
export function tenantExecutionRoutes(deps: ExecutionDeps): Hono {
  const app = new Hono();
  if (deps.role !== "headquarters" || !deps.execution.tenants) return app;
  const mappings = new Map(Object.entries(deps.execution.tenants.apiKeyTenants));
  const rate = deps.execution.tenants.limits?.requestsPerSecond ?? 30;
  const burst = deps.execution.tenants.limits?.burst ?? 60;
  const perTenant = deps.execution.tenants.limits?.maxInFlightPerTenant ?? 8;
  const globalLimit = deps.execution.tenants.limits?.maxInFlight ?? 128;
  // Only configured identities allocate buckets; multiple keys share the same tenant budget.
  const buckets = new Map([...new Set(mappings.values())].map((id) => [id, { tokens: burst, updated: performance.now(), active: 0 }]));
  let active = 0;
  const identity = (c: Context) => tenantFor(c, mappings);
  const denied = (c: Context) => c.json({ error: c.get("authType") === "none" || !c.get("authType") ? "unauthorized" : "forbidden" }, c.get("authType") === "none" || !c.get("authType") ? 401 : 403);
  app.use("/tenant/*", async (c, next) => {
    if (/^(?:\/api\/v1)?\/tenant\/registry(?:\/|$)/.test(c.req.path)) return next();
    const tenantId = identity(c);
    if (!tenantId) return denied(c);
    const bucket = buckets.get(tenantId)!;
    const now = performance.now();
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.updated) * rate / 1000);
    bucket.updated = now;
    if (bucket.tokens < 1 || bucket.active >= perTenant || active >= globalLimit) {
      c.header("Retry-After", "1");
      return c.json({ error: "capacity", message: "Tenant request capacity reached." }, 429);
    }
    bucket.tokens -= 1; bucket.active++; active++;
    try { await next(); } finally { bucket.active--; active--; }
  });
  app.get("/tenant/execution", async (c) => {
    const tenantId = identity(c);
    if (!tenantId) return denied(c);
    try {
      const nodes = await deps.adapter.listStations({ networkId: deps.networkId });
      return c.json({ data: nodes.filter((node) => eligible(node, deps, tenantId)).map((node) => ({
        stationId: node.id, status: node.status,
        capabilities: { sandbox: Boolean(node.definitions.execution?.sandbox), browser: Boolean(node.definitions.execution?.browser) },
        backends: { sandbox: node.definitions.execution?.sandbox?.backend, browser: node.definitions.execution?.browser?.backend },
        features: { sandbox: node.definitions.execution?.sandbox?.capabilities, browser: node.definitions.execution?.browser?.capabilities },
        available: reachable(node, deps) && node.status !== "offline" && node.leaseExpiresAt.getTime() > Date.now(),
      })) });
    } catch (error) { return failure(c, error); }
  });
  app.post("/tenant/stations/:stationId/execution/:primitive", async (c, next) => {
    if (!identity(c)) return denied(c);
    return next();
  }, limit(), async (c) => {
    const tenantId = identity(c)!;
    try {
      const node = await deps.adapter.getStation(c.req.param("stationId"));
      if (!node || !eligible(node, deps, tenantId)) return c.json({ error: "not_found" }, 404);
      const body = await readBody(c);
      assertAvailable(node, deps.networkId, c.req.param("primitive"), body);
      return await forwardExecution(c, deps, node, body, tenantId);
    } catch (error) { return failure(c, error); }
  });
  return app;
}
