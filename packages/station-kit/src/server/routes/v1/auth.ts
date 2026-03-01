import { Hono } from "hono";
import { verifyCredentials, createSessionToken, type SessionConfig } from "../../auth/session.js";

export interface V1AuthRouteDeps {
  sessionConfig?: SessionConfig;
}

export function v1AuthRoutes(deps: V1AuthRouteDeps) {
  const app = new Hono();

  app.post("/auth/login", async (c) => {
    if (!deps.sessionConfig) {
      return c.json({ error: "unavailable", message: "Auth not configured." }, 503);
    }

    const body = await c.req.json().catch(() => ({}));
    const { username, password } = body;

    if (!username || !password) {
      return c.json({ error: "bad_request", message: "Missing username or password." }, 400);
    }

    if (!verifyCredentials(username, password, deps.sessionConfig)) {
      return c.json({ error: "unauthorized", message: "Invalid credentials." }, 401);
    }

    const token = createSessionToken(deps.sessionConfig);
    const ttlSeconds = Math.floor(
      (deps.sessionConfig.sessionTtlMs ?? 86_400_000) / 1000,
    );
    c.header(
      "Set-Cookie",
      `station_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`,
    );
    return c.json({ data: { ok: true } });
  });

  app.post("/auth/logout", async (c) => {
    c.header(
      "Set-Cookie",
      "station_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    return c.json({ data: { ok: true } });
  });

  return app;
}
