"use client";

import { useCallback, useEffect, useState } from "react";

export interface ExecutionStation {
  stationId: string;
  name: string;
  status: "online" | "draining" | "offline";
  role: string;
  capabilities: { sandbox: boolean; browser: boolean };
  features?: { sandbox?: Record<string, boolean>; browser?: Record<string, boolean> };
  available: boolean;
  backends?: { sandbox?: string; browser?: string };
}
export type Primitive = "sandbox" | "browser";
export async function executionRequest<T>(stationId: string, primitive: Primitive, body: Record<string, unknown>): Promise<T> {
  return readResponse<T>(await fetch(`/api/v1/stations/${encodeURIComponent(stationId)}/execution/${primitive}`, {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}
async function readResponse<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Execution requires an administrator session. Sign in to an authenticated Station to manage these resources.");
    throw new Error(json?.message ?? `Station could not complete the request (${response.status}). Refresh the selected owner before repeating an action.`);
  }
  return json.data as T;
}
export function executionError(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed. Check the selected owner before repeating it.";
}
export function useExecutionStations(primitive: Primitive) {
  const [stations, setStations] = useState<ExecutionStation[]>([]);
  const [owner, setOwner] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const nodes = await readResponse<ExecutionStation[]>(await fetch("/api/v1/execution", { credentials: "include" }));
      const eligible = nodes.filter((node) => node.capabilities[primitive]);
      setStations(eligible);
      setOwner((previous) => previous || eligible.find((node) => node.available && node.status === "online")?.stationId || eligible[0]?.stationId || "");
      setError("");
    } catch (e) { setError(executionError(e)); }
    finally { setLoading(false); }
  }, [primitive]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);
  return { stations, owner, setOwner, loading, error, refresh, station: stations.find((node) => node.stationId === owner) };
}
