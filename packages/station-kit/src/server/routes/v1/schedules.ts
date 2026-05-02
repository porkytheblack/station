import { Hono } from "hono";
import { parseInterval } from "station-signal";
import type { Schedule, ScheduleAdapter, ScheduleKind } from "station-schedules";

export interface V1ScheduleDeps {
  scheduleAdapter?: ScheduleAdapter;
}

const KIND_VALUES: ScheduleKind[] = ["signal", "broadcast-static", "broadcast-dynamic"];

/** Read-scope routes: list / get / preview. */
export function v1ScheduleReadRoutes(deps: V1ScheduleDeps) {
  const app = new Hono();

  app.get("/schedules", async (c) => {
    if (!deps.scheduleAdapter) return c.json({ data: [] });
    const kindParam = c.req.query("kind");
    const enabledParam = c.req.query("enabled");

    const kind = KIND_VALUES.includes(kindParam as ScheduleKind)
      ? (kindParam as ScheduleKind)
      : undefined;
    const enabled = enabledParam === "true" ? true : enabledParam === "false" ? false : undefined;

    const list = await deps.scheduleAdapter.list({ kind, enabled });
    return c.json({ data: list.map(serialize) });
  });

  app.get("/schedules/:id", async (c) => {
    if (!deps.scheduleAdapter) return c.json({ error: "unavailable" }, 503);
    const s = await deps.scheduleAdapter.get(c.req.param("id"));
    if (!s) return c.json({ error: "not_found" }, 404);
    return c.json({ data: serialize(s) });
  });

  app.post("/schedules/:id/preview", async (c) => {
    if (!deps.scheduleAdapter) return c.json({ error: "unavailable" }, 503);
    const id = c.req.param("id");
    const s = await deps.scheduleAdapter.get(id);
    if (!s) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const count = Math.min(20, Math.max(1, Number(body.count) || 5));
    const ms = parseInterval(s.interval);
    const fires: string[] = [];
    let next = s.nextRunAt.getTime();
    for (let i = 0; i < count; i++) {
      fires.push(new Date(next).toISOString());
      next += ms;
    }
    return c.json({ data: { fires } });
  });

  return app;
}

/** Admin-scope routes: create / update / delete. */
export function v1ScheduleRoutes(deps: V1ScheduleDeps) {
  const app = new Hono();

  app.post("/schedules", async (c) => {
    if (!deps.scheduleAdapter) return c.json({ error: "unavailable" }, 503);
    const body = await c.req.json().catch(() => ({}));
    const { kind, target, interval, input, enabled } = body as Partial<Schedule>;

    if (!KIND_VALUES.includes(kind as ScheduleKind)) {
      return c.json({ error: "bad_request", message: `kind must be one of ${KIND_VALUES.join(", ")}` }, 400);
    }
    if (typeof target !== "string" || target.length === 0) {
      return c.json({ error: "bad_request", message: "target is required" }, 400);
    }
    if (typeof interval !== "string") {
      return c.json({ error: "bad_request", message: "interval is required" }, 400);
    }
    let intervalMs: number;
    try {
      intervalMs = parseInterval(interval);
    } catch (err) {
      return c.json({
        error: "bad_request",
        message: `interval invalid: ${err instanceof Error ? err.message : String(err)}`,
      }, 400);
    }
    // Reject circular / non-serializable inputs before they reach the adapter,
    // which would otherwise surface as a 500 with a stacktrace.
    if (input !== undefined) {
      try {
        JSON.stringify(input);
      } catch (err) {
        return c.json({
          error: "bad_request",
          message: `input is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
        }, 400);
      }
    }

    const apiKeyId = c.get("apiKeyId" as never) as string | undefined;
    const now = new Date();
    const schedule: Schedule = {
      id: deps.scheduleAdapter.generateId(),
      kind: kind as ScheduleKind,
      target,
      interval,
      input,
      enabled: enabled ?? true,
      nextRunAt: new Date(now.getTime() + intervalMs),
      createdAt: now,
      updatedAt: now,
      createdBy: apiKeyId,
    };
    await deps.scheduleAdapter.add(schedule);
    return c.json({ data: serialize(schedule) }, 201);
  });

  app.patch("/schedules/:id", async (c) => {
    if (!deps.scheduleAdapter) return c.json({ error: "unavailable" }, 503);
    const id = c.req.param("id");
    const existing = await deps.scheduleAdapter.get(id);
    if (!existing) return c.json({ error: "not_found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    if ("interval" in body) {
      try {
        parseInterval(body.interval);
      } catch (err) {
        return c.json({
          error: "bad_request",
          message: `interval invalid: ${err instanceof Error ? err.message : String(err)}`,
        }, 400);
      }
      patch.interval = body.interval;
    }
    if ("input" in body) {
      try {
        JSON.stringify(body.input);
      } catch (err) {
        return c.json({
          error: "bad_request",
          message: `input is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
        }, 400);
      }
      patch.input = body.input;
    }
    if ("enabled" in body) patch.enabled = Boolean(body.enabled);
    if ("nextRunAt" in body) {
      const parsed = new Date(body.nextRunAt);
      if (Number.isNaN(parsed.getTime())) {
        return c.json({ error: "bad_request", message: "nextRunAt must be a valid date" }, 400);
      }
      patch.nextRunAt = parsed;
    }

    await deps.scheduleAdapter.update(id, patch);
    const updated = await deps.scheduleAdapter.get(id);
    return c.json({ data: updated ? serialize(updated) : null });
  });

  app.delete("/schedules/:id", async (c) => {
    if (!deps.scheduleAdapter) return c.json({ error: "unavailable" }, 503);
    const ok = await deps.scheduleAdapter.delete(c.req.param("id"));
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ data: { deleted: true } });
  });

  return app;
}

function serialize(s: Schedule): Record<string, unknown> {
  return {
    ...s,
    nextRunAt: s.nextRunAt.toISOString(),
    lastRunAt: s.lastRunAt?.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}
