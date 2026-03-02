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
}

export interface BroadcastMeta {
  name: string;
  filePath: string;
  nodes: Array<{ name: string; signalName: string; dependsOn: string[] }>;
  failurePolicy: string;
  timeout: number | null;
  interval: string | null;
}

export function useApi() {
  return {
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
