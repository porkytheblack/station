import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { SignalRunner, MemoryAdapter } from "station-signal";
import { BroadcastRunner, BroadcastMemoryAdapter } from "station-broadcast";
import type { SignalQueueAdapter } from "station-signal";
import type { BroadcastQueueAdapter } from "station-broadcast";
import type { StationConfig } from "../config/schema.js";
import { WebSocketHub } from "./ws.js";
import { SSEHub } from "./sse.js";
import { LogBuffer } from "./log-buffer.js";
import { LogStore } from "./log-store.js";
import { StationSignalSubscriber, StationBroadcastSubscriber } from "./subscriber.js";
import { healthRoutes } from "./routes/health.js";
import { signalRoutes } from "./routes/signals.js";
import { runRoutes } from "./routes/runs.js";
import { broadcastRoutes } from "./routes/broadcasts.js";
import { KeyStore } from "./auth/keys.js";
import { verifySessionToken, verifyCredentials, createSessionToken, type SessionConfig } from "./auth/session.js";
import { authResolver } from "./middleware/auth.js";
import { requireScope } from "./middleware/scope-guard.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { v1HealthRoutes } from "./routes/v1/health.js";
import { v1SignalRoutes } from "./routes/v1/signals.js";
import { v1RunRoutes } from "./routes/v1/runs.js";
import { v1BroadcastRoutes } from "./routes/v1/broadcasts.js";
import { v1TriggerRoutes } from "./routes/v1/trigger.js";
import { v1KeyRoutes } from "./routes/v1/keys.js";
import { v1AuthRoutes } from "./routes/v1/auth.js";
import { v1EventRoutes } from "./routes/v1/events.js";

export interface StationInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createStation(config: StationConfig, cwd: string, nextPort?: number): Promise<StationInstance> {
  const signalAdapter: SignalQueueAdapter = config.adapter ?? new MemoryAdapter();
  const broadcastAdapter: BroadcastQueueAdapter | undefined =
    config.broadcastAdapter ?? (config.broadcastsDir ? new BroadcastMemoryAdapter() : undefined);

  const wsHub = new WebSocketHub();
  const sseHub = new SSEHub();
  const logBuffer = new LogBuffer();
  const logStore = new LogStore(resolve(cwd, "station-logs.db"));

  // Auth: create KeyStore and SessionConfig if auth is configured
  let keyStore: KeyStore | undefined;
  let sessionConfig: SessionConfig | undefined;

  if (config.auth) {
    keyStore = new KeyStore(resolve(cwd, "station-keys.db"));
    sessionConfig = {
      username: config.auth.username,
      password: config.auth.password,
      sessionTtlMs: config.auth.sessionTtlMs,
    };
  }

  // Resolve directories
  const signalsDir = config.signalsDir
    ? resolve(cwd, config.signalsDir)
    : existsSync(resolve(cwd, "signals"))
      ? resolve(cwd, "signals")
      : undefined;

  const broadcastsDir = config.broadcastsDir
    ? resolve(cwd, config.broadcastsDir)
    : existsSync(resolve(cwd, "broadcasts"))
      ? resolve(cwd, "broadcasts")
      : undefined;

  // Create subscribers (always — they collect metadata)
  const stationSignalSub = new StationSignalSubscriber(wsHub, logBuffer, logStore);
  const stationBroadcastSub = new StationBroadcastSubscriber(wsHub);

  // Wire SSE hub into subscribers so events reach both WS and SSE clients
  stationSignalSub.setSSEHub(sseHub);
  stationBroadcastSub.setSSEHub(sseHub);

  // Create runners if enabled
  let signalRunner: SignalRunner | undefined;
  let broadcastRunner: BroadcastRunner | undefined;

  if (config.runRunners) {
    signalRunner = new SignalRunner({
      signalsDir,
      adapter: signalAdapter,
      pollIntervalMs: config.runner.pollIntervalMs,
      maxConcurrent: config.runner.maxConcurrent,
      maxAttempts: config.runner.maxAttempts,
      retryBackoffMs: config.runner.retryBackoffMs,
      subscribers: [stationSignalSub],
    });

    if (broadcastsDir || broadcastAdapter) {
      broadcastRunner = new BroadcastRunner({
        signalRunner,
        broadcastsDir,
        adapter: broadcastAdapter ?? new BroadcastMemoryAdapter(),
        pollIntervalMs: config.broadcastRunner.pollIntervalMs,
        subscribers: [stationBroadcastSub],
      });
    }
  }

