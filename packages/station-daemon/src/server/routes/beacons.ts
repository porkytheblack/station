import { Hono } from "hono";
import type { BeaconRunner, BeaconStateAdapter, BeaconInstance } from "station-beacon";
import { beaconLogKey } from "../subscriber.js";
import { serializeZodSchema } from "../metadata.js";

export interface BeaconDeps {
  beaconRunner?: BeaconRunner;
  beaconAdapter?: BeaconStateAdapter;
  logBuffer?: import("../log-buffer.js").LogBuffer;
  logStore?: import("../log-store.js").LogStore;
}

export function serializeInstance(inst: BeaconInstance): Record<string, unknown> {
  return {
    ...inst,
    startedAt: inst.startedAt?.toISOString?.() ?? inst.startedAt,
    readyAt: inst.readyAt?.toISOString?.() ?? inst.readyAt,
    lastHeartbeatAt: inst.lastHeartbeatAt?.toISOString?.() ?? inst.lastHeartbeatAt,
    lastExitAt: inst.lastExitAt?.toISOString?.() ?? inst.lastExitAt,
    nextRestartAt: inst.nextRestartAt?.toISOString?.() ?? inst.nextRestartAt,
    createdAt: inst.createdAt?.toISOString?.() ?? inst.createdAt,
    updatedAt: inst.updatedAt?.toISOString?.() ?? inst.updatedAt,
  };
}

/** Clamp a client-supplied `limit` so nobody can request an unbounded scan. */
export function clampLimit(raw: string | undefined, fallback = 200): number {
  const n = Number(raw ?? String(fallback));
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 1000) : fallback;
}

/**
 * Map a runner error onto an HTTP status. Instance creation is a normal API
 * operation, so its failure modes — unknown beacon, taken id, cap reached,
 * invalid config — need to be distinguishable by a client.
 */
export function instanceErrorResponse(err: unknown): { status: 400 | 404 | 409; body: Record<string, string> } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code;
  if (code === "BEACON_INSTANCE_EXISTS") return { status: 409, body: { error: "instance_exists", message } };
  if (code === "BEACON_INSTANCE_LIMIT") return { status: 409, body: { error: "instance_limit", message } };
  if (code === "BEACON_INSTANCE_NOT_FOUND") return { status: 404, body: { error: "not_found", message } };
  if (code === "BEACON_VALIDATION_ERROR") return { status: 400, body: { error: "invalid_config", message } };
  if (/is not registered/.test(message)) return { status: 404, body: { error: "not_found", message } };
  return { status: 400, body: { error: "bad_request", message } };
}

