import { Hono } from "hono";
import type { KeyStore } from "../../auth/keys.js";

export interface V1KeyDeps {
  keyStore?: KeyStore;
}

export function v1KeyRoutes(deps: V1KeyDeps) {
  const app = new Hono();

  app.post("/keys", async (c) => {
    if (!deps.keyStore) {
      return c.json({ error: "unavailable", message: "Auth not configured." }, 503);
    }

    const body = await c.req.json().catch(() => ({}));
    const name = body.name || "Unnamed key";
    const scopes = Array.isArray(body.scopes) ? body.scopes : ["trigger", "read"];

    const { key, record } = deps.keyStore.create(name, scopes);
    return c.json(
      {
        data: {
          id: record.id,
          name: record.name,
          key, // Only returned at creation time
          keyPrefix: record.keyPrefix,
          scopes: record.scopes,
          createdAt: record.createdAt,
        },
      },
      201,
    );
  });

  app.get("/keys", async (c) => {
    if (!deps.keyStore) {
      return c.json({ error: "unavailable", message: "Auth not configured." }, 503);
    }
    const keys = deps.keyStore.list();
    return c.json({ data: keys });
  });

  app.delete("/keys/:id", async (c) => {
    if (!deps.keyStore) {
      return c.json({ error: "unavailable", message: "Auth not configured." }, 503);
    }
    const id = c.req.param("id");
    const success = deps.keyStore.revoke(id);
    if (!success) {
      return c.json({ error: "not_found", message: "Key not found." }, 404);
    }
    return c.json({ data: { revoked: true } });
  });

  return app;
}
