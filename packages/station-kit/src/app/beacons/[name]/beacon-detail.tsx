"use client";

import { useEffect, useRef, useState } from "react";
import { useApi, type BeaconListItem, type BeaconEvent } from "../../hooks/use-api";
import { useStation } from "../../hooks/use-station";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { StatusBadge } from "../../components/status-badge";
import { JsonViewer } from "../../components/json-viewer";

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

function fmt(v?: string): string {
  return v ? new Date(v).toLocaleString() : "—";
}

export function BeaconDetail({ name }: { name: string }) {
  const api = useApi();
  const { events } = useStation();
  const [item, setItem] = useState<BeaconListItem | null>(null);
  const [beaconEvents, setBeaconEvents] = useState<BeaconEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "start" | "stop" | "restart">(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useBreadcrumb(
    [{ label: "Beacons", href: "/beacons" }, { label: name }],
    "beacons",
  );

  useEffect(() => {
    async function load() {
      try {
        const [b, ev, lg] = await Promise.all([
          api.getBeacon(name),
          api.getBeaconEvents(name),
          api.getBeaconLogs(name),
        ]);
        setItem(b.data);
        setBeaconEvents(ev.data);
        setLogs(lg.data.map((l) => ({ level: l.level, message: l.message, timestamp: l.timestamp })));
      } catch (err: unknown) {
        if (err instanceof Error) console.error("Failed to load beacon:", err.message);
      }
      setLoading(false);
    }
    load();
  }, [name]);

  // Live updates: append logs, reconcile instance + event timeline from WS.
  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (!latest.type.startsWith("beacon:")) return;
    if (latest.type === "beacon:log") {
      const d = latest.data as Record<string, unknown>;
      if (d.beaconName !== name) return;
      setLogs((prev) => [...prev, {
        level: (d.level as string) ?? "stdout",
        message: (d.message as string) ?? "",
        timestamp: (d.timestamp as string) ?? latest.timestamp,
      }]);
    } else {
      const inst = (latest.data as Record<string, unknown>).instance as BeaconListItem["instance"] | undefined;
      if (!inst || inst.beaconName !== name) return;
      setItem((prev) => (prev ? { ...prev, instance: inst } : prev));
      api.getBeaconEvents(name).then((r) => setBeaconEvents(r.data)).catch(() => {});
    }
  }, [events.length, name]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  async function control(action: "start" | "stop" | "restart") {
    setBusy(action);
    try {
      if (action === "start") await api.startBeacon(name);
      else if (action === "stop") await api.stopBeacon(name);
      else await api.restartBeacon(name);
      const [b, ev] = await Promise.all([api.getBeacon(name), api.getBeaconEvents(name)]);
      setItem(b.data);
      setBeaconEvents(ev.data);
    } catch (err: unknown) {
      if (err instanceof Error) console.error(`${action} failed:`, err.message);
    }
    setBusy(null);
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

  const inst = item.instance;
  const canStart = !inst || inst.desiredState === "stopped" || inst.status === "errored" || inst.status === "stopped";
  const canStop = !!inst && inst.desiredState === "running" && inst.status !== "stopped" && inst.status !== "errored";
  const canRestart = !!inst && (inst.status === "running" || inst.status === "starting");

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {inst && <StatusBadge status={inst.status} />}
          <h1 className="page-title" style={{ marginBottom: 0 }}>{name}</h1>
        </div>
        <div className="page-header-actions">
          <button className="btn btn--primary" onClick={() => control("start")} disabled={!canStart || busy !== null}>
            {busy === "start" ? "Starting..." : "Start"}
          </button>
          <button className="btn" onClick={() => control("restart")} disabled={!canRestart || busy !== null}>
            {busy === "restart" ? "Restarting..." : "Restart"}
          </button>
          <button className="btn btn--danger" onClick={() => control("stop")} disabled={!canStop || busy !== null}>
            {busy === "stop" ? "Stopping..." : "Stop"}
          </button>
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-label">Metadata</div>
        <div className="detail-grid">
          <span className="detail-label">Status</span>
          <span className="detail-value">{inst ? <StatusBadge status={inst.status} /> : "—"}</span>

          <span className="detail-label">Desired</span>
          <span className="detail-value mono">{inst?.desiredState ?? "—"}</span>

          <span className="detail-label">Mode</span>
          <span className="detail-value">{item.mode}</span>

          <span className="detail-label">Restart policy</span>
          <span className="detail-value mono">{item.restartPolicy}</span>

          <span className="detail-label">Auto-start</span>
          <span className="detail-value mono">{String(item.autoStart)}</span>

          <span className="detail-label">Incarnation</span>
          <span className="detail-value mono">{inst?.incarnation ?? 0}</span>

          <span className="detail-label">Restart count</span>
          <span className="detail-value mono">{inst?.restartCount ?? 0}</span>

          <span className="detail-label">PID</span>
          <span className="detail-value mono">{inst?.pid ?? "—"}</span>

          <span className="detail-label">Started</span>
          <span className="detail-value mono">{fmt(inst?.startedAt)}</span>

          <span className="detail-label">Ready</span>
          <span className="detail-value mono">{fmt(inst?.readyAt)}</span>

          <span className="detail-label">Last heartbeat</span>
          <span className="detail-value mono">{fmt(inst?.lastHeartbeatAt)}</span>

          <span className="detail-label">Last exit</span>
          <span className="detail-value mono">
            {inst?.lastExitReason ? `${inst.lastExitReason} @ ${fmt(inst.lastExitAt)}` : "—"}
          </span>

          <span className="detail-label">Next restart</span>
          <span className="detail-value mono">{fmt(inst?.nextRestartAt)}</span>

          <span className="detail-label">File</span>
          <span className="detail-value mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{item.filePath}</span>
        </div>
      </div>

      {inst?.lastError && (
        <div className="detail-section">
          <div className="detail-section-label">Last error</div>
          <div className="error-block">{inst.lastError}</div>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-label">Config</div>
        <JsonViewer data={inst?.config ?? "{}"} />
      </div>

      <div className="detail-section">
        <div className="detail-section-label">Lifecycle events</div>
        {beaconEvents.length === 0 ? (
          <div className="empty-state"><p className="empty-state-text">No events recorded.</p></div>
        ) : (
          <table className="station-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Incarnation</th>
                <th>Detail</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {beaconEvents.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ fontSize: "0.8125rem" }}>{e.type}</td>
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
        <div className="detail-section-label">Logs</div>
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