export function beaconRoutes(deps: BeaconDeps) {
  const app = new Hono();

  const readOnly = () =>
    ({ error: "read_only", message: "Station is in read-only mode." }) as const;

  /** Resolve an instance and confirm it belongs to the beacon in the path. */
  async function resolveInstance(beaconName: string, instanceId: string) {
    const inst = await deps.beaconRunner!.getInstance(instanceId);
    if (!inst || inst.beaconName !== beaconName) return null;
    return inst;
  }

  // GET /beacons — list registered beacons with their instances
  app.get("/beacons", async (c) => {
    if (!deps.beaconRunner) return c.json({ data: [] });
    const registered = deps.beaconRunner.listRegistered();
    const instances = await deps.beaconRunner.listInstances();
    const byBeacon = new Map<string, BeaconInstance[]>();
    for (const inst of instances) {
      const list = byBeacon.get(inst.beaconName) ?? [];
      list.push(inst);
      byBeacon.set(inst.beaconName, list);
    }
    const data = registered.map((r) => {
      const list = byBeacon.get(r.name) ?? [];
      return {
        ...r,
        // `instance` is the beacon's definition-owned instance — the one the
        // definition-level controls act on. On-demand beacons have none.
        instance: serializeOrNull(list.find((i) => i.id === r.name)),
        instances: list.map(serializeInstance),
        instanceCount: list.length,
        runningCount: list.filter((i) => i.status === "running").length,
      };
    });
    return c.json({ data });
  });

  // GET /beacons/:name — registered metadata + every instance + the config schema
  app.get("/beacons/:name", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) {
      return c.json({ error: "not_found", message: "No beacon runner configured." }, 404);
    }
    const meta = deps.beaconRunner.listRegistered().find((b) => b.name === name);
    if (!meta) {
      return c.json({ error: "not_found", message: `Beacon "${name}" not found.` }, 404);
    }
    const instances = await deps.beaconRunner.listInstances({ beaconName: name });
    // The dashboard renders a form from this so an operator can supply config
    // when creating an instance.
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

  // GET /beacons/:name/events — lifecycle events across every instance
  app.get("/beacons/:name/events", async (c) => {
    const name = c.req.param("name");
    const limit = clampLimit(c.req.query("limit"));
    if (!deps.beaconRunner) return c.json({ data: [] });
    const events = await deps.beaconRunner.listBeaconEvents(name, limit);
    return c.json({ data: events.map(serializeEvent) });
  });

  // GET /beacons/:name/logs — captured output of the definition-owned instance
  app.get("/beacons/:name/logs", async (c) => {
    return c.json({ data: await readLogs(deps, c.req.param("name")) });
  });

  // ── Instances ────────────────────────────────────────────────────

  // GET /beacons/:name/instances
  app.get("/beacons/:name/instances", async (c) => {
    if (!deps.beaconRunner) return c.json({ data: [] });
    const instances = await deps.beaconRunner.listInstances({ beaconName: c.req.param("name") });
    return c.json({ data: instances.map(serializeInstance) });
  });

  // POST /beacons/:name/instances — create (and by default start) a new instance
  app.post("/beacons/:name/instances", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) return c.json(readOnly(), 403);
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

  // GET /beacons/:name/instances/:instanceId
  app.get("/beacons/:name/instances/:instanceId", async (c) => {
    if (!deps.beaconRunner) {
      return c.json({ error: "not_found", message: "No beacon runner configured." }, 404);
    }
    const inst = await resolveInstance(c.req.param("name"), c.req.param("instanceId"));
    if (!inst) return c.json({ error: "not_found", message: "Instance not found." }, 404);
    return c.json({ data: serializeInstance(inst) });
  });

  // PATCH /beacons/:name/instances/:instanceId — change config / label
  app.patch("/beacons/:name/instances/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    if (!deps.beaconRunner) return c.json(readOnly(), 403);
    if (!(await resolveInstance(c.req.param("name"), instanceId))) {
      return c.json({ error: "not_found", message: "Instance not found." }, 404);
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

  // DELETE /beacons/:name/instances/:instanceId — stop and remove
  app.delete("/beacons/:name/instances/:instanceId", async (c) => {
    const instanceId = c.req.param("instanceId");
    if (!deps.beaconRunner) return c.json(readOnly(), 403);
    if (!(await resolveInstance(c.req.param("name"), instanceId))) {
      return c.json({ error: "not_found", message: "Instance not found." }, 404);
    }
    try {
      await deps.beaconRunner.deleteInstance(instanceId);
      return c.json({ data: { deleted: true } });
    } catch (err: unknown) {
      const { status, body: errBody } = instanceErrorResponse(err);
      return c.json(errBody, status);
    }
  });

  // GET /beacons/:name/instances/:instanceId/events
  app.get("/beacons/:name/instances/:instanceId/events", async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    if (!deps.beaconRunner) return c.json({ data: [] });
    const events = await deps.beaconRunner.listInstanceEvents(c.req.param("instanceId"), limit);
    return c.json({ data: events.map(serializeEvent) });
  });

  // GET /beacons/:name/instances/:instanceId/logs
  app.get("/beacons/:name/instances/:instanceId/logs", async (c) => {
    return c.json({ data: await readLogs(deps, c.req.param("instanceId")) });
  });

  // POST /beacons/:name/instances/:instanceId/{start,stop,restart}
  for (const action of ["start", "stop", "restart"] as const) {
    app.post(`/beacons/:name/instances/:instanceId/${action}`, async (c) => {
      const instanceId = c.req.param("instanceId");
      if (!deps.beaconRunner) return c.json(readOnly(), 403);
      if (!(await resolveInstance(c.req.param("name"), instanceId))) {
        return c.json({ error: "not_found", message: "Instance not found." }, 404);
      }
      try {
        if (action === "start") {
          const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          await deps.beaconRunner.startInstance(
            instanceId,
            "config" in body ? { config: body.config } : undefined,
          );
        } else if (action === "stop") {
          await deps.beaconRunner.stopInstance(instanceId);
        } else {
          await deps.beaconRunner.restartInstance(instanceId);
        }
        return c.json({ data: { [`${action}ed`]: true } });
      } catch (err: unknown) {
        const { status, body: errBody } = instanceErrorResponse(err);
        return c.json(errBody, status);
      }
    });
  }

  // ── Definition-level controls (act on the definition-owned instance) ──

  app.post("/beacons/:name/start", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) return c.json(readOnly(), 403);
    const body = await c.req.json().catch(() => ({}));
    try {
      await deps.beaconRunner.startBeacon(name, "config" in body ? { config: body.config } : undefined);
      return c.json({ data: { started: true } });
    } catch (err: unknown) {
      return c.json({ error: "start_failed", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/beacons/:name/stop", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) return c.json(readOnly(), 403);
    // `all=true` stops every instance of the beacon, not just the definition one.
    if (c.req.query("all") === "true") {
      const stopped = await deps.beaconRunner.stopAllInstances(name);
      return c.json({ data: { stopped: true, count: stopped } });
    }
    await deps.beaconRunner.stopBeacon(name);
    return c.json({ data: { stopped: true } });
  });

  app.post("/beacons/:name/restart", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) return c.json(readOnly(), 403);
    try {
      await deps.beaconRunner.restartBeacon(name);
      return c.json({ data: { restarted: true } });
    } catch (err: unknown) {
      return c.json({ error: "restart_failed", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}

function serializeOrNull(inst: BeaconInstance | undefined): Record<string, unknown> | null {
  return inst ? serializeInstance(inst) : null;
}

function serializeEvent(e: { at?: Date }): Record<string, unknown> {
  return { ...e, at: e.at?.toISOString?.() ?? e.at };
}

async function readLogs(deps: BeaconDeps, instanceId: string) {
  const key = beaconLogKey(instanceId);
  return deps.logStore ? await deps.logStore.get(key) : (deps.logBuffer?.get(key) ?? []);
}
