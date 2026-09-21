import { Hono, type Context } from "hono";
import {
  MAX_INSTANCE_ID_LENGTH,
  VALID_INSTANCE_ID,
  type BeaconRunner,
  type BeaconStateAdapter,
  type BeaconInstance,
  type BeaconExposure,
} from "station-beacon";
import type { StationNetworkAdapter } from "station-network";
import { beaconLogKey } from "../../subscriber.js";
import { serializeZodSchema } from "../../metadata.js";
import { clampLimit, instanceErrorResponse, serializeInstance } from "../beacons.js";

export interface V1BeaconDeps {
  beaconRunner?: BeaconRunner;
  beaconAdapter?: BeaconStateAdapter;
  logBuffer?: import("../../log-buffer.js").LogBuffer;
  logStore?: import("../../log-store.js").LogStore;
  networkAdapter?: StationNetworkAdapter;
  networkId?: string;
  maxInstancesPerBeacon?: number;
}

const unavailable = { error: "unavailable", message: "Station is in read-only mode." } as const;
const notFound = (message: string) => ({ error: "not_found", message }) as const;

function serializeEvent(e: { at?: Date }): Record<string, unknown> {
  return { ...e, at: e.at?.toISOString?.() ?? e.at };
}

/**
 * Read-scope routes: what beacons exist, what instances are running, and their
 * event/log history.
 */
export function v1BeaconReadRoutes(deps: V1BeaconDeps) {
  const app = new Hono();

  app.get("/beacons", async (c) => {
    const registered = await registeredBeacons(deps);
    const instances = await listInstances(deps);
    const data = registered.map((r) => {
      const list = instances.filter((i) => i.beaconName === r.name);
      return {
        ...r,
        instance: serializeOrNull(list.find((i) => i.id === r.name)),
        instances: list.map(serializeInstance),
        instanceCount: list.length,
        runningCount: list.filter((i) => i.status === "running").length,
      };
    });
    return c.json({ data });
  });

  app.get("/beacons/:name", async (c) => {
    const name = c.req.param("name");
    const meta = (await registeredBeacons(deps)).find((b) => b.name === name);
    if (!meta) return c.json(notFound(`Beacon "${name}" not found.`), 404);
    const instances = await listInstances(deps, name);
    const beacon = deps.beaconRunner?.getBeacon(name);
    return c.json({
      data: {
        ...meta,
        configSchema: beacon?.configSchema ? serializeZodSchema(beacon.configSchema) : null,
        defaultConfig: beacon?.defaultConfig ?? null,
        instance: serializeOrNull(instances.find((i) => i.id === name)),
        instances: instances.map(serializeInstance),
        instanceCount: instances.length,
        runningCount: instances.filter((i) => i.status === "running").length,
      },
    });
  });

  app.get("/beacons/:name/instances", async (c) => {
    const instances = await listInstances(deps, c.req.param("name"));
    return c.json({ data: instances.map(serializeInstance) });
  });

  app.get("/beacons/:name/instances/:instanceId", async (c) => {
    const inst = await resolve(deps, c.req.param("name"), c.req.param("instanceId"));
    if (!inst) return c.json(notFound("Instance not found."), 404);
    return c.json({ data: serializeInstance(inst) });
  });

  app.get("/beacons/:name/events", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const events = deps.beaconRunner
      ? await deps.beaconRunner.listBeaconEvents(c.req.param("name"), limit)
      : await deps.beaconAdapter?.listBeaconEvents?.(c.req.param("name"), limit) ?? [];
    return c.json({ data: events.map(serializeEvent) });
  });

  app.get("/beacons/:name/instances/:instanceId/events", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const events = deps.beaconRunner
      ? await deps.beaconRunner.listInstanceEvents(c.req.param("instanceId"), limit)
      : await deps.beaconAdapter?.listEvents?.(c.req.param("instanceId"), limit) ?? [];
    return c.json({ data: events.map(serializeEvent) });
  });

  app.get("/beacons/:name/instances/:instanceId/logs", async (c) => {
    const key = beaconLogKey(c.req.param("instanceId"));
    const logs = deps.logStore ? await deps.logStore.get(key) : (deps.logBuffer?.get(key) ?? []);
    return c.json({ data: logs });
  });

  return app;
}

