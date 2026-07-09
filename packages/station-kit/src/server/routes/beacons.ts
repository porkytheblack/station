import { Hono } from "hono";
import type { BeaconRunner, BeaconStateAdapter, BeaconInstance } from "station-beacon";
import { beaconLogKey } from "../subscriber.js";

export interface BeaconDeps {
  beaconRunner?: BeaconRunner;
  beaconAdapter?: BeaconStateAdapter;
  logBuffer?: import("../log-buffer.js").LogBuffer;
  logStore?: import("../log-store.js").LogStore;
}

function serializeInstance(inst: BeaconInstance): Record<string, unknown> {
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

export function beaconRoutes(deps: BeaconDeps) {
  const app = new Hono();

  // GET /beacons — list registered beacons merged with their instance state
  app.get("/beacons", async (c) => {
    if (!deps.beaconRunner) return c.json({ data: [] });
    const registered = deps.beaconRunner.listRegistered();
    const instances = await deps.beaconRunner.listInstances();
    const byName = new Map(instances.map((i) => [i.beaconName, i]));
    const data = registered.map((r) => {
      const inst = byName.get(r.name);
      return { ...r, instance: inst ? serializeInstance(inst) : null };
    });
    return c.json({ data });
  });

  // GET /beacons/:name — registered metadata + current instance
  app.get("/beacons/:name", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) {
      return c.json({ error: "not_found", message: "No beacon runner configured." }, 404);
    }
    const meta = deps.beaconRunner.listRegistered().find((b) => b.name === name);
    if (!meta) {
      return c.json({ error: "not_found", message: `Beacon "${name}" not found.` }, 404);
    }
    const inst = await deps.beaconRunner.getInstance(name);
    return c.json({ data: { ...meta, instance: inst ? serializeInstance(inst) : null } });
  });

  // GET /beacons/:name/events — lifecycle event log (if the adapter records one)
  app.get("/beacons/:name/events", async (c) => {
    const name = c.req.param("name");
    // Clamp so a client can't request an unbounded (or NaN) event scan.
    const raw = Number(c.req.query("limit") ?? "200");
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 200;
    if (!deps.beaconAdapter?.listEvents) return c.json({ data: [] });
    const events = await deps.beaconAdapter.listEvents(name, limit);
    return c.json({
      data: events.map((e) => ({ ...e, at: e.at?.toISOString?.() ?? e.at })),
    });
  });

  // GET /beacons/:name/logs — captured stdout/stderr/log lines
  app.get("/beacons/:name/logs", async (c) => {
    const name = c.req.param("name");
    const key = beaconLogKey(name);
    const logs = deps.logStore
      ? await deps.logStore.get(key)
      : deps.logBuffer?.get(key) ?? [];
    return c.json({ data: logs });
  });

  // POST /beacons/:name/{start,stop,restart} — operator controls
  app.post("/beacons/:name/start", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }
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
    if (!deps.beaconRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }
    await deps.beaconRunner.stopBeacon(name);
    return c.json({ data: { stopped: true } });
  });

  app.post("/beacons/:name/restart", async (c) => {
    const name = c.req.param("name");
    if (!deps.beaconRunner) {
      return c.json({ error: "read_only", message: "Station is in read-only mode." }, 403);
    }
    await deps.beaconRunner.restartBeacon(name);
    return c.json({ data: { restarted: true } });
  });

  return app;
}
