import { Hono } from "hono";
import { parseInterval } from "station-signal";
import { nextScheduleOccurrence, validateCron, type Schedule, type ScheduleAdapter, type ScheduleKind } from "station-schedules";

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
    const fires: string[] = [];
    let next = s.nextRunAt;
    for (let i = 0; i < count; i++) {
      fires.push(next.toISOString());
      next = nextScheduleOccurrence(s, next, parseInterval);
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
    const { kind, target, interval, cron, timezone, input, enabled, overlapPolicy, misfirePolicy, misfireGraceMs } = body as Partial<Schedule>;

    if (!KIND_VALUES.includes(kind as ScheduleKind)) {
      return c.json({ error: "bad_request", message: `kind must be one of ${KIND_VALUES.join(", ")}` }, 400);
    }
    if (typeof target !== "string" || target.length === 0) {
      return c.json({ error: "bad_request", message: "target is required" }, 400);
    }
    if ((typeof interval === "string" && interval.length > 0) === (typeof cron === "string" && cron.length > 0)) {
      return c.json({ error: "bad_request", message: "Provide exactly one of interval or cron." }, 400);
    }
    if (timezone !== undefined && (typeof timezone !== "string" || timezone.length === 0)) {
      return c.json({ error: "bad_request", message: "timezone must be a non-empty string." }, 400);
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return c.json({ error: "bad_request", message: "enabled must be a boolean." }, 400);
    }
    if (misfireGraceMs !== undefined && (!Number.isFinite(misfireGraceMs) || misfireGraceMs < 0)) {
      return c.json({ error: "bad_request", message: "misfireGraceMs must be a non-negative finite number." }, 400);
    }
    try {
      if (interval) parseInterval(interval);
      if (cron) validateCron(cron, timezone ?? "UTC");
    } catch (err) {
      return c.json({
        error: "bad_request",
        message: `schedule invalid: ${err instanceof Error ? err.message : String(err)}`,
      }, 400);
    }
    if (overlapPolicy && !["allow","skip"].includes(overlapPolicy)) return c.json({error:"bad_request",message:"Invalid overlapPolicy."},400);
    if (misfirePolicy && !["skip","fire-once","catch-up"].includes(misfirePolicy)) return c.json({error:"bad_request",message:"Invalid misfirePolicy."},400);
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
      cron,
      timezone: cron ? timezone ?? "UTC" : undefined,
      overlapPolicy: overlapPolicy ?? "skip",
      misfirePolicy: misfirePolicy ?? "fire-once",
      misfireGraceMs: misfireGraceMs ?? 60_000,
      input,
      enabled: enabled ?? true,
      nextRunAt: nextScheduleOccurrence({ interval, cron, timezone }, now, parseInterval),
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
    if ("interval" in body && "cron" in body) {
      return c.json({ error: "bad_request", message: "Update only one of interval or cron at a time." }, 400);
    }
    if ("interval" in body) {
      if (typeof body.interval !== "string" || body.interval.length === 0) {
        return c.json({ error: "bad_request", message: "interval must be a non-empty string." }, 400);
      }
      try {
        parseInterval(body.interval);
      } catch (err) {
        return c.json({
          error: "bad_request",
          message: `interval invalid: ${err instanceof Error ? err.message : String(err)}`,
        }, 400);
      }
      patch.interval = body.interval;
      patch.cron = undefined;
      patch.timezone = undefined;
    }
    if ("cron" in body) {
      if (typeof body.cron !== "string" || body.cron.length === 0) {
        return c.json({ error: "bad_request", message: "cron must be a non-empty string." }, 400);
      }
      if ("timezone" in body && (typeof body.timezone !== "string" || body.timezone.length === 0)) {
        return c.json({ error: "bad_request", message: "timezone must be a non-empty string." }, 400);
      }
      try {
        validateCron(body.cron, body.timezone ?? existing.timezone ?? "UTC");
      } catch (err) {
        return c.json({error:"bad_request",message:`cron invalid: ${err instanceof Error ? err.message : String(err)}`},400);
      }
      patch.cron = body.cron;
      patch.interval = undefined;
      patch.timezone = body.timezone ?? existing.timezone ?? "UTC";
    } else if ("timezone" in body) {
      if (!existing.cron) {
        return c.json({ error: "bad_request", message: "timezone is only valid for cron schedules." }, 400);
      }
      if (typeof body.timezone !== "string" || body.timezone.length === 0) {
        return c.json({ error: "bad_request", message: "timezone must be a non-empty string." }, 400);
      }
      try {
        validateCron(existing.cron, body.timezone);
      } catch (err) {
        return c.json({error:"bad_request",message:`timezone invalid: ${err instanceof Error ? err.message : String(err)}`},400);
      }
      patch.timezone = body.timezone;
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
    if ("enabled" in body) {
      if (typeof body.enabled !== "boolean") return c.json({error:"bad_request",message:"enabled must be a boolean."},400);
      patch.enabled = body.enabled;
    }
    if ("overlapPolicy" in body) {
      if (!["allow","skip"].includes(body.overlapPolicy)) return c.json({error:"bad_request",message:"Invalid overlapPolicy."},400);
      patch.overlapPolicy = body.overlapPolicy;
    }
    if ("misfirePolicy" in body) {
      if (!["skip","fire-once","catch-up"].includes(body.misfirePolicy)) return c.json({error:"bad_request",message:"Invalid misfirePolicy."},400);
      patch.misfirePolicy = body.misfirePolicy;
    }
    if ("misfireGraceMs" in body) {
      if (typeof body.misfireGraceMs !== "number" || !Number.isFinite(body.misfireGraceMs) || body.misfireGraceMs < 0) {
        return c.json({error:"bad_request",message:"misfireGraceMs must be a non-negative finite number."},400);
      }
      patch.misfireGraceMs = body.misfireGraceMs;
    }
    if ("nextRunAt" in body) {
      const parsed = new Date(body.nextRunAt);
      if (Number.isNaN(parsed.getTime())) {
        return c.json({ error: "bad_request", message: "nextRunAt must be a valid date" }, 400);
      }
      patch.nextRunAt = parsed;
    } else if ("interval" in body || "cron" in body || "timezone" in body) {
      patch.nextRunAt = nextScheduleOccurrence({
        interval: ("interval" in patch ? patch.interval : existing.interval) as string | undefined,
        cron: ("cron" in patch ? patch.cron : existing.cron) as string | undefined,
        timezone: ("timezone" in patch ? patch.timezone : existing.timezone) as string | undefined,
      }, new Date(), parseInterval);
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
