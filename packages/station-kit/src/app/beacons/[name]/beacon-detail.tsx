"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useApi,
  type BeaconDetail as BeaconDetailData,
  type BeaconEvent,
  type BeaconInstance,
} from "../../hooks/use-api";
import { useStation } from "../../hooks/use-station";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { StatusBadge } from "../../components/status-badge";
import { SchemaForm } from "../../components/schema-form";
import { JsonViewer } from "../../components/json-viewer";

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

type Busy = null | "start" | "stop" | "restart" | "delete" | "create";

function fmt(v?: string): string {
  return v ? new Date(v).toLocaleString() : "—";
}

export function BeaconDetail({ name }: { name: string }) {
  const api = useApi();
  const { events } = useStation();
  const [item, setItem] = useState<BeaconDetailData | null>(null);
  const [beaconEvents, setBeaconEvents] = useState<BeaconEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  // Which instance the events/logs panes and the per-instance controls act on.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // New-instance form.
  const [showCreate, setShowCreate] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newConfig, setNewConfig] = useState("{}");
  const [startNow, setStartNow] = useState(true);

  useBreadcrumb([{ label: "Beacons", href: "/beacons" }, { label: name }], "beacons");

  const refresh = useCallback(async () => {
    const [b, ev] = await Promise.all([api.getBeacon(name), api.getBeaconEvents(name)]);
    setItem(b.data);
    setBeaconEvents(ev.data);
    return b.data;
  }, [name]);

  useEffect(() => {
    refresh()
      .then((data) => {
        // Default to the definition-owned instance, else the first one there is.
        setSelectedId((prev) => prev ?? data.instance?.id ?? data.instances[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error) console.error("Failed to load beacon:", err.message);
      })
      .finally(() => setLoading(false));
  }, [name, refresh]);

  // Load the selected instance's log history when the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setLogs([]);
      return;
    }
    let cancelled = false;
    api
      .getBeaconInstanceLogs(name, selectedId)
      .then((r) => {
        if (cancelled) return;
        setLogs(r.data.map((l) => ({ level: l.level, message: l.message, timestamp: l.timestamp })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [name, selectedId]);

  // Live updates: append logs for the selected instance, reconcile the rest.
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (!latest.type.startsWith("beacon:")) return;
    const d = latest.data as Record<string, unknown>;

    if (latest.type === "beacon:log") {
      if (d.instanceId !== selectedId) return;
      setLogs((prev) => [
        ...prev,
        {
          level: (d.level as string) ?? "stdout",
          message: (d.message as string) ?? "",
          timestamp: (d.timestamp as string) ?? latest.timestamp,
        },
      ]);
      return;
    }

    const inst = d.instance as BeaconInstance | undefined;
    if (!inst || inst.beaconName !== name) return;
    refresh().catch(() => {});
  }, [events.length, name, selectedId, refresh]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  async function run(action: Busy, fn: () => Promise<unknown>) {
    setBusy(action);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(null);
  }

  async function handleCreate() {
    let config: unknown;
    const trimmed = newConfig.trim();
    if (trimmed && trimmed !== "{}") {
      try {
        config = JSON.parse(trimmed);
      } catch {
        setError("Config is not valid JSON.");
        return;
      }
    }
    await run("create", async () => {
      const res = await api.createBeaconInstance(name, {
        id: newId.trim() || undefined,
        label: newLabel.trim() || undefined,
        ...(config !== undefined ? { config } : {}),
        start: startNow,
      });
      setSelectedId(res.data.id);
      setShowCreate(false);
      setNewId("");
      setNewLabel("");
      setNewConfig("{}");
    });
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Beacon</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!item) {
    return (
      <div>
        <h1 className="page-title">Beacon</h1>
        <div className="empty-state">
          <p className="empty-state-text">Beacon not found.</p>
        </div>
      </div>
    );
  }

  const selected = item.instances.find((i) => i.id === selectedId) ?? null;
  const canStart =
    !!selected &&
    (selected.desiredState === "stopped" ||
      selected.status === "errored" ||
      selected.status === "stopped");
  const canStop =
    !!selected &&
    selected.desiredState === "running" &&
    selected.status !== "stopped" &&
    selected.status !== "errored";
  const canRestart =
    !!selected && (selected.status === "running" || selected.status === "starting");
  const atCapacity = item.instanceCount >= item.maxInstances;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {item.instance && <StatusBadge status={item.instance.status} />}
          <h1 className="page-title" style={{ marginBottom: 0 }}>{name}</h1>
          <span style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
            {item.runningCount}/{item.instanceCount} running
          </span>
        </div>
        <div className="page-header-actions">
          <button
            className="btn btn--primary"
            onClick={() => setShowCreate((v) => !v)}
            disabled={atCapacity || busy !== null}
            title={atCapacity ? `Instance limit (${item.maxInstances}) reached` : undefined}
          >
            {showCreate ? "Cancel" : "New instance"}
          </button>
          <button
            className="btn btn--danger"
            onClick={() => run("stop", () => api.stopBeacon(name))}
            disabled={item.runningCount === 0 || busy !== null}
          >
            {busy === "stop" ? "Stopping..." : "Stop all"}
          </button>
        </div>
      </div>

      {error && <div className="error-block" style={{ marginBottom: "1rem" }}>{error}</div>}

      {showCreate && (
        <div className="detail-section">
          <div className="detail-section-label">New instance</div>
          <div className="detail-grid" style={{ marginBottom: "0.75rem" }}>
            <span className="detail-label">Id</span>
            <span className="detail-value">
              <input
                className="input-text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder={`auto (${name}-…)`}
                spellCheck={false}
              />
            </span>
            <span className="detail-label">Label</span>
            <span className="detail-value">
              <input
                className="input-text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="optional"
              />
            </span>
            <span className="detail-label">Start now</span>
            <span className="detail-value">
              <input
                type="checkbox"
                checked={startNow}
                onChange={(e) => setStartNow(e.target.checked)}
              />
            </span>
          </div>
          <SchemaForm schema={item.configSchema} value={newConfig} onChange={setNewConfig} />
          <div style={{ marginTop: "0.5rem" }}>
            <button
              className="btn btn--primary"
              onClick={handleCreate}
              disabled={busy !== null}
            >
              {busy === "create" ? "Creating..." : "Create instance"}
            </button>
          </div>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-label">Instances</div>
        {item.instances.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state-text">
              {item.startMode === "on-demand"
                ? "This beacon runs on demand — create an instance to start one."
                : "No instances yet."}
            </p>
          </div>
        ) : (
          <table className="station-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Instance</th>
                <th>Origin</th>
                <th>Desired</th>
                <th>Incarnation</th>
                <th>Restarts</th>
                <th>PID</th>
              </tr>
            </thead>
            <tbody>
              {item.instances.map((inst) => (
                <tr
                  key={inst.id}
                  className={`clickable-row${inst.id === selectedId ? " is-selected" : ""}`}
                  onClick={() => setSelectedId(inst.id)}
                >
                  <td><StatusBadge status={inst.status} /></td>
                  <td className="mono">
                    {inst.id}
                    {inst.label && (
                      <span style={{ color: "var(--muted)", marginLeft: "0.5rem" }}>{inst.label}</span>
                    )}
                  </td>
                  <td style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{inst.origin}</td>
                  <td className="mono" style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>
                    {inst.desiredState}
                  </td>
                  <td className="mono" style={{ fontSize: "0.8125rem" }}>{inst.incarnation}</td>
                  <td className="mono" style={{ fontSize: "0.8125rem" }}>{inst.restartCount}</td>
                  <td className="mono" style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>
                    {inst.pid ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-section-label">Definition</div>
        <div className="detail-grid">
          <span className="detail-label">Mode</span>
          <span className="detail-value">{item.mode}</span>

          <span className="detail-label">Start mode</span>
          <span className="detail-value mono">{item.startMode}</span>

          <span className="detail-label">Restart policy</span>
          <span className="detail-value mono">{item.restartPolicy}</span>

          <span className="detail-label">Max instances</span>
          <span className="detail-value mono">{item.maxInstances}</span>

          {item.requiredEnv && item.requiredEnv.length > 0 && (
            <>
              <span className="detail-label">Required env</span>
              <span className="detail-value mono">{item.requiredEnv.join(", ")}</span>
            </>
          )}

          <span className="detail-label">File</span>
          <span className="detail-value mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
            {item.filePath}
          </span>
        </div>
      </div>

      {selected && (
        <>
          <div className="detail-section">
            <div
              className="detail-section-label"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
            >
              <span>Instance — {selected.id}</span>
              <span style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  className="btn btn--primary"
                  onClick={() => run("start", () => api.startBeaconInstance(name, selected.id))}
                  disabled={!canStart || busy !== null}
                >
                  {busy === "start" ? "Starting..." : "Start"}
                </button>
                <button
                  className="btn"
                  onClick={() => run("restart", () => api.restartBeaconInstance(name, selected.id))}
                  disabled={!canRestart || busy !== null}
                >
                  {busy === "restart" ? "Restarting..." : "Restart"}
                </button>
                <button
                  className="btn btn--danger"
                  onClick={() => run("stop", () => api.stopBeaconInstance(name, selected.id))}
                  disabled={!canStop || busy !== null}
                >
                  {busy === "stop" ? "Stopping..." : "Stop"}
                </button>
                {selected.origin === "api" && (
                  <button
                    className="btn btn--danger"
                    onClick={() =>
                      run("delete", async () => {
                        await api.deleteBeaconInstance(name, selected.id);
                        setSelectedId(null);
                      })
                    }
                    disabled={busy !== null}
                    title="Stop and remove this instance"
                  >
                    {busy === "delete" ? "Deleting..." : "Delete"}
                  </button>
                )}
              </span>
            </div>
            <div className="detail-grid">
              <span className="detail-label">Status</span>
              <span className="detail-value"><StatusBadge status={selected.status} /></span>

              <span className="detail-label">Desired</span>
              <span className="detail-value mono">{selected.desiredState}</span>

              <span className="detail-label">Label</span>
              <span className="detail-value">{selected.label ?? "—"}</span>

              <span className="detail-label">Incarnation</span>
              <span className="detail-value mono">{selected.incarnation}</span>

              <span className="detail-label">Restart count</span>
              <span className="detail-value mono">{selected.restartCount}</span>

              <span className="detail-label">PID</span>
              <span className="detail-value mono">{selected.pid ?? "—"}</span>

              <span className="detail-label">Started</span>
              <span className="detail-value mono">{fmt(selected.startedAt)}</span>

              <span className="detail-label">Ready</span>
              <span className="detail-value mono">{fmt(selected.readyAt)}</span>

              <span className="detail-label">Last heartbeat</span>
              <span className="detail-value mono">{fmt(selected.lastHeartbeatAt)}</span>

              <span className="detail-label">Last exit</span>
              <span className="detail-value mono">
                {selected.lastExitReason
                  ? `${selected.lastExitReason} @ ${fmt(selected.lastExitAt)}`
                  : "—"}
              </span>

              <span className="detail-label">Next restart</span>
              <span className="detail-value mono">{fmt(selected.nextRestartAt)}</span>
            </div>
          </div>

          {selected.lastError && (
            <div className="detail-section">
              <div className="detail-section-label">Last error</div>
              <div className="error-block">{selected.lastError}</div>
            </div>
          )}

          <div className="detail-section">
            <div className="detail-section-label">Config</div>
            <JsonViewer data={selected.config ?? "{}"} />
          </div>
        </>
      )}

      <div className="detail-section">
        <div className="detail-section-label">Lifecycle events</div>
        {beaconEvents.length === 0 ? (
          <div className="empty-state"><p className="empty-state-text">No events recorded.</p></div>
        ) : (
          <table className="station-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Instance</th>
                <th>Incarnation</th>
                <th>Detail</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {beaconEvents.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ fontSize: "0.8125rem" }}>{e.type}</td>
                  <td className="mono" style={{ fontSize: "0.8125rem" }}>{e.instanceId}</td>
                  <td className="mono" style={{ fontSize: "0.8125rem" }}>{e.incarnation}</td>
                  <td style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{e.message ?? "—"}</td>
                  <td className="mono" style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{fmt(e.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-section-label">
          Logs{selected ? ` — ${selected.id}` : ""}
        </div>
        <div className="log-container">
          {logs.length === 0 ? (
            <div style={{ padding: "1rem", color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
              No log output captured.
            </div>
          ) : (
            logs.map((log, i) => (
              <div
                key={i}
                className="log-line"
                style={{ color: log.level === "stderr" ? "var(--rust)" : "var(--charcoal)" }}
              >
                <span className="log-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
                <span className="log-level" data-level={log.level}>{log.level === "stderr" ? "ERR" : "OUT"}</span>
                <span className="log-message">{log.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
