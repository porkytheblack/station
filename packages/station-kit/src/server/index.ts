import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { SignalRunner, MemoryAdapter, parseInterval } from "station-signal";
import { BroadcastRunner, BroadcastMemoryAdapter } from "station-broadcast";
import { BeaconRunner, BeaconMemoryAdapter } from "station-beacon";
import type { SignalQueueAdapter } from "station-signal";
import type { BroadcastQueueAdapter } from "station-broadcast";
import type { BeaconStateAdapter } from "station-beacon";
import {
  ScheduleReconciler,
  type Schedule,
  type ScheduleAdapter,
} from "station-schedules";
import { EnvStore, FileEnvStorage } from "station-env";
import type { StationConfig } from "../config/schema.js";
import { ensureStationDir } from "../station-dir.js";
import { WebSocketHub } from "./ws.js";
import { SSEHub } from "./sse.js";
import { LogBuffer } from "./log-buffer.js";
import { LogStore, FileLogStorage } from "./log-store.js";
import { StationSignalSubscriber, StationBroadcastSubscriber, StationBeaconSubscriber } from "./subscriber.js";
import { healthRoutes } from "./routes/health.js";
import { signalRoutes } from "./routes/signals.js";
import { runRoutes } from "./routes/runs.js";
import { broadcastRoutes } from "./routes/broadcasts.js";
import { beaconRoutes } from "./routes/beacons.js";
import { KeyStore, FileKeyStorage } from "./auth/keys.js";
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
import { v1DefinitionRoutes, v1DefinitionReadRoutes } from "./routes/v1/definitions.js";
import { v1ScheduleRoutes, v1ScheduleReadRoutes } from "./routes/v1/schedules.js";
import { v1EnvRoutes, v1EnvReadRoutes } from "./routes/v1/env.js";
import { v1ExpressionRoutes } from "./routes/v1/expressions.js";

export {
  KeyStore,
  FileKeyStorage,
  SqliteKeyStorage,
  MemoryKeyStorage,
} from "./auth/keys.js";
export type {
  ApiKey,
  ApiKeyPublic,
  ApiKeyStorageAdapter,
  FileKeyStorageOptions,
  SqliteKeyStorageOptions,
} from "./auth/keys.js";
export {
  LogStore,
  FileLogStorage,
  MemoryLogStorage,
} from "./log-store.js";
export type {
  LogStorageAdapter,
  FileLogStorageOptions,
} from "./log-store.js";
export type { LogEntry } from "./log-buffer.js";

export interface StationInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The KeyStore instance (available when auth is configured). */
  keyStore?: KeyStore;
  /** The resolved data directory path. */
  dataDir: string;
}

