import { Hono } from "hono";
import type { BeaconRunner, BeaconStateAdapter, BeaconInstance } from "station-beacon";
import { beaconLogKey } from "../../subscriber.js";
import { serializeZodSchema } from "../../metadata.js";
import { clampLimit, instanceErrorResponse, serializeInstance } from "../beacons.js";

export interface V1BeaconDeps {
  beaconRunner?: BeaconRunner;
  beaconAdapter?: BeaconStateAdapter;
  logBuffer?: import("../../log-buffer.js").LogBuffer;
  logStore?: import("../../log-store.js").LogStore;
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
    if (!deps.beaconRunner) return c.json({ data: [] });
    const registered = deps.beaconRunner.listRegistered();
    const instances = await deps.beaconRunner.listInstances();
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
    if (!deps.beaconRunner) return c.json(notFound("No beacon runner configured."), 404);
    const meta = deps.beaconRunner.listRegistered().find((b) => b.name === name);
    if (!meta) return c.json(notFound(`Beacon "${name}" not found.`), 404);
    const instances = await deps.beaconRunner.listInstances({ beaconName: name });
    const beacon = deps.beaconRunner.getBeacon(name);
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
    if (!deps.beaconRunner) return c.json({ data: [] });
    const instances = await deps.beaconRunner.listInstances({ beaconName: c.req.param("name") });
    return c.json({ data: instances.map(serializeInstance) });
  });

  app.get("/beacons/:name/instances/:instanceId", async (c) => {
    const inst = await resolve(deps, c.req.param("name"), c.req.param("instanceId"));
    if (!inst) return c.json(notFound("Instance not found."), 404);
    return c.json({ data: serializeInstance(inst) });
  });

  app.get("/beacons/:name/events", async (c) => {
    if (!deps.beaconRunner) return c.json({ data: [] });
    const events = await deps.beaconRunner.listBeaconEvents(
      c.req.param("name"),
      clampLimit(c.req.query("limit")),
    );
    return c.json({ data: events.map(serializeEvent) });
  });

  app.get("/beacons/:name/instances/:instanceId/events", async (c) => {
    if (!deps.beaconRunner) return c.json({ data: [] });
    const events = await deps.beaconRunner.listInstanceEvents(
      c.req.param("instanceId"),
      clampLimit(c.req.query("limit")),
    );
    return c.json({ data: events.map(serializeEvent) });
  });

  app.get("/beacons/:name/instances/:instanceId/logs", async (c) => {
    const key = beaconLogKey(c.req.param("instanceId"));
    const logs = deps.logStore ? await deps.logStore.get(key) : (deps.logBuffer?.get(key) ?? []);
    return c.json({ data: logs });
  });

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
    if (!deps.beaconRunner) return c.json(unavailable, 503);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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
    if (!deps.beaconRunner) return c.json(unavailable, 503);
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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
    if (!deps.beaconRunner) return c.json(unavailable, 503);
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    await deps.beaconRunner.restartInstance(instanceId);
    return c.json({ data: { restarted: true } });
  });

  // Definition-level start/restart, for beacons that have a definition-owned
  // instance (start mode `auto` or `manual`).
  app.post("/beacons/:name/start", async (c) => {
    if (!deps.beaconRunner) return c.json(unavailable, 503);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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
    if (!deps.beaconRunner) return c.json(unavailable, 503);
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
    if (!deps.beaconRunner) return c.json(unavailable, 503);
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    await deps.beaconRunner.stopInstance(instanceId);
    return c.json({ data: { stopped: true } });
  });

  app.post("/beacons/:name/stop", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) return c.json(unavailable, 503);
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
    if (!deps.beaconRunner) return c.json(unavailable, 503);
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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
    if (!deps.beaconRunner) return c.json(unavailable, 503);
    if (!(await resolve(deps, c.req.param("name"), instanceId))) {
      return c.json(notFound("Instance not found."), 404);
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
  if (!deps.beaconRunner) return null;
  const inst = await deps.beaconRunner.getInstance(instanceId);
  return inst && inst.beaconName === beaconName ? inst : null;
}

function serializeOrNull(inst: BeaconInstance | undefined): Record<string, unknown> | null {
  return inst ? serializeInstance(inst) : null;
}
