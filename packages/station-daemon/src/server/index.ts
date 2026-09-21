import { ImageController } from "../images/controller.js";
import { registrySource } from "../registry/source.js";
import { FileImageRegistry, ImageRegistry, ImageUploadManager, FileImageUploadStorage } from "station-images";
import { imageRegistryRoutes } from "./routes/v1/registry.js";
import { imageUploadRoutes } from './routes/v1/registry-uploads.js';
import { registryProxyRoutes } from '../registry/proxy.js';
import { tenantImageRegistryRoutes } from './routes/v1/tenant-registry.js';
import { bindStationTenant } from "./tenant-binding.js";
import { EnrollmentAuthority } from '../enrollment/authority.js';
import { createEnrollmentAdmission } from '../enrollment/client.js';
import { v1EnrollmentAdminRoutes, v1EnrollmentWorkerRoutes } from './routes/v1/enrollment.js';
import { Hono } from "hono";
import { tenantExecutionRoutes, validateExecutionTenancy } from "./routes/tenant-execution.js";
import { executionCatalogRoutes, internalExecutionRoutes, publicExecutionRoutes } from "./routes/execution.js";
import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
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
import { StationNetworkMemoryAdapter, type StationNetworkAdapter, type StationNode } from "station-network";
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
import { verifySessionToken, verifyCredentials, createSessionToken, sessionCookie, type SessionConfig } from "./auth/session.js";
import { authResolver } from "./middleware/auth.js";
import { requireScope } from "./middleware/scope-guard.js";
import { rateLimiter, validateTrustedProxies } from "./middleware/rate-limit.js";
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
import {
  v1BeaconReadRoutes,
  v1BeaconProxyRoutes,
  v1BeaconStartRoutes,
  v1BeaconStopRoutes,
  v1BeaconAdminRoutes,
} from "./routes/v1/beacons.js";
import { v1StationReadRoutes, v1StationAdminRoutes } from "./routes/v1/stations.js";

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

