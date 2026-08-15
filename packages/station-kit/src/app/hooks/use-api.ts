"use client";

const API_BASE = "";

interface ApiResponse<T> {
  data: T;
  meta?: { total?: number };
}

interface ApiError {
  error: string;
  message: string;
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err: ApiError = await res.json().catch(() => ({ error: "unknown", message: "Request failed." }));
    throw new Error(err.message);
  }
  return res.json();
}

export async function checkAuth(): Promise<{ authenticated: boolean; authRequired: boolean }> {
  const res = await fetch(`${API_BASE}/api/auth/check`, { credentials: "include" });
  const json = await res.json();
  return json.data;
}

export async function login(username: string, password: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.ok;
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export interface SchemaField {
  type: string;
  required: boolean;
  properties?: Record<string, SchemaField>;
  items?: SchemaField;
  values?: string[];
}

export interface SignalMeta {
  name: string;
  filePath: string;
  inputSchema: SchemaField | null;
  outputSchema: SchemaField | null;
  interval: string | null;
  timeout: number;
  maxAttempts: number;
  maxConcurrency: number | null;
  hasSteps: boolean;
  stepNames: string[];
  requiredEnv?: string[];
}

export type EnvTargetKind = "signal" | "beacon";

export interface EnvTarget {
  kind: EnvTargetKind;
  name: string;
}

export interface EnvVar {
  id: string;
  key: string;
  /** Null when the variable is secret (write-only). */
  value: string | null;
  secret: boolean;
  targets: EnvTarget[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface BroadcastMeta {
  name: string;
  filePath: string;
  nodes: Array<{ name: string; signalName: string; dependsOn: string[] }>;
  failurePolicy: string;
  timeout: number | null;
  interval: string | null;
}

export type BeaconStatus =
  | "stopped" | "starting" | "running" | "stopping" | "backoff" | "errored";

export interface BeaconInstance {
  /** Unique instance id. A beacon's definition-owned instance uses the beacon name. */
  id: string;
  beaconName: string;
  label?: string;
  /** `definition` = seeded from the beacon file; `api` = created at runtime. */
  origin: "definition" | "api";
  status: BeaconStatus;
  desiredState: "running" | "stopped";
  incarnation: number;
  restartCount: number;
  pid?: number;
  config?: string;
  startedAt?: string;
  readyAt?: string;
  lastHeartbeatAt?: string;
  lastExitAt?: string;
  lastExitReason?: "clean" | "failure" | "stopped" | "stalled" | "startup-timeout";
  lastError?: string;
  nextRestartAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BeaconListItem {
  name: string;
  /** Optional while a Headquarters is connected to an older station. */
  filePath?: string;
  mode?: "run" | "poll";
  restartPolicy?: string;
  /** How instances come into existence: seeded and started, seeded stopped, or API-only. */
  startMode?: "auto" | "manual" | "on-demand";
  autoStart?: boolean;
  maxInstances?: number;
  requiredEnv?: string[];
  /** The definition-owned instance, or null for an on-demand beacon. */
  instance: BeaconInstance | null;
  instances: BeaconInstance[];
  instanceCount: number;
  runningCount: number;
}

export interface BeaconDetail extends BeaconListItem {
  /** Serialized config schema, so the dashboard can render a form for new instances. */
  configSchema: SchemaField | null;
  defaultConfig: unknown;
}

export interface BeaconEvent {
  id: string;
  instanceId: string;
  beaconName: string;
  incarnation: number;
  type: string;
  message?: string;
  at: string;
}

export interface CreateBeaconInstanceBody {
  id?: string;
  label?: string;
  config?: unknown;
  start?: boolean;
}

export interface BeaconLogEntry {
  runId: string;
  signalName: string;
  level: string;
  message: string;
  timestamp: string;
}

const instancePath = (name: string, instanceId: string) =>
  `/v1/beacons/${encodeURIComponent(name)}/instances/${encodeURIComponent(instanceId)}`;

// ─── Dynamic broadcasts / schedules / expressions ───────────────────

export type ScheduleKind = "signal" | "broadcast-static" | "broadcast-dynamic";

export interface Schedule {
  id: string;
  kind: ScheduleKind;
  target: string;
  interval?: string;
  cron?: string;
  timezone?: string;
  overlapPolicy?: "allow" | "skip";
  misfirePolicy?: "skip" | "fire-once" | "catch-up";
  misfireGraceMs?: number;
  input?: unknown;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface DynamicNodeSpec {
  name: string;
  signalName: string;
  dependsOn: string[];
  input?: unknown;
  when?: unknown;
}

export interface DynamicBroadcastSpec {
  name: string;
  version: number;
  failurePolicy: "fail-fast" | "skip-downstream" | "continue";
  timeout?: number;
  nodes: DynamicNodeSpec[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  deletedAt?: string;
}

export interface DynamicValidationResult {
  ok: boolean;
  errors: Array<{ node: string; field?: string; message: string }>;
}

export interface StationNode {
  id: string;
  networkId: string;
  name: string;
  role: "headquarters" | "station" | "standalone";
  status: "online" | "draining" | "offline";
  labels: Record<string, string>;
  capacity: { maxConcurrent: number; activeRuns: number };
  definitions: { signals: string[]; broadcasts: string[]; beacons: string[] };
  endpoint?: string;
  version?: string;
  startedAt: string;
  lastHeartbeatAt: string;
  leaseExpiresAt: string;
}

export function useApi() {
  return {
    getStations: () => fetchApi<StationNode[]>("/v1/stations"),
    updateStationStatus: (id: string, status: StationNode["status"]) =>
      fetchApi<StationNode>(`/v1/stations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    // Health
    getHealth: () => fetchApi<{ ok: boolean; signal: boolean; broadcast: boolean | null }>("/health"),

    // Signals
    getSignals: () => fetchApi<SignalMeta[]>("/signals"),
    getScheduledSignals: () =>
      fetchApi<Array<{ name: string; interval: string; nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null }>>("/signals/scheduled"),
    getSignal: (name: string) => fetchApi<SignalMeta>(`/signals/${encodeURIComponent(name)}`),
    getSignalRuns: (name: string) => fetchApi<any[]>(`/signals/${encodeURIComponent(name)}/runs`),
    triggerSignal: (name: string, input?: unknown) =>
      fetchApi<{ id: string }>(`/signals/${encodeURIComponent(name)}/trigger`, {
        method: "POST",
        body: JSON.stringify({ input: input ?? {} }),
      }),

    // Runs
    getRuns: (params?: { status?: string; signalName?: string }) => {
      const query = new URLSearchParams();
      if (params?.status) query.set("status", params.status);
      if (params?.signalName) query.set("signalName", params.signalName);
      const qs = query.toString();
      return fetchApi<any[]>(`/runs${qs ? `?${qs}` : ""}`);
    },
    getRunStats: () => fetchApi<{ pending: number; running: number; completed: number; failed: number; cancelled: number }>("/runs/stats"),
    getRun: (id: string) => fetchApi<any>(`/runs/${id}`),
    getRunSteps: (id: string) => fetchApi<any[]>(`/runs/${id}/steps`),
    getRunLogs: (id: string) => fetchApi<Array<{ runId: string; signalName: string; level: string; message: string; timestamp: string }>>(`/runs/${id}/logs`),
    cancelRun: (id: string) => fetchApi<{ cancelled: boolean }>(`/runs/${id}/cancel`, { method: "POST" }),
    rerunRun: (id: string) => fetchApi<{ id: string; signalName: string; status: string }>(`/runs/${id}/rerun`, { method: "POST" }),
    retryRun: (id: string) => fetchApi<{ retried: boolean }>(`/runs/${id}/retry`, { method: "POST" }),

    // Broadcasts
    getBroadcasts: () => fetchApi<BroadcastMeta[]>("/broadcasts"),
    getBroadcast: (name: string) => fetchApi<BroadcastMeta>(`/broadcasts/${encodeURIComponent(name)}`),
    triggerBroadcast: (name: string, input?: unknown) =>
      fetchApi<{ id: string }>(`/broadcasts/${encodeURIComponent(name)}/trigger`, {
        method: "POST",
        body: JSON.stringify({ input: input ?? {} }),
      }),
    getBroadcastRuns: (name: string) => fetchApi<any[]>(`/broadcasts/${encodeURIComponent(name)}/runs`),
    getBroadcastRun: (id: string) => fetchApi<any>(`/broadcast-runs/${id}`),
    getBroadcastRunNodes: (id: string) => fetchApi<any[]>(`/broadcast-runs/${id}/nodes`),
    getBroadcastRunLogs: (id: string) => fetchApi<Array<{ runId: string; signalName: string; level: string; message: string; timestamp: string; nodeName: string }>>(`/broadcast-runs/${id}/logs`),
    cancelBroadcastRun: (id: string) => fetchApi<{ cancelled: boolean }>(`/broadcast-runs/${id}/cancel`, { method: "POST" }),
    rerunBroadcastRun: (id: string) => fetchApi<{ id: string; broadcastName: string; status: string }>(`/broadcast-runs/${id}/rerun`, { method: "POST" }),

    // Beacons
    getBeacons: () => fetchApi<BeaconListItem[]>("/v1/beacons"),
    getBeacon: (name: string) => fetchApi<BeaconDetail>(`/v1/beacons/${encodeURIComponent(name)}`),
    getBeaconEvents: (name: string) => fetchApi<BeaconEvent[]>(`/v1/beacons/${encodeURIComponent(name)}/events`),
    getBeaconLogs: (name: string) =>
      fetchApi<BeaconLogEntry[]>(`/beacons/${encodeURIComponent(name)}/logs`),
    startBeacon: (name: string) => fetchApi<{ started: boolean }>(`/v1/beacons/${encodeURIComponent(name)}/start`, { method: "POST" }),
    stopBeacon: (name: string) => fetchApi<{ stopped: boolean }>(`/v1/beacons/${encodeURIComponent(name)}/stop`, { method: "POST" }),
    restartBeacon: (name: string) => fetchApi<{ restarted: boolean }>(`/v1/beacons/${encodeURIComponent(name)}/restart`, { method: "POST" }),

    // Beacon instances — a beacon can run many at once, each with its own config
    getBeaconInstances: (name: string) =>
      fetchApi<BeaconInstance[]>(`/v1/beacons/${encodeURIComponent(name)}/instances`),
    createBeaconInstance: (name: string, body: CreateBeaconInstanceBody) =>
      fetchApi<BeaconInstance>(`/v1/beacons/${encodeURIComponent(name)}/instances`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    updateBeaconInstance: (
      name: string,
      instanceId: string,
      body: { config?: unknown; label?: string; restart?: boolean },
    ) =>
      fetchApi<BeaconInstance>(instancePath(name, instanceId), {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    deleteBeaconInstance: (name: string, instanceId: string) =>
      fetchApi<{ deleted: boolean }>(instancePath(name, instanceId), { method: "DELETE" }),
    startBeaconInstance: (name: string, instanceId: string) =>
      fetchApi<{ started: boolean }>(`${instancePath(name, instanceId)}/start`, { method: "POST" }),
    stopBeaconInstance: (name: string, instanceId: string) =>
      fetchApi<{ stopped: boolean }>(`${instancePath(name, instanceId)}/stop`, { method: "POST" }),
    restartBeaconInstance: (name: string, instanceId: string) =>
      fetchApi<{ restarted: boolean }>(`${instancePath(name, instanceId)}/restart`, { method: "POST" }),
    getBeaconInstanceEvents: (name: string, instanceId: string) =>
      fetchApi<BeaconEvent[]>(`${instancePath(name, instanceId)}/events`),
    getBeaconInstanceLogs: (name: string, instanceId: string) =>
      fetchApi<BeaconLogEntry[]>(`${instancePath(name, instanceId)}/logs`),

    // Dynamic broadcast definitions (v1)
    getBroadcastDefinitions: () =>
      fetchApi<DynamicBroadcastSpec[]>("/v1/broadcast-definitions"),
    getBroadcastDefinition: (name: string) =>
      fetchApi<DynamicBroadcastSpec>(`/v1/broadcast-definitions/${encodeURIComponent(name)}`),
    getBroadcastDefinitionVersions: (name: string) =>
      fetchApi<DynamicBroadcastSpec[]>(`/v1/broadcast-definitions/${encodeURIComponent(name)}/versions`),
    saveBroadcastDefinition: (spec: Partial<DynamicBroadcastSpec>) =>
      fetchApi<DynamicBroadcastSpec>("/v1/broadcast-definitions", {
        method: "POST",
        body: JSON.stringify(spec),
      }),
    validateBroadcastDefinition: (spec: Partial<DynamicBroadcastSpec>) =>
      fetchApi<DynamicValidationResult>("/v1/broadcast-definitions/validate", {
        method: "POST",
        body: JSON.stringify(spec),
      }),
    deleteBroadcastDefinition: (name: string) =>
      fetchApi<{ deleted: boolean }>(`/v1/broadcast-definitions/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    triggerDynamicBroadcast: (broadcastName: string, input?: unknown) =>
      fetchApi<{ id: string }>("/v1/trigger-dynamic-broadcast", {
        method: "POST",
        body: JSON.stringify({ broadcastName, input: input ?? {} }),
      }),

    // Schedules (v1)
    getSchedules: (filter?: { kind?: ScheduleKind; enabled?: boolean }) => {
      const q = new URLSearchParams();
      if (filter?.kind) q.set("kind", filter.kind);
      if (filter?.enabled !== undefined) q.set("enabled", String(filter.enabled));
      const qs = q.toString();
      return fetchApi<Schedule[]>(`/v1/schedules${qs ? `?${qs}` : ""}`);
    },
    getSchedule: (id: string) => fetchApi<Schedule>(`/v1/schedules/${id}`),
    createSchedule: (input: { kind: ScheduleKind; target: string; interval?: string; cron?: string; timezone?: string; overlapPolicy?: Schedule["overlapPolicy"]; misfirePolicy?: Schedule["misfirePolicy"]; input?: unknown; enabled?: boolean }) =>
      fetchApi<Schedule>("/v1/schedules", { method: "POST", body: JSON.stringify(input) }),
    updateSchedule: (id: string, patch: Partial<{ interval: string; cron: string; timezone: string; overlapPolicy: Schedule["overlapPolicy"]; misfirePolicy: Schedule["misfirePolicy"]; input: unknown; enabled: boolean; nextRunAt: string }>) =>
      fetchApi<Schedule>(`/v1/schedules/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteSchedule: (id: string) =>
      fetchApi<{ deleted: boolean }>(`/v1/schedules/${id}`, { method: "DELETE" }),
    previewSchedule: (id: string, count = 5) =>
      fetchApi<{ fires: string[] }>(`/v1/schedules/${id}/preview`, {
        method: "POST",
        body: JSON.stringify({ count }),
      }),

    // Expressions (v1)
    evaluateExpression: (node: unknown, context?: { input?: unknown; upstream?: Record<string, unknown> }) =>
      fetchApi<{ value: unknown }>("/v1/expressions/evaluate", {
        method: "POST",
        body: JSON.stringify({ node, context }),
      }),
    validateExpression: (
      node: unknown,
      schemaContext?: {
        inputSchema?: unknown;
        upstreamSchemas?: Record<string, unknown>;
        expectedSchema?: unknown;
      },
    ) =>
      fetchApi<{ ok: boolean; errors: Array<{ path: string; message: string }> }>(
        "/v1/expressions/validate",
        { method: "POST", body: JSON.stringify({ node, schemaContext }) },
      ),
    parseExpression: (source: string) =>
      fetchApi<{ node: unknown }>("/v1/expressions/parse", {
        method: "POST",
        body: JSON.stringify({ source }),
      }),

    // Environment variables (v1 — GET is read-scoped, mutations admin-scoped)
    getEnvVars: () => fetchApi<EnvVar[]>("/v1/env"),
    createEnvVar: (input: { key: string; value: string; secret?: boolean; targets?: EnvTarget[] }) =>
      fetchApi<EnvVar>("/v1/env", { method: "POST", body: JSON.stringify(input) }),
    updateEnvVar: (id: string, patch: Partial<{ value: string; secret: boolean; targets: EnvTarget[] }>) =>
      fetchApi<EnvVar>(`/v1/env/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteEnvVar: (id: string) =>
      fetchApi<{ deleted: boolean }>(`/v1/env/${id}`, { method: "DELETE" }),

    // API Keys (v1 admin routes — session cookie provides admin scope)
    getApiKeys: () => fetchApi<Array<{ id: string; name: string; keyPrefix: string; scopes: string[]; createdAt: string; lastUsed: string | null; expiresAt: string | null; revoked: boolean }>>("/v1/keys"),
    createApiKey: (name: string, scopes: string[]) =>
      fetchApi<{ id: string; name: string; key: string; keyPrefix: string; scopes: string[]; createdAt: string }>("/v1/keys", {
        method: "POST",
        body: JSON.stringify({ name, scopes }),
      }),
    revokeApiKey: (id: string) => fetchApi<{ revoked: boolean }>(`/v1/keys/${id}`, { method: "DELETE" }),
  };
}