  // Build Hono app
  const app = new Hono();

  // ── Dashboard auth routes (always accessible) ──────────────────────
  app.get("/api/auth/check", async (c) => {
    if (!sessionConfig) {
      return c.json({ data: { authenticated: true, authRequired: false } });
    }
    const cookie = c.req.header("cookie");
    if (cookie) {
      const match = cookie.match(/station_session=([^;]+)/);
      if (match && verifySessionToken(match[1], sessionConfig)) {
        return c.json({ data: { authenticated: true, authRequired: true } });
      }
    }
    return c.json({ data: { authenticated: false, authRequired: true } });
  });

  app.post("/api/auth/login", async (c) => {
    if (!sessionConfig) {
      return c.json({ data: { ok: true } });
    }
    const body = await c.req.json().catch(() => ({}));
    const { username, password } = body;
    if (!username || !password) {
      return c.json({ error: "bad_request", message: "Missing username or password." }, 400);
    }
    if (!verifyCredentials(username, password, sessionConfig)) {
      return c.json({ error: "unauthorized", message: "Invalid credentials." }, 401);
    }
    const token = createSessionToken(sessionConfig);
    const ttlSeconds = Math.floor((sessionConfig.sessionTtlMs ?? 86_400_000) / 1000);
    c.header("Set-Cookie", `station_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlSeconds}`);
    return c.json({ data: { ok: true } });
  });