export async function createStation(config: StationConfig, cwd: string, nextPort?: number): Promise<StationInstance> {
  const signalAdapter: SignalQueueAdapter = config.adapter ?? new MemoryAdapter();
  const broadcastAdapter: BroadcastQueueAdapter | undefined =
    config.broadcastAdapter ?? (config.broadcastsDir ? new BroadcastMemoryAdapter() : undefined);
  const beaconAdapter: BeaconStateAdapter | undefined =
    config.beaconAdapter ?? (config.beaconsDir ? new BeaconMemoryAdapter() : undefined);

  const { dataDir } = ensureStationDir(cwd, config.stationDir);

  warnIfLegacySqliteFiles(dataDir);

  const wsHub = new WebSocketHub();
  const sseHub = new SSEHub();
  const logBuffer = new LogBuffer();
  const logStore = new LogStore(
    config.logStorage ?? new FileLogStorage({
      filePath: resolve(dataDir, "station-logs.jsonl"),
      onError: (err) => console.error("[station] log write failed:", err),
    }),
  );

  // Runtime env store: defaults to a JSON file so `.env()` requirements and
  // dashboard-defined variables work out of the box. Pass a durable adapter
  // via `envStorage` for multi-process deployments.
  const envStore = new EnvStore(
    config.envStorage ?? new FileEnvStorage({ filePath: resolve(dataDir, "station-env.json") }),
  );

  // Auth: create KeyStore and SessionConfig if auth is configured
  let keyStore: KeyStore | undefined;
  let sessionConfig: SessionConfig | undefined;

  if (config.auth) {
    const storage = config.auth.keyStorage
      ?? new FileKeyStorage({ filePath: resolve(dataDir, "station-keys.json") });
    keyStore = new KeyStore(storage, { pepper: resolveKeyPepper(dataDir) });
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

  const beaconsDir = config.beaconsDir
    ? resolve(cwd, config.beaconsDir)
    : existsSync(resolve(cwd, "beacons"))
      ? resolve(cwd, "beacons")
      : undefined;

  // Create subscribers (always — they collect metadata)
  const stationSignalSub = new StationSignalSubscriber(wsHub, logBuffer, logStore);
  const stationBroadcastSub = new StationBroadcastSubscriber(wsHub);
  const stationBeaconSub = new StationBeaconSubscriber(wsHub, logBuffer, logStore);

  // Wire SSE hub into subscribers so events reach both WS and SSE clients
  stationSignalSub.setSSEHub(sseHub);
  stationBroadcastSub.setSSEHub(sseHub);
  stationBeaconSub.setSSEHub(sseHub);

  // Create runners if enabled
  let signalRunner: SignalRunner | undefined;
  let broadcastRunner: BroadcastRunner | undefined;
  let beaconRunner: BeaconRunner | undefined;
  const scheduleAdapter: ScheduleAdapter | undefined = config.scheduleAdapter;

  if (config.runRunners) {
    // Build schedule reconcilers up front. Each reconciler handles only the
    // kinds it's responsible for; the runner ticks it once per loop.
    const signalScheduleReconciler = scheduleAdapter
      ? new ScheduleReconciler({
          adapter: scheduleAdapter,
          kinds: ["signal"],
          parseInterval,
          triggerFn: (s: Schedule) => signalRunner!.triggerSignal(s.target, s.input ?? {}),
          hasPendingOrRunning: (s: Schedule) =>
            signalRunner!.hasPendingOrRunningForSignal(s.target),
          onError: (err) => console.error("[station] Signal schedule reconciler:", err),
        })
      : undefined;

    signalRunner = new SignalRunner({
      signalsDir,
      adapter: signalAdapter,
      pollIntervalMs: config.runner.pollIntervalMs,
      maxConcurrent: config.runner.maxConcurrent,
      maxAttempts: config.runner.maxAttempts,
      retryBackoffMs: config.runner.retryBackoffMs,
      subscribers: [stationSignalSub],
      scheduleReconciler: signalScheduleReconciler,
      envProvider: envStore,
    });

    if (broadcastsDir || broadcastAdapter) {
      const broadcastScheduleReconciler = scheduleAdapter
        ? new ScheduleReconciler({
            adapter: scheduleAdapter,
            kinds: ["broadcast-static", "broadcast-dynamic"],
            parseInterval,
            triggerFn: (s: Schedule) => broadcastRunner!.trigger(s.target, s.input ?? {}),
            hasPendingOrRunning: (s: Schedule) =>
              broadcastRunner!.hasPendingOrRunningForBroadcast(s.target),
            onError: (err) => console.error("[station] Broadcast schedule reconciler:", err),
          })
        : undefined;

      broadcastRunner = new BroadcastRunner({
        signalRunner,
        broadcastsDir,
        adapter: broadcastAdapter ?? new BroadcastMemoryAdapter(),
        pollIntervalMs: config.broadcastRunner.pollIntervalMs,
        subscribers: [stationBroadcastSub],
        scheduleReconciler: broadcastScheduleReconciler,
      });
    }

    if (beaconsDir || beaconAdapter) {
      beaconRunner = new BeaconRunner({
        beaconsDir,
        adapter: beaconAdapter ?? new BeaconMemoryAdapter(),
        signalRunner, // beacons can trigger signals into the shared queue
        subscribers: [stationBeaconSub],
        envProvider: envStore,
      });
    }
  }

  // Build Hono app
  const app = new Hono();

  // Bound request bodies so oversized payloads can't be parsed/stored.
  app.use("/api/*", bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (c) => c.json({ error: "payload_too_large", message: "Request body too large." }, 413),
  }));

  // Brute-force protection for the dashboard login (the v1 login is limited below).
  app.use("/api/auth/login", rateLimiter({ windowMs: 60_000, max: 10 }));

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
  app.route("/api", runRoutes({ signalRunner, signalAdapter, logBuffer, logStore, signalSubscriber: stationSignalSub }));
  app.route("/api", broadcastRoutes({ broadcastRunner, broadcastAdapter, broadcastSubscriber: stationBroadcastSub, logBuffer, logStore }));
  app.route("/api", beaconRoutes({ beaconRunner, beaconAdapter, logBuffer, logStore }));

  // ── v1 API routes (authenticated) ──────────────────────────────────

  // Public v1 routes (no auth required)
  app.route("/api/v1", v1HealthRoutes({ signalAdapter, broadcastAdapter }));

  // Auth routes: public but rate-limited to prevent brute force. The limiter
  // is scoped to /auth/* — a "/*" limiter here would run for every /api/v1
  // route mounted after this app and throttle the whole API to 10 req/min.
  const authApp = new Hono();
  authApp.use("/auth/*", rateLimiter({ windowMs: 60_000, max: 10 }));
  authApp.route("/", v1AuthRoutes({ sessionConfig }));
  app.route("/api/v1", authApp);

  // Authenticated v1 routes — apply auth resolver middleware
  const v1 = new Hono();
  v1.use("/*", authResolver({ keyStore, sessionConfig }));

  // Hono runs a sub-app's `use("/*")` middleware for routes that sibling
  // sub-apps mount LATER under the same prefix, so per-group scope guards
  // stack instead of isolating (a trigger-only key would be rejected by the
  // read group's guard before reaching /trigger). Attach the guard to each
  // route individually instead.
  const guarded = (scope: string, group: Hono): Hono => {
    const out = new Hono();
    const guard = requireScope(scope);
    for (const r of group.routes) {
      out.on(r.method, r.path, guard, r.handler);
    }
    return out;
  };

  // Read-scope routes
  const readRoutes = new Hono();
  readRoutes.route("/", v1SignalRoutes({ signalRunner, signalSubscriber: stationSignalSub }));
  readRoutes.route("/", v1RunRoutes({ signalRunner, signalAdapter, logBuffer, logStore }));
  readRoutes.route("/", v1BroadcastRoutes({ broadcastRunner, broadcastAdapter, broadcastSubscriber: stationBroadcastSub }));
  readRoutes.route("/", v1EventRoutes({ sseHub }));
  readRoutes.route("/", v1ExpressionRoutes());
  // Schedule GET + preview are read-scoped; mutating routes are mounted under admin below.
  readRoutes.route("/", v1ScheduleReadRoutes({ scheduleAdapter }));
  // Env GET is read-scoped (secret values redacted); mutations are admin-only below.
  readRoutes.route("/", v1EnvReadRoutes({ envStore }));
  readRoutes.route("/", v1DefinitionReadRoutes({
    broadcastRunner,
    broadcastAdapter,
    signalRunner,
    signalSubscriber: stationSignalSub,
  }));
  v1.route("/", guarded("read", readRoutes));

  // Trigger-scope routes
  v1.route("/", guarded("trigger", v1TriggerRoutes({ signalRunner, signalAdapter, broadcastRunner, broadcastAdapter, signalSubscriber: stationSignalSub })));

  // Cancel-scope routes — only the cancel endpoints
  const cancelRoutes = new Hono();
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
  v1.route("/", guarded("cancel", cancelRoutes));

  // Admin-scope routes — destructive / mutating endpoints
  const adminRoutes = new Hono();
  adminRoutes.route("/", v1KeyRoutes({ keyStore }));
  adminRoutes.route("/", v1DefinitionRoutes({
    broadcastRunner,
    broadcastAdapter,
    signalRunner,
    signalSubscriber: stationSignalSub,
  }));
  adminRoutes.route("/", v1ScheduleRoutes({ scheduleAdapter }));
  adminRoutes.route("/", v1EnvRoutes({ envStore }));
  v1.route("/", guarded("admin", adminRoutes));

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
    keyStore,
    dataDir,
    async start() {
      if (!config.auth && !isLoopbackHost(config.host)) {
        console.warn(
          `[station] WARNING: no auth configured while binding to ${config.host} — ` +
          "anyone who can reach this port can view logs and trigger, cancel, or rerun jobs. " +
          "Set auth (STATION_AUTH_USERNAME/STATION_AUTH_PASSWORD) or bind to 127.0.0.1.",
        );
      }

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
        if (beaconRunner) {
          beaconRunner.start().catch((err: unknown) => {
            console.error("[station] Beacon runner error:", err);
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

      // Attach WebSocket to the HTTP server. The upgrade path never passes
      // through Hono middleware, so it enforces auth itself: session cookie
      // or a read-scoped API key, mirroring the SSE endpoint.
      wsHub.attach(httpServer, async (req) => {
        if (!sessionConfig && !keyStore) return true;
        const cookie = req.headers.cookie;
        if (cookie && sessionConfig) {
          const match = cookie.match(/station_session=([^;]+)/);
          if (match && verifySessionToken(match[1], sessionConfig)) return true;
        }
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith("Bearer ") && keyStore) {
          const key = await keyStore.verify(authHeader.slice(7));
          if (key?.scopes.includes("read")) return true;
        }
        return false;
      });
    },

    async stop() {
      // Stop beacons first — they are producers that may trigger signals.
      if (beaconRunner) {
        await beaconRunner.stop({ graceful: true, timeoutMs: 5000 });
      }
      // Stop broadcast runner next — it queries the DB during graceful shutdown
      if (broadcastRunner) {
        await broadcastRunner.stop({ graceful: true, timeoutMs: 5000 });
      }
      if (signalRunner) {
        await signalRunner.stop({ graceful: true, timeoutMs: 5000 });
      }
      wsHub.close();
      sseHub.close();
      await logStore.close();
      await keyStore?.close();
      await envStore.close();
      if (httpServer) {
        httpServer.close();
      }
    },
  };
}

