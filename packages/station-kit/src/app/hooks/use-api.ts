"use client";

const API_BASE = process.env.NEXT_PUBLIC_STATION_API ?? "http://localhost:4400";

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
  };
}