export async function createStation(config: StationConfig, cwd: string): Promise<StationInstance> {
  // Verify retained ownership and backend readiness before advertising or serving requests.
  let dataDir: string;
  try {
    validateTrustedProxies(config.trustedProxies);
    if (config.auth?.secureCookies !== undefined && typeof config.auth.secureCookies !== 'boolean') throw new Error('auth.secureCookies must be boolean');
    validateExecutionTenancy(config);
    if (config.execution?.targets) config = { ...config, execution: { ...config.execution, targets: structuredClone(config.execution.targets) } };
    if (config.registry?.tenantId !== undefined) {
      const tenantId = config.registry.tenantId;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(tenantId) || config.role !== 'station' || !config.auth || config.registry.execution?.backend.kind !== 'docker' || config.registry.tenants) throw new Error('Tenant image workers require a dedicated authenticated Station with Docker image execution');
      if (config.execution && config.execution.tenantId !== tenantId) throw new Error('Registry and execution tenant ownership must agree');
    }
    ({ dataDir } = ensureStationDir(cwd, config.stationDir));
    bindStationTenant(dataDir, config.execution?.tenantId ?? config.registry?.tenantId);
    await config.execution?.sandbox?.ready?.();
    await config.execution?.browser?.adapter.ready?.();
    await config.execution?.sandbox?.bindTenant?.(config.execution.tenantId);
    await config.execution?.browser?.bindTenant(config.execution.tenantId);
  }
  catch (error) {
    await Promise.allSettled([config.execution?.sandbox?.close(), config.execution?.browser?.close()]);
    throw error;
  }
  const signalAdapter: SignalQueueAdapter = config.adapter ?? new MemoryAdapter();
  const networkAdapter: StationNetworkAdapter = config.network.adapter ?? new StationNetworkMemoryAdapter();
  const enrollment = config.network.enrollment;
  if (enrollment && (!config.auth || ('authority' in enrollment ? config.role !== 'headquarters' : config.role !== 'station'))) throw new Error('Enrollment requires an authenticated Headquarters authority or an authenticated member Station');
  const enrollmentAuthority = enrollment && 'authority' in enrollment
    ? new EnrollmentAuthority({ path: resolve(dataDir, 'network-enrollment.json'), networkId: config.network.id }) : undefined;
  const admission = enrollment && 'url' in enrollment
    ? createEnrollmentAdmission({ ...enrollment, networkId: config.network.id, stationId: config.network.stationId }) : undefined;
  const canClaim = async () => (!admission || await admission.canClaim()) && (await networkAdapter.getStation(config.network.stationId))?.status === 'online';
  const broadcastAdapter: BroadcastQueueAdapter | undefined =
    config.broadcastAdapter ?? ((config.broadcastsDir || config.registry?.execution) ? new BroadcastMemoryAdapter() : undefined);
  const beaconAdapter: BeaconStateAdapter | undefined =
    config.beaconAdapter ?? ((config.beaconsDir || config.registry?.execution) ? new BeaconMemoryAdapter() : undefined);


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
      secureCookies: config.auth.secureCookies,
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

  // User-supplied subscribers are appended after Station's own, so the
  // dashboard and event stream are updated before any custom side effect runs.
  // Runners already catch and log per-subscriber errors, so one of these
  // throwing can't break a run.
  const signalSubscribers = [stationSignalSub, ...(config.subscribers?.signal ?? [])];
  const broadcastSubscribers = [stationBroadcastSub, ...(config.subscribers?.broadcast ?? [])];
  const beaconSubscribers = [stationBeaconSub, ...(config.subscribers?.beacon ?? [])];

  // Without runners there is nothing to subscribe to, and silently dropping
  // them would look like the subscribers were simply never called.
  const configuredSubscriberCount =
    (config.subscribers?.signal?.length ?? 0) +
    (config.subscribers?.broadcast?.length ?? 0) +
    (config.subscribers?.beacon?.length ?? 0);
  if (configuredSubscriberCount > 0 && !config.runRunners && config.role !== "headquarters") {
    console.warn(
      `[station] ${configuredSubscriberCount} subscriber(s) configured but runRunners is false — ` +
        "this instance only serves the dashboard, so they will never fire.",
    );
  }

  // Headquarters runs control-plane reconciliation but never claims signal
  // jobs. Stations execute signals/beacons. Standalone does both.
  let signalRunner: SignalRunner | undefined;
  let broadcastRunner: BroadcastRunner | undefined;
  let beaconRunner: BeaconRunner | undefined;
  const scheduleAdapter: ScheduleAdapter | undefined = config.scheduleAdapter;
  let images: ImageController | undefined;

  const runsControlPlane = config.role === "headquarters" ||
    ((config.role === "standalone" || Boolean(config.registry?.tenantId)) && config.runRunners);
  const runsExecutionPlane = config.role !== "headquarters" && config.runRunners;

  if (runsControlPlane || runsExecutionPlane) {
    // Build schedule reconcilers up front. Each reconciler handles only the
    // kinds it's responsible for; the runner ticks it once per loop.
    const signalScheduleReconciler = scheduleAdapter && runsControlPlane
      ? new ScheduleReconciler({
          adapter: scheduleAdapter,
          kinds: ["signal"],
          parseInterval,
          triggerFn: (s: Schedule, scheduledFor: Date) =>
            signalRunner!.triggerSignal(s.target, s.input ?? {}, { id: s.id, scheduledFor }),
          hasPendingOrRunning: (s: Schedule) =>
            signalRunner!.hasPendingOrRunningForSignal(s.target),
          onError: (err) => console.error("[station] Signal schedule reconciler:", err),
        })
      : undefined;

    signalRunner = new SignalRunner({
      processRuntime: config.processRuntime,
      signalsDir,
      adapter: signalAdapter,
      pollIntervalMs: config.runner.pollIntervalMs,
      maxConcurrent: runsExecutionPlane ? config.runner.maxConcurrent : 0,
      maxAttempts: config.runner.maxAttempts,
      retryBackoffMs: config.runner.retryBackoffMs,
      subscribers: signalSubscribers,
      scheduleReconciler: signalScheduleReconciler,
      envProvider: { resolveFor: target => envStore.resolveFor({ ...target, kind: images?.targetKind(target.name) ?? target.kind }) },
      stationId: config.network.stationId,
      leaseDurationMs: config.network.leaseDurationMs,
      failUnknownSignals: config.role === "standalone",
      networkCoordinator: networkAdapter,
      networkId: config.network.id,
      stationLabels: config.network.labels,
      canClaim,
      canRenew: admission?.canRenew,
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
        canReconcile: admission ? canClaim : undefined,
        signalRunner,
        broadcastsDir,
        adapter: broadcastAdapter ?? new BroadcastMemoryAdapter(),
        pollIntervalMs: config.broadcastRunner.pollIntervalMs,
        subscribers: broadcastSubscribers,
        scheduleReconciler: broadcastScheduleReconciler,
      });
    }

    if (runsExecutionPlane && (beaconsDir || beaconAdapter)) {
      beaconRunner = new BeaconRunner({
        processRuntime: config.processRuntime,
        beaconsDir,
        adapter: beaconAdapter ?? new BeaconMemoryAdapter(),
        signalRunner, // beacons can trigger signals into the shared queue
        subscribers: beaconSubscribers,
        envProvider: { resolveFor: target => envStore.resolveFor({ ...target, kind: images?.targetKind(target.name) ?? target.kind }) },
        maxInstancesPerBeacon: config.beaconMaxInstances,
        networkCoordinator: networkAdapter,
        networkId: config.network.id,
        stationId: config.network.stationId,
        stationLabels: config.network.labels,
        leaseDurationMs: config.network.leaseDurationMs,
        canClaim,
        canRenew: admission?.canRenew,
      });
    }
  }

  // Build Hono app
  const app = new Hono();

  if (config.registry?.storage && config.registry.rootDir !== undefined) throw new Error("Registry storage and rootDir are alternatives; use cacheDir for a local execution cache");
  const imageRegistry = config.registry ? config.registry.storage
    ? new ImageRegistry({ ...config.registry, storage: config.registry.storage })
    : new FileImageRegistry(resolve(dataDir, config.registry.rootDir ?? "registry"), config.registry) : undefined;

  const imageSource = config.registry?.upstream ? registrySource(config.registry.upstream) : undefined;
  if (imageRegistry && config.registry?.execution && signalRunner) {
    if (config.execution?.tenantId && config.registry.execution.backend.kind === "trusted-local") throw new Error("Tenant image execution requires isolation");
    images = new ImageController({ registry: imageRegistry, deploymentStorage: config.registry.deploymentStorage, cacheDir: config.registry.cacheDir ? resolve(dataDir, config.registry.cacheDir) : undefined, source: imageSource, signalRunner, broadcastRunner, beaconRunner, stateDir: resolve(dataDir, "images"), stationId: config.role === "headquarters" ? undefined : config.network.stationId,
      beaconAdapter, maxBeaconInstances: config.beaconMaxInstances,
      rolloutCoordinator: networkAdapter,
      preparation: config.registry.upstream?.mode === 'on-demand' ? { adapter: networkAdapter, networkId: config.network.id, stationId: config.network.stationId } : undefined,
      canTarget: async (id, name) => { const node = await networkAdapter.getStation(id); return Boolean(node && node.networkId === config.network.id && node.role !== "headquarters" && node.status === "online" && node.leaseExpiresAt > new Date() && (node.definitions.signals.includes(name) || node.definitions.beacons.includes(name) || node.definitions.images?.installableSignals.includes(name))); },
      ...config.registry.execution });
  }

  // Bound request bodies so oversized payloads can't be parsed/stored.
  app.use("/api/*", async (c, next) => {
    if (config.registry?.targets && c.req.method === 'PUT' && /^\/api\/v1\/stations\/[^/]+\/registry\/blobs\/sha256(?::|%3A)[0-9a-f]{64}$/i.test(c.req.path)) return next();
    if (imageRegistry && c.req.method === "PUT" && /^\/api\/v1\/registry\/blobs\/sha256%3A[0-9a-f]{64}$/i.test(c.req.path)) return next();
    if (imageRegistry && c.req.method === "PUT" && /^\/api\/v1\/registry\/blobs\/sha256:[0-9a-f]{64}$/.test(c.req.path)) return next();
    return bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (c) => c.json({ error: "payload_too_large", message: "Request body too large." }, 413),
  })(c, next);
  });

  // Brute-force protection for the dashboard login (the v1 login is limited below).
  app.use("/api/auth/login", rateLimiter({ trustedProxies: config.trustedProxies, windowMs: 60_000, max: 10 }));

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
    c.header("Set-Cookie", sessionCookie(token, sessionConfig));
    return c.json({ data: { ok: true } });
  });

  app.post("/api/auth/logout", async (c) => {
    c.header("Set-Cookie", sessionCookie("", sessionConfig));
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
  if (enrollmentAuthority) {
    for (const path of ['join', 'admission', 'leave']) app.use(`/api/v1/network/${path}`, rateLimiter({ trustedProxies: config.trustedProxies, windowMs: 60_000, max: path === 'admission' ? 6000 : 30 }));
    app.route('/api/v1', v1EnrollmentWorkerRoutes(enrollmentAuthority));
  }

  // Auth routes: public but rate-limited to prevent brute force. The limiter
  // is scoped to /auth/* — a "/*" limiter here would run for every /api/v1
  // route mounted after this app and throttle the whole API to 10 req/min.
  const authApp = new Hono();
  authApp.use("/auth/*", rateLimiter({ trustedProxies: config.trustedProxies, windowMs: 60_000, max: 10 }));
  authApp.route("/", v1AuthRoutes({ sessionConfig }));
  app.route("/api/v1", authApp);

  // Authenticated v1 routes — apply auth resolver middleware. When auth is
  // intentionally omitted, the v1 API stays open just like the dashboard's
  // legacy routes; binding an open station to a non-loopback host emits a
  // prominent warning during start-up below.
  const v1 = new Hono();
  v1.use("/*", authResolver({ keyStore, sessionConfig }));
  v1.use('/*', async (c, next) => {
    const tenant = c.req.header('X-Station-Image-Tenant'), worker = c.req.header('X-Station-Image-Worker'), namespace = c.req.header('X-Station-Image-Registry');
    if (tenant !== undefined && tenant !== config.registry?.tenantId || worker !== undefined && worker !== config.network.stationId || namespace !== undefined && (!imageRegistry || namespace !== createHash('sha256').update(imageRegistry.identity).digest('hex'))) return c.json({ error: 'registry_target_mismatch' }, 409);
    return next();
  });
  const authEnabled = Boolean(keyStore || sessionConfig);

  // Hono runs a sub-app's `use("/*")` middleware for routes that sibling
  // sub-apps mount LATER under the same prefix, so per-group scope guards
  // stack instead of isolating (a trigger-only key would be rejected by the
  // read group's guard before reaching /trigger). Attach the guard to each
  // route individually instead.
  const guarded = (scope: string | string[], group: Hono): Hono => {
    if (!authEnabled) return group;
    const out = new Hono();
    const guard = requireScope(...(Array.isArray(scope) ? scope : [scope]));
    for (const r of group.routes) {
      out.on(r.method, r.path, guard, r.handler);
    }
    return out;
  };

  // Read-scope routes
  const readRoutes = new Hono();
  if (authEnabled) v1.use("/info", requireScope("read", "admin", "execution", "registry"));
  v1.get("/info", (c) => c.json({ data: {
    protocol: "station.api/v1", version: "3.0.0", stationId: config.network.stationId,
    role: config.role, capabilities: ["signals", "broadcasts", "beacons", "schedules", "network", ...(config.execution ? ["execution"] : []), ...(imageRegistry ? ["registry"] : [])],
    ...(config.registry?.tenantId ? { imageExecution: { tenantId: config.registry.tenantId, isolation: config.registry.execution?.backend.kind === 'docker' ? 'container' : 'trusted-host', registryIdentity: createHash('sha256').update(imageRegistry!.identity).digest('hex') } } : {}),
  } }));
  readRoutes.route("/", v1StationReadRoutes({ adapter: networkAdapter, networkId: config.network.id }));
  readRoutes.route("/", v1SignalRoutes({ signalRunner, signalSubscriber: stationSignalSub, networkAdapter, networkId: config.network.id }));
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
  const beaconDeps = {
    beaconRunner, beaconAdapter, logBuffer, logStore,
    networkAdapter, networkId: config.network.id,
    maxInstancesPerBeacon: config.beaconMaxInstances,
  };
  readRoutes.route("/", v1BeaconReadRoutes(beaconDeps));
  v1.route("/", guarded("read", readRoutes));

  // Trigger-scope routes
  v1.route("/", guarded("trigger", v1TriggerRoutes({
    signalRunner, signalAdapter, broadcastRunner, broadcastAdapter,
    signalSubscriber: stationSignalSub, networkAdapter, networkId: config.network.id,
  })));

  // Bringing a beacon up is the long-running counterpart of triggering a
  // signal, so it shares the trigger scope (admin also passes).
  v1.route("/", guarded(["trigger", "admin"], v1BeaconStartRoutes(beaconDeps)));
  v1.route("/", guarded(["trigger", "admin"], v1BeaconProxyRoutes(beaconDeps)));

  // Cancel-scope routes — only the cancel endpoints
  const cancelRoutes = new Hono();
  cancelRoutes.post("/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    let success: boolean;
    if (signalRunner) {
      success = await signalRunner.cancel(id);
    } else {
      const run = await signalAdapter.getRun(id);
      success = Boolean(run && (run.status === "pending" || run.status === "running"));
      if (success) {
        const completedAt = new Date();
        success = signalAdapter.cancelRun
          ? await signalAdapter.cancelRun(id, completedAt)
          : (await signalAdapter.updateRun(id, {
              status: "cancelled", completedAt, leaseToken: undefined,
              leaseExpiresAt: undefined, claimedAt: undefined,
            }), true);
      }
    }
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

  // Stopping a beacon instance is a halt, not a mutation — same scope family as
  // cancelling a run (trigger/admin also pass, so one key can do both).
  v1.route("/", guarded(["cancel", "trigger", "admin"], v1BeaconStopRoutes(beaconDeps)));

  // Admin-scope routes — destructive / mutating endpoints
  const adminRoutes = new Hono();
  if (enrollmentAuthority) adminRoutes.route('/', v1EnrollmentAdminRoutes(enrollmentAuthority));
  adminRoutes.route("/", v1StationAdminRoutes({ adapter: networkAdapter, networkId: config.network.id }));
  adminRoutes.route("/", v1KeyRoutes({ keyStore }));
  adminRoutes.route("/", v1DefinitionRoutes({
    broadcastRunner,
    broadcastAdapter,
    signalRunner,
    signalSubscriber: stationSignalSub,
  }));
  adminRoutes.route("/", v1ScheduleRoutes({ scheduleAdapter }));
  adminRoutes.route("/", v1EnvRoutes({ envStore }));
  adminRoutes.route("/", v1BeaconAdminRoutes(beaconDeps));
  v1.route("/", guarded("admin", adminRoutes));

  v1.route("/", executionCatalogRoutes({
    adapter: networkAdapter, networkId: config.network.id, stationId: config.network.stationId,
    role: config.role, enabled: Boolean(config.execution), targets: config.execution?.targets,
  }));
  if (config.execution) {
    const executionDeps = {
      execution: config.execution, adapter: networkAdapter,
      networkId: config.network.id, stationId: config.network.stationId, role: config.role,
    };
    // Operator execution remains admin-only; the separate customer gateway uses tenant-only keys.
    v1.route("/", publicExecutionRoutes(executionDeps));
    v1.route("/", tenantExecutionRoutes(executionDeps));
    app.route("/internal", internalExecutionRoutes(executionDeps));
  }
  if (imageRegistry) {
    const uploads = new ImageUploadManager({ ...config.registry?.uploads, registry: imageRegistry, storage: config.registry?.uploads?.storage ?? new FileImageUploadStorage(resolve(dataDir, 'image-uploads')) });
    v1.route('/', imageUploadRoutes(uploads));
    v1.route("/", imageRegistryRoutes(imageRegistry, imageSource, images));
  }
  if (config.registry?.targets) {
    if (config.role !== 'headquarters') throw new Error('Registry targets require Headquarters');
    v1.route('/', registryProxyRoutes(config.registry.targets));
  }
  if (config.registry?.tenants) {
    if (!config.auth) throw new Error('Tenant registries require authenticated API keys');
    v1.route('/', tenantImageRegistryRoutes(config.registry.tenants, imageRegistry ? [imageRegistry.identity] : []));
  }
  app.route("/api/v1", v1);

  app.notFound((c) => c.json({ error: "not_found", message: "API route not found. Start station-dashboard separately for the web UI." }, 404));

  let httpServer: Server | null = null;
  let imageSyncTimer: ReturnType<typeof setInterval> | undefined;
  let imageSync: Promise<void> | undefined;
  const syncImages = () => {
    if (!images || !imageSource || imageSync) return imageSync;
    imageSync = (async () => { await images!.sync(await imageSource.list()); await images!.syncGenerations(await imageSource.generations()); })().catch(error => { console.error("[station] Image catalog sync failed:", error instanceof Error ? error.message : "unavailable"); }).finally(() => { imageSync = undefined; });
    return imageSync;
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeating = false;
  const stationStartedAt = new Date();

  const stationSnapshot = (status: StationNode["status"] = "online"): StationNode => {
    const now = new Date();
    const registeredBeacons = beaconRunner?.listRegistered() ?? [];
    return {
      id: config.network.stationId,
      networkId: config.network.id,
      name: config.network.name,
      role: config.role,
      status,
      labels: { ...config.network.labels },
      capacity: {
        maxConcurrent: config.runRunners ? config.runner.maxConcurrent : 0,
        activeRuns: signalRunner?.getActiveCount() ?? 0,
      },
      definitions: {
        signals: signalRunner?.listRegistered().map((item) => item.name).sort() ?? [],
        ...(images ? { images: { installableSignals: images.installableNames() } } : {}),
        broadcasts: broadcastRunner?.listRegistered().map((item) => item.name).sort() ?? [],
        beacons: registeredBeacons.map((item) => item.name).sort(),
        beaconMetadata: registeredBeacons,
        execution: config.execution ? {
          tenantId: config.execution.tenantId,
          sandbox: config.execution.sandbox ? { backend: config.execution.sandbox.name, capabilities: { ...config.execution.sandbox.capabilities } } : undefined,
          browser: config.execution.browser ? { backend: config.execution.browser.adapter.name, capabilities: { ...config.execution.browser.adapter.capabilities, durableRecordings: config.execution.browser.recordingPersistence === "disk", liveView: true, humanControl: true, durableAudit: config.execution.browser.statePersistence === "disk", checkpoints: config.execution.browser.statePersistence === "disk" && Boolean(config.execution.browser.adapter.capabilities.pages) } } : undefined,
        } : undefined,
      },
      endpoint: config.network.endpoint,
      version: process.env.npm_package_version,
      startedAt: stationStartedAt,
      lastHeartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + config.network.leaseDurationMs),
    };
  };

  const sendHeartbeat = async (): Promise<void> => {
    if (heartbeating) return;
    heartbeating = true;
    try {
      if (admission && !await admission.canRenew()) {
        await networkAdapter.heartbeat(config.network.stationId, stationSnapshot('offline'));
        return;
      }
      const existing = await networkAdapter.getStation(config.network.stationId);
      const snapshot = stationSnapshot(existing?.status === "draining" ? "draining" : "online");
      const updated = await networkAdapter.heartbeat(snapshot.id, snapshot);
      if (!updated) await networkAdapter.upsertStation(snapshot);
      await networkAdapter.markOfflineBefore(new Date(), config.network.id);
      await images?.reconcileRollouts();
      await images?.reapArtifacts();
    } catch (err) {
      console.error("[station] Network heartbeat failed:", err);
    } finally {
      heartbeating = false;
    }
  };

  return {
    keyStore,
    dataDir,
    async start() {
      if (admission && !await admission.canClaim()) throw new Error('Station enrollment admission denied or unavailable');
      if (!config.network.adapter && config.role !== "standalone") {
        console.warn(
          "[station] A non-standalone role is using the in-memory network adapter; " +
          "Headquarters and stations in separate processes will not see each other.",
        );
      }
      await networkAdapter.upsertStation(stationSnapshot());
      if (!config.auth && !isLoopbackHost(config.host)) {
        console.warn(
          `[station] WARNING: no auth configured while binding to ${config.host} — ` +
          "anyone who can reach this port can view logs and trigger, cancel, or rerun jobs. " +
          "Set auth (STATION_AUTH_USERNAME/STATION_AUTH_PASSWORD) or bind to 127.0.0.1.",
        );
      }

      await images?.restore();
      for (const reference of config.registry?.activate ?? []) await images?.install(reference);
      if (images && imageSource) {
        const interval = config.registry?.upstream?.syncIntervalMs ?? 5000;
        if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 3600000) throw new Error("Registry sync interval must be between 1000 and 3600000 ms");
        await syncImages();
        imageSyncTimer = setInterval(() => { void syncImages(); }, interval);
      }

      // Start execution runners and Headquarters control-plane reconcilers.
      if (runsControlPlane || runsExecutionPlane) {
        if (signalRunner) {
          await signalRunner.initialize();
          signalRunner.start().catch((err: unknown) => {
            console.error("[station] Signal runner error:", err);
          });
        }
        if (broadcastRunner && runsControlPlane) {
          broadcastRunner.start().catch((err: unknown) => {
            console.error("[station] Broadcast runner error:", err);
          });
        }
        if (beaconRunner) {
          beaconRunner.start().catch((err: unknown) => {
            console.error("[station] Beacon runner error:", err);
          });
          // Discovery and instance hydration are async, so wait for them before
          // binding the port — otherwise the first /api/beacons request can
          // land on an empty registry and report no beacons at all.
          await beaconRunner.whenReady();
        }
      }

      await sendHeartbeat();
      heartbeatTimer = setInterval(() => void sendHeartbeat(), config.network.heartbeatIntervalMs);

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
      if (imageSyncTimer) { clearInterval(imageSyncTimer); imageSyncTimer = undefined; }
      await imageSync;
      await images?.stop();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      // Close execution first: browser actions may hold HTTP connections open.
      // Adapter close interrupts those operations before server.close waits on them.
      await Promise.allSettled([config.execution?.sandbox?.close(), config.execution?.browser?.close()]);
      // End long-lived streams before server.close waits on their connections.
      wsHub.close();
      sseHub.close();
      // Stop accepting work before tearing down runners and their adapters.
      if (httpServer) {
        const server = httpServer;
        httpServer = null;
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error?: Error) => error ? rejectClose(error) : resolveClose());
        });
      }
      try {
        await networkAdapter.upsertStation(stationSnapshot("offline"));
      } catch (err) {
        console.error("[station] Failed to mark station offline:", err);
      }
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
      if (!beaconRunner) await beaconAdapter?.close?.();
      if (!broadcastRunner) await broadcastAdapter?.close?.();
      if (!signalRunner) await signalAdapter.close?.();
      await scheduleAdapter?.close?.();
      await logStore.close();
      await keyStore?.close();
      await envStore.close();
      await networkAdapter.close?.();
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