// Existing deployments that ran older Station versions persisted keys
// to `station-keys.db` (SQLite) and run logs to `station-logs.db`. The
// new defaults are `station-keys.json` and `station-logs.jsonl`; the
// legacy files are NOT auto-migrated. Emit a one-time warning so an
// upgrade doesn't silently appear to wipe a user's API keys.
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Resolve the API-key pepper (a server-side secret mixed into stored key
 * hashes). Priority: STATION_KEY_PEPPER env var, else a persisted per-install
 * secret at `<dataDir>/station-key-pepper` (generated with 0600 on first run).
 * Persisting it means existing peppered keys keep verifying across restarts.
 */
function resolveKeyPepper(dataDir: string): string {
  const fromEnv = process.env.STATION_KEY_PEPPER;
  if (fromEnv) return fromEnv;

  const pepperPath = resolve(dataDir, "station-key-pepper");
  try {
    if (existsSync(pepperPath)) {
      const existing = readFileSync(pepperPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // Unreadable — fall through and regenerate.
  }
  const pepper = randomBytes(32).toString("hex");
  try {
    writeFileSync(pepperPath, pepper, { mode: 0o600 });
  } catch (err) {
    // If we can't persist it, warn: keys created this run won't verify after
    // a restart (a new pepper would be generated). Better than failing boot.
    console.warn(`[station] Could not persist key pepper to ${pepperPath}:`, err);
  }
  return pepper;
}

function warnIfLegacySqliteFiles(dataDir: string): void {
  const legacy: { file: string; replacement: string }[] = [
    { file: "station-keys.db", replacement: "station-keys.json" },
    { file: "station-logs.db", replacement: "station-logs.jsonl" },
  ];
  for (const { file, replacement } of legacy) {
    const legacyPath = resolve(dataDir, file);
    if (!existsSync(legacyPath)) continue;
    const replacementPath = resolve(dataDir, replacement);
    if (existsSync(replacementPath)) continue;
    console.warn(
      `[station] Legacy ${file} detected at ${legacyPath} but no ${replacement} found. ` +
      `Station no longer reads SQLite-backed defaults; data in ${file} will not be loaded. ` +
      `If you need the contents, export them with the better-sqlite3 CLI before upgrading. ` +
      `To suppress this warning, delete or rename ${file}.`,
    );
  }
}
