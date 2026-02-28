import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { SignalRunner, MemoryAdapter } from "simple-signal";
import { BroadcastRunner, BroadcastMemoryAdapter } from "simple-broadcast";
import type { SignalQueueAdapter } from "simple-signal";
import type { BroadcastQueueAdapter } from "simple-broadcast";
import type { StationConfig } from "../config/schema.js";
import { WebSocketHub } from "./ws.js";
import { LogBuffer } from "./log-buffer.js";
import { LogStore } from "./log-store.js";
import { StationSignalSubscriber, StationBroadcastSubscriber } from "./subscriber.js";
import { healthRoutes } from "./routes/health.js";
import { signalRoutes } from "./routes/signals.js";
import { runRoutes } from "./routes/runs.js";
import { broadcastRoutes } from "./routes/broadcasts.js";

export interface StationInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createStation(config: StationConfig, cwd: string): Promise<StationInstance> {
  const signalAdapter: SignalQueueAdapter = config.adapter ?? new MemoryAdapter();
  const broadcastAdapter: BroadcastQueueAdapter | undefined =
    config.broadcastAdapter ?? (config.broadcastsDir ? new BroadcastMemoryAdapter() : undefined);

  const wsHub = new WebSocketHub();
  const logBuffer = new LogBuffer();
  const logStore = new LogStore(resolve(cwd, "station-logs.db"));

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

  // CORS for Next.js dev server
  app.use("/*", cors({
    origin: [`http://${config.host}:${config.port + 1}`, `http://localhost:${config.port + 1}`],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }));

  // API routes — pass subscribers for metadata access
  app.route("/api", healthRoutes({ signalAdapter, broadcastAdapter }));
  app.route("/api", signalRoutes({ signalRunner, signalAdapter, signalSubscriber: stationSignalSub }));
  app.route("/api", runRoutes({ signalRunner, signalAdapter, logBuffer, logStore }));
  app.route("/api", broadcastRoutes({ broadcastRunner, broadcastAdapter, broadcastSubscriber: stationBroadcastSub, logBuffer, logStore }));

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
          console.log(`[station] API server on http://${config.host}:${info.port}`);
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
      logStore.close();
      if (httpServer) {
        httpServer.close();
      }
    },
  };
}
