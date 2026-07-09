import { Hono } from "hono";
import type { Context } from "hono";
import {
  EnvStore,
  EnvValidationError,
  toPublic,
  type EnvTarget,
  type EnvVarPublic,
} from "station-env";

export interface V1EnvDeps {
  envStore?: EnvStore;
}

/**
 * Parse the request body and return it only if it's a JSON object. Returns
 * null for a parse error or a non-object body (e.g. `null`, a string, a
 * number) so callers can respond 400 instead of throwing a 500 on
 * `"key" in body`.
 */
async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  const raw = await c.req.json().catch(() => undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** Read-scope routes: list / get. Secret values are redacted. */
export function v1EnvReadRoutes(deps: V1EnvDeps) {
  const app = new Hono();

  app.get("/env", async (c) => {
    if (!deps.envStore) return c.json({ data: [] });
    const list = await deps.envStore.listPublic();
    return c.json({ data: list.map(serialize) });
  });

  app.get("/env/:id", async (c) => {
    if (!deps.envStore) return c.json({ error: "unavailable" }, 503);
    const v = await deps.envStore.getPublic(c.req.param("id"));
    if (!v) return c.json({ error: "not_found" }, 404);
    return c.json({ data: serialize(v) });
  });

  return app;
}

/** Admin-scope routes: create / update / delete. */
export function v1EnvRoutes(deps: V1EnvDeps) {
  const app = new Hono();

  app.post("/env", async (c) => {
    if (!deps.envStore) return c.json({ error: "unavailable" }, 503);
    const body = await readJsonObject(c);
    if (!body) return c.json({ error: "bad_request", message: "body must be a JSON object" }, 400);
    const { key, value, secret, targets } = body as {
      key?: unknown;
      value?: unknown;
      secret?: unknown;
      targets?: unknown;
    };
    if (typeof key !== "string") {
      return c.json({ error: "bad_request", message: "key is required" }, 400);
    }
    if (typeof value !== "string") {
      return c.json({ error: "bad_request", message: "value is required" }, 400);
    }
    const apiKeyId = c.get("apiKeyId" as never) as string | undefined;
    try {
      const created = await deps.envStore.create({
        key,
        value,
        secret: secret === true,
        targets: normalizeTargets(targets),
        createdBy: apiKeyId,
      });
      // Echo back the redacted view — a secret value is never returned, even
      // to its creator, to keep the "write-only" contract uniform.
      return c.json({ data: serialize(toPublic(created)) }, 201);
    } catch (err) {
      if (err instanceof EnvValidationError) {
        return c.json({ error: "bad_request", message: err.message }, 400);
      }
      throw err;
    }
  });

  app.patch("/env/:id", async (c) => {
    if (!deps.envStore) return c.json({ error: "unavailable" }, 503);
    const id = c.req.param("id");
    const existing = await deps.envStore.get(id);
    if (!existing) return c.json({ error: "not_found" }, 404);

    const body = await readJsonObject(c);
    if (!body) return c.json({ error: "bad_request", message: "body must be a JSON object" }, 400);
    const patch: { value?: string; secret?: boolean; targets?: EnvTarget[] } = {};
    if ("value" in body) {
      if (typeof body.value !== "string") {
        return c.json({ error: "bad_request", message: "value must be a string" }, 400);
      }
      patch.value = body.value;
    }
    if ("secret" in body) patch.secret = body.secret === true;
    if ("targets" in body) patch.targets = normalizeTargets(body.targets);

    try {
      const updated = await deps.envStore.update(id, patch);
      if (!updated) return c.json({ error: "not_found" }, 404);
      return c.json({ data: serialize(toPublic(updated)) });
    } catch (err) {
      if (err instanceof EnvValidationError) {
        return c.json({ error: "bad_request", message: err.message }, 400);
      }
      throw err;
    }
  });

  app.delete("/env/:id", async (c) => {
    if (!deps.envStore) return c.json({ error: "unavailable" }, 503);
    const ok = await deps.envStore.delete(c.req.param("id"));
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ data: { deleted: true } });
  });

  return app;
}

function normalizeTargets(raw: unknown): EnvTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: EnvTarget[] = [];
  for (const t of raw) {
    if (t && typeof t === "object" && "kind" in t && "name" in t) {
      out.push({ kind: (t as EnvTarget).kind, name: (t as EnvTarget).name });
    }
  }
  return out;
}

function serialize(v: EnvVarPublic): Record<string, unknown> {
  return {
    ...v,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}