  app.post("/api/auth/logout", async (c) => {
    c.header("Set-Cookie", "station_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return c.json({ data: { ok: true } });
  });

  // ── Dashboard API routes (session required when auth configured) ───
  if (sessionConfig) {
    app.use("/api/*", createMiddleware(async (c, next) => {
      // Skip auth check for /api/auth/* (already handled above)
      if (c.req.path.startsWith("/api/auth/")) return next();
      // Skip auth check for /api/v1/* (has its own auth)
      if (c.req.path.startsWith("/api/v1/")) return next();

      const cookie = c.req.header("cookie");
      if (cookie) {
        const match = cookie.match(/station_session=([^;]+)/);
        if (match && verifySessionToken(match[1], sessionConfig)) {
          return next();
        }
      }
      return c.json({ error: "unauthorized", message: "Session required." }, 401);
    }));
  }

  app.route("/api", healthRoutes({ signalAdapter, broadcastAdapter }));
  app.route("/api", signalRoutes({ signalRunner, signalAdapter, signalSubscriber: stationSignalSub }));
  app.route("/api", runRoutes({ signalRunner, signalAdapter, logBuffer, logStore }));
  app.route("/api", broadcastRoutes({ broadcastRunner, broadcastAdapter, broadcastSubscriber: stationBroadcastSub, logBuffer, logStore }));

  // ── v1 API routes (authenticated) ──────────────────────────────────

  // Public v1 routes (no auth required)
  app.route("/api/v1", v1HealthRoutes({ signalAdapter, broadcastAdapter }));

  // Auth routes: public but rate-limited to prevent brute force
  const authApp = new Hono();
  authApp.use("/*", rateLimiter({ windowMs: 60_000, max: 10 }));
  authApp.route("/", v1AuthRoutes({ sessionConfig }));
  app.route("/api/v1", authApp);

  // Authenticated v1 routes — apply auth resolver middleware
  const v1 = new Hono();
  v1.use("/*", authResolver({ keyStore, sessionConfig }));

  // Read-scope routes
  const readRoutes = new Hono();
  readRoutes.use("/*", requireScope("read"));
  readRoutes.route("/", v1SignalRoutes({ signalRunner, signalSubscriber: stationSignalSub }));
  readRoutes.route("/", v1RunRoutes({ signalRunner, signalAdapter, logBuffer, logStore }));
  readRoutes.route("/", v1BroadcastRoutes({ broadcastRunner, broadcastAdapter, broadcastSubscriber: stationBroadcastSub }));
  readRoutes.route("/", v1EventRoutes({ sseHub }));
  v1.route("/", readRoutes);

  // Trigger-scope routes
  const triggerRoutes = new Hono();
  triggerRoutes.use("/*", requireScope("trigger"));
  triggerRoutes.route("/", v1TriggerRoutes({ signalRunner, signalAdapter, broadcastRunner, signalSubscriber: stationSignalSub }));
  v1.route("/", triggerRoutes);

  // Cancel-scope routes — only the cancel endpoints
  const cancelRoutes = new Hono();
  cancelRoutes.use("/*", requireScope("cancel"));
  cancelRoutes.post("/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!signalRunner) {
      return c.json({ error: "unavailable", message: "Station is in read-only mode." }, 503);
    }
    const success = await signalRunner.cancel(id);
    if (!success) {
      return c.json({ error: "cannot_cancel", message: "Run cannot be cancelled." }, 400);
    }
    return c.json({ data: { cancelled: true } });
  });
  cancelRoutes.post("/broadcast-runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!broadcastRunner) {
      return c.json({ error: "unavailable", message: "Station is in read-only mode." }, 503);
    }
    const success = await broadcastRunner.cancel(id);
    if (!success) {
      return c.json({ error: "cannot_cancel", message: "Broadcast run cannot be cancelled." }, 400);
    }
    return c.json({ data: { cancelled: true } });
  });
  v1.route("/", cancelRoutes);

  // Admin-scope routes
  const adminRoutes = new Hono();
  adminRoutes.use("/*", requireScope("admin"));
  adminRoutes.route("/", v1KeyRoutes({ keyStore }));
  v1.route("/", adminRoutes);

  app.route("/api/v1", v1);

  // ── Proxy to Next.js standalone server ──────────────────────────
  if (nextPort) {
    app.all("*", async (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "not_found", message: "API route not found." }, 404);
      }

      const url = new URL(c.req.url);
      const target = `http://127.0.0.1:${nextPort}${url.pathname}${url.search}`;

      try {
        // Clone headers and strip accept-encoding so the upstream responds uncompressed.
        // Node's fetch may decompress but keep the Content-Encoding header, which
        // causes the browser to double-decompress and garble RSC payloads.
        const fwdHeaders = new Headers(c.req.raw.headers);
        fwdHeaders.delete("accept-encoding");

        const proxyRes = await fetch(target, {
          method: c.req.method,
          headers: fwdHeaders,
          body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
          duplex: "half",
          redirect: "manual",
        });

        // Strip hop-by-hop / encoding headers to be safe
        const resHeaders = new Headers(proxyRes.headers);
        resHeaders.delete("content-encoding");
        resHeaders.delete("transfer-encoding");
        resHeaders.delete("content-length");

        return new Response(proxyRes.body, {
          status: proxyRes.status,
          headers: resHeaders,
        });
      } catch {
        return c.text("Dashboard unavailable.", 502);
      }
    });
  } else {
    app.all("*", (c) => {
      if (c.req.path.startsWith("/api/")) {
        return c.json({ error: "not_found", message: "API route not found." }, 404);
      }
      return c.text("Dashboard not built. Run 'pnpm build' in station-kit.", 404);
    });
  }

  let httpServer: Server | null = null;

  return {
    async start() {
      // Start runners (non-blocking — they have internal poll loops)
      if (config.runRunners) {
        if (signalRunner) {
          signalRunner.start().catch((err: unknown) => {
            console.error("[station] Signal runner error:", err);
          });
        }
        if (broadcastRunner) {
          broadcastRunner.start().catch((err: unknown) => {
            console.error("[station] Broadcast runner error:", err);
          });
        }
      }

      // Start Hono server
      httpServer = serve(
        { fetch: app.fetch, port: config.port, hostname: config.host },
        (info) => {
          console.log(`[station] Running on http://${config.host}:${info.port}`);
        },
      ) as unknown as Server;

      // Attach WebSocket to the HTTP server
      wsHub.attach(httpServer);
    },

    async stop() {
      // Stop broadcast runner first — it queries the DB during graceful shutdown
      if (broadcastRunner) {
        await broadcastRunner.stop({ graceful: true, timeoutMs: 5000 });
      }
      if (signalRunner) {
        await signalRunner.stop({ graceful: true, timeoutMs: 5000 });
      }
      wsHub.close();
      sseHub.close();
      logStore.close();
      keyStore?.close();
      if (httpServer) {
        httpServer.close();
      }
    },
  };
}