/** Proxy an advertised HTTP beacon service through Headquarters. */
export function v1BeaconProxyRoutes(deps: V1BeaconDeps) {
  const app = new Hono();

  const proxy = async (c: Context) => {
    const instance = await resolve(deps, c.req.param("name"), c.req.param("instanceId"));
    if (!instance) return c.json(notFound("Instance not found."), 404);
    if (instance.status !== "running" || !instance.stationId || !instance.exposure) {
      return c.json({ error: "unavailable", message: "Beacon service is not currently exposed." }, 503);
    }
    if (!deps.networkAdapter) return c.json(unavailable, 503);
    const station = await deps.networkAdapter.getStation(instance.stationId);
    if (!station || station.networkId !== deps.networkId || station.status === "offline"
      || station.leaseExpiresAt <= new Date() || !station.endpoint) {
      return c.json({ error: "unavailable", message: "Owning station is offline or has no endpoint." }, 503);
    }

    let exposure: BeaconExposure;
    try {
      exposure = JSON.parse(instance.exposure) as BeaconExposure;
    } catch {
      return c.json({ error: "invalid_exposure", message: "Beacon advertised an invalid exposure." }, 502);
    }
    if (!exposure || !["http", "https", "ws", "wss"].includes(exposure.protocol)
      || !Number.isInteger(exposure.port) || exposure.port < 1 || exposure.port > 65535
      || (exposure.path !== undefined && (typeof exposure.path !== "string" || !exposure.path.startsWith("/")))) {
      return c.json({ error: "invalid_exposure", message: "Beacon advertised an invalid exposure." }, 502);
    }
    if (exposure.protocol === "ws" || exposure.protocol === "wss") {
      return c.json({
        error: "upgrade_required",
        message: "Use a WebSocket client against the advertised station endpoint.",
        data: { stationId: station.id, protocol: exposure.protocol },
      }, 426);
    }

    let target: URL;
    try {
      target = new URL(station.endpoint);
      target.protocol = `${exposure.protocol}:`;
      target.port = String(exposure.port);
      const requestPath = new URL(c.req.url).pathname;
      const instanceAt = requestPath.indexOf("/instances/");
      const proxyAt = instanceAt >= 0 ? requestPath.indexOf("/proxy", instanceAt + 11) : -1;
      const suffix = proxyAt >= 0 ? requestPath.slice(proxyAt + "/proxy".length) : "";
      target.pathname = joinUrlPath(exposure.path, suffix);
      target.search = new URL(c.req.url).search;
    } catch {
      return c.json({ error: "invalid_endpoint", message: "Owning station advertised an invalid endpoint." }, 502);
    }

    const headers = new Headers(c.req.raw.headers);
    for (const name of ["authorization", "cookie", "host", "connection", "upgrade", "content-length"]) {
      headers.delete(name);
    }
    headers.set("x-station-network", deps.networkId ?? "default");
    headers.set("x-station-id", station.id);
    headers.set("x-beacon-instance", instance.id);

    try {
      const response = await fetch(target, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
        duplex: "half",
        redirect: "manual",
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("transfer-encoding");
      responseHeaders.delete("content-length");
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      return c.json({
        error: "bad_gateway",
        message: error instanceof Error ? error.message : "Beacon proxy request failed.",
      }, 502);
    }
  };

  app.all("/beacons/:name/instances/:instanceId/proxy", proxy);
  app.all("/beacons/:name/instances/:instanceId/proxy/*", proxy);
  return app;
}

/**
 * Routes that bring a beacon up: create an instance, or start/restart an
 * existing one. Grouped under the `trigger` scope — spawning supervised work is
 * the beacon equivalent of triggering a signal.
 */
export function v1BeaconStartRoutes(deps: V1BeaconDeps) {
  const app = new Hono();

  // Create a new instance of a beacon, with its own config, and start it.
  app.post("/beacons/:name/instances", async (c) => {
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      if (!(await hasRegisteredBeacon(deps, name))) return c.json(notFound(`Beacon "${name}" not found.`), 404);
      const existingInstances = await deps.beaconAdapter.listInstances({ beaconName: name });
      if (existingInstances.length >= (deps.maxInstancesPerBeacon ?? 100)) {
        return c.json({ error: "instance_limit", message: `Beacon "${name}" reached its instance limit.` }, 409);
      }
      const id = typeof body.id === "string" ? body.id : `${name}-${deps.beaconAdapter.generateId().slice(0, 8)}`;
      if (!VALID_INSTANCE_ID.test(id) || id.length > MAX_INSTANCE_ID_LENGTH) {
        return c.json({ error: "bad_request", message: "Invalid beacon instance id." }, 400);
      }
      if (await deps.beaconAdapter.getInstance(id)) {
        return c.json({ error: "instance_exists", message: `Beacon instance "${id}" already exists.` }, 409);
      }
      const now = new Date();
      const start = body.start !== false;
      const instance: BeaconInstance = {
        id,
        beaconName: name,
        label: typeof body.label === "string" ? body.label : undefined,
        origin: "api",
        status: start ? "backoff" : "stopped",
        desiredState: start ? "running" : "stopped",
        incarnation: 0,
        restartCount: 0,
        config: "config" in body && body.config !== undefined ? JSON.stringify(body.config) : undefined,
        nextRestartAt: start ? now : undefined,
        createdAt: now,
        updatedAt: now,
      };
      await deps.beaconAdapter.upsertInstance(instance);
      return c.json({ data: serializeInstance(instance) }, 201);
    }
    try {
      const instance = await deps.beaconRunner.createInstance(name, {
        id: typeof body.id === "string" ? body.id : undefined,
        label: typeof body.label === "string" ? body.label : undefined,
        ...("config" in body ? { config: body.config } : {}),
        start: body.start === undefined ? undefined : body.start !== false,
      });
      return c.json({ data: serializeInstance(instance) }, 201);
    } catch (err: unknown) {
      const { status, body: errBody } = instanceErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  app.post("/beacons/:name/instances/:instanceId/start", async (c) => {
    const instanceId = c.req.param("instanceId");
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      await deps.beaconAdapter.updateInstance(instanceId, {
        desiredState: "running",
        status: "backoff",
        nextRestartAt: new Date(),
        restartCount: 0,
        lastError: undefined,
        ...(Object.hasOwn(body, "config") ? { config: body.config === undefined ? undefined : JSON.stringify(body.config) } : {}),
      });
      return c.json({ data: { started: true } });
    }
    try {
      await deps.beaconRunner.startInstance(
        instanceId,
        "config" in body ? { config: body.config } : undefined,
      );
      return c.json({ data: { started: true } });
    } catch (err: unknown) {
      const { status, body: errBody } = instanceErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  app.post("/beacons/:name/instances/:instanceId/restart", async (c) => {
    const instanceId = c.req.param("instanceId");
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      await deps.beaconAdapter.updateInstance(instanceId, {
        desiredState: "running", status: "backoff", nextRestartAt: new Date(), lastError: undefined,
      });
      return c.json({ data: { restarted: true } });
    }
    await deps.beaconRunner.restartInstance(instanceId);
    return c.json({ data: { restarted: true } });
  });

  // Definition-level start/restart, for beacons that have a definition-owned
  // instance (start mode `auto` or `manual`).
  app.post("/beacons/:name/start", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      if (!(await hasRegisteredBeacon(deps, c.req.param("name")))) return c.json(notFound("Beacon not found."), 404);
      const existing = await deps.beaconAdapter.getInstance(c.req.param("name"));
      if (!existing) return c.json(notFound("Definition-owned instance has not been seeded yet."), 404);
      await deps.beaconAdapter.updateInstance(existing.id, {
        desiredState: "running", status: "backoff", nextRestartAt: new Date(),
        ...(Object.hasOwn(body, "config") ? { config: body.config === undefined ? undefined : JSON.stringify(body.config) } : {}),
      });
      return c.json({ data: { started: true } });
    }
    try {
      await deps.beaconRunner.startBeacon(
        c.req.param("name"),
        "config" in body ? { config: body.config } : undefined,
      );
      return c.json({ data: { started: true } });
    } catch (err: unknown) {
      const { status, body: errBody } = instanceErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  app.post("/beacons/:name/restart", async (c) => {
    if (!deps.beaconRunner) {
      const inst = await resolve(deps, c.req.param("name"), c.req.param("name"));
      if (!inst || !deps.beaconAdapter) return c.json(notFound("Beacon instance not found."), 404);
      await deps.beaconAdapter.updateInstance(inst.id, {
        desiredState: "running", status: "backoff", nextRestartAt: new Date(), lastError: undefined,
      });
      return c.json({ data: { restarted: true } });
    }
    try {
      await deps.beaconRunner.restartBeacon(c.req.param("name"));
      return c.json({ data: { restarted: true } });
    } catch (err: unknown) {
      const { status, body: errBody } = instanceErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  return app;
}

/**
 * Routes that bring a beacon down. Grouped under the `cancel` scope, so a key
 * that can halt work doesn't also need permission to start it.
 */
export function v1BeaconStopRoutes(deps: V1BeaconDeps) {
  const app = new Hono();

  app.post("/beacons/:name/instances/:instanceId/stop", async (c) => {
    const instanceId = c.req.param("instanceId");
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      await deps.beaconAdapter.updateInstance(instanceId, { desiredState: "stopped" });
      return c.json({ data: { stopped: true } });
    }
    await deps.beaconRunner.stopInstance(instanceId);
    return c.json({ data: { stopped: true } });
  });

  app.post("/beacons/:name/stop", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      const instances = await deps.beaconAdapter.listInstances({ beaconName: name });
      const targets = c.req.query("all") === "true" ? instances : instances.filter((i) => i.id === name);
      await Promise.all(targets.map((i) => deps.beaconAdapter!.updateInstance(i.id, { desiredState: "stopped" })));
      return c.json({ data: { stopped: true, count: targets.length } });
    }
    if (c.req.query("all") === "true") {
      const count = await deps.beaconRunner.stopAllInstances(name);
      return c.json({ data: { stopped: true, count } });
    }
    await deps.beaconRunner.stopBeacon(name);
    return c.json({ data: { stopped: true } });
  });

  return app;
}

/**
 * Admin-scope routes: removing an instance destroys its record and history, and
 * editing config changes what a future incarnation runs.
 */
export function v1BeaconAdminRoutes(deps: V1BeaconDeps) {
  const app = new Hono();

  app.patch("/beacons/:name/instances/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      await deps.beaconAdapter.updateInstance(instanceId, {
        ...(Object.hasOwn(body, "config") ? { config: body.config === undefined ? undefined : JSON.stringify(body.config) } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(body.restart === true ? { desiredState: "running" as const, status: "backoff" as const, nextRestartAt: new Date() } : {}),
      });
      return c.json({ data: serializeInstance((await deps.beaconAdapter.getInstance(instanceId))!) });
    }
    try {
      const updated = await deps.beaconRunner.updateInstance(instanceId, {
        ...("config" in body ? { config: body.config } : {}),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        restart: body.restart === true,
      });
      return c.json({ data: serializeInstance(updated) });
    } catch (err: unknown) {
      const { status, body: errBody } = instanceErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  app.delete("/beacons/:name/instances/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    const existing = await resolve(deps, c.req.param("name"), instanceId);
    if (!existing) {
      return c.json(notFound("Instance not found."), 404);
    }
    if (!deps.beaconRunner) {
      if (!deps.beaconAdapter) return c.json(unavailable, 503);
      if (existing.origin === "definition") {
        return c.json({ error: "bad_request", message: "Definition-owned instances cannot be deleted." }, 400);
      }
      if (existing.status !== "stopped" && existing.status !== "errored") {
        return c.json({ error: "conflict", message: "Stop the instance before deleting it through Headquarters." }, 409);
      }
      await deps.beaconAdapter.removeInstance(instanceId);
      return c.json({ data: { deleted: true } });
    }
    try {
      await deps.beaconRunner.deleteInstance(instanceId);
      return c.json({ data: { deleted: true } });
    } catch (err: unknown) {
      const { status, body: errBody } = instanceErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  return app;
}

/** Look up an instance and confirm it belongs to the beacon named in the path. */
async function resolve(
  deps: V1BeaconDeps,
  beaconName: string,
  instanceId: string,
): Promise<BeaconInstance | null> {
  const inst = deps.beaconRunner
    ? await deps.beaconRunner.getInstance(instanceId)
    : await deps.beaconAdapter?.getInstance(instanceId) ?? null;
  return inst && inst.beaconName === beaconName ? inst : null;
}

async function listInstances(deps: V1BeaconDeps, beaconName?: string): Promise<BeaconInstance[]> {
  if (deps.beaconRunner) return deps.beaconRunner.listInstances(beaconName ? { beaconName } : undefined);
  return deps.beaconAdapter?.listInstances(beaconName ? { beaconName } : undefined) ?? [];
}

async function registeredBeacons(deps: V1BeaconDeps): Promise<Array<{ name: string; [key: string]: unknown }>> {
  if (deps.beaconRunner) return deps.beaconRunner.listRegistered();
  if (!deps.networkAdapter) return [];
  await deps.networkAdapter.markOfflineBefore(new Date(), deps.networkId);
  const stations = await deps.networkAdapter.listStations({ networkId: deps.networkId, status: "online" });
  const byName = new Map<string, { name: string; [key: string]: unknown }>();
  for (const station of stations) {
    for (const metadata of station.definitions.beaconMetadata ?? []) {
      if (!byName.has(metadata.name)) byName.set(metadata.name, { ...metadata, distributed: true });
    }
    // Backwards compatibility with stations that only advertise beacon names.
    for (const name of station.definitions.beacons) {
      if (!byName.has(name)) byName.set(name, { name, distributed: true });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function hasRegisteredBeacon(deps: V1BeaconDeps, name: string): Promise<boolean> {
  return (await registeredBeacons(deps)).some((beacon) => beacon.name === name);
}

function joinUrlPath(base = "/", suffix = ""): string {
  const left = `/${base}`.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const right = suffix.replace(/^\/+/, "");
  return right ? `${left}/${right}` : left || "/";
}

function serializeOrNull(inst: BeaconInstance | undefined): Record<string, unknown> | null {
  return inst ? serializeInstance(inst) : null;
}
