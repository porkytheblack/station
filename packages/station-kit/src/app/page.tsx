"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi } from "./hooks/use-api";
import { useStation } from "./hooks/use-station";
import { useBreadcrumb } from "./hooks/use-breadcrumb";
import { StatusBadge } from "./components/status-badge";
import { RelativeTime } from "./components/relative-time";

interface Stats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

interface FailedRun {
  id: string;
  signalName: string;
  status: string;
  error?: string;
  createdAt: string;
}

interface ScheduledSignal {
  name: string;
  interval: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
}

function formatCountdown(date: string): string {
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export default function OverviewPage() {
  const api = useApi();
  const router = useRouter();
  const { events } = useStation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [failedRuns, setFailedRuns] = useState<FailedRun[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledSignal[]>([]);
  const [loading, setLoading] = useState(true);

  useBreadcrumb([{ label: "Overview" }], "overview");

  useEffect(() => {
    async function load() {
      try {
        const [statsRes, failedRes, scheduledRes] = await Promise.all([
          api.getRunStats(),
          api.getRuns({ status: "failed" }),
          api.getScheduledSignals(),
        ]);
        setStats(statsRes.data);
        setFailedRuns(failedRes.data.slice(0, 10));
        setScheduled(scheduledRes.data);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error("Failed to load overview data:", err.message);
        }
      }
      setLoading(false);
    }
    load();
  }, []);

  useEffect(() => {
    if (events.length === 0) return;
    const latestEvent = events[0];
    if (latestEvent.type.startsWith("run:")) {
      api.getRunStats().then((r) => setStats(r.data)).catch((e) => console.error("Failed to refresh stats:", e));
      api.getRuns({ status: "failed" }).then((r) => setFailedRuns(r.data.slice(0, 10))).catch((e) => console.error("Failed to refresh failed runs:", e));
      api.getScheduledSignals().then((r) => setScheduled(r.data)).catch((e) => console.error("Failed to refresh scheduled:", e));
    }
  }, [events.length]);

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Overview</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Overview</h1>

      {stats && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-card-label">Pending</div>
            <div className="stat-card-value">{stats.pending}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Running</div>
            <div className="stat-card-value" style={{ color: "var(--patina)" }}>{stats.running}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Completed</div>
            <div className="stat-card-value" style={{ color: "var(--patina)" }}>{stats.completed}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Failed</div>
            <div className="stat-card-value" style={{ color: "var(--rust)" }}>{stats.failed}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Cancelled</div>
            <div className="stat-card-value">{stats.cancelled}</div>
          </div>
        </div>
      )}

      {scheduled.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-label">Scheduled</div>
          <table className="station-table">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Interval</th>
                <th>Next Run</th>
                <th>Last Run</th>
                <th>Last Status</th>
              </tr>
            </thead>
            <tbody>
              {scheduled.map((sig, i) => (
                <tr
                  key={sig.name}
                  className="reveal-item clickable-row"
                  style={{ animationDelay: `${i * 40}ms` }}
                  onClick={() => router.push(`/signals/${encodeURIComponent(sig.name)}`)}
                >
                  <td className="mono">{sig.name}</td>
                  <td className="mono" style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
                    {sig.interval}
                  </td>
                  <td className="mono" style={{ fontSize: "0.8125rem", color: sig.nextRunAt ? "var(--patina)" : "var(--muted)" }}>
                    {sig.nextRunAt ? formatCountdown(sig.nextRunAt) : "\u2014"}
                  </td>
                  <td>
                    {sig.lastRunAt ? <RelativeTime date={sig.lastRunAt} /> : <span className="mono" style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{"\u2014"}</span>}
                  </td>
                  <td>
                    {sig.lastStatus ? <StatusBadge status={sig.lastStatus as any} /> : <span className="mono" style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{"\u2014"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {failedRuns.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-label">Recent Failures</div>
          <table className="station-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Signal</th>
                <th>Error</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {failedRuns.map((run, i) => (
                <tr
                  key={run.id}
                  className="reveal-item clickable-row"
                  style={{ animationDelay: `${i * 40}ms` }}
                  onClick={() => router.push(`/runs/${run.id}`)}
                >
                  <td><StatusBadge status={run.status as any} /></td>
                  <td>
                    <Link
                      href={`/signals/${run.signalName}`}
                      className="mono"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {run.signalName}
                    </Link>
                  </td>
                  <td
                    style={{
                      color: "var(--rust)",
                      fontSize: "0.8125rem",
                      fontFamily: "var(--font-mono)",
                      maxWidth: "300px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={run.error ?? ""}
                  >
                    {run.error ? (run.error.length > 60 ? run.error.slice(0, 60) + "..." : run.error) : "-"}
                  </td>
                  <td><RelativeTime date={run.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {events.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-label">Live Activity</div>
          <div style={{ marginTop: "0.75rem" }}>
            {events.slice(0, 20).map((event, i) => {
              const signalName =
                (event.data.run as Record<string, unknown>)?.signalName ??
                (event.data as Record<string, unknown>).signalName ??
                null;
              const runId =
                (event.data.run as Record<string, unknown>)?.id ??
                (event.data as Record<string, unknown>).runId ??
                null;
              const broadcastRunId =
                (event.data as Record<string, unknown>).broadcastRunId ?? null;

              const href = broadcastRunId
                ? `/broadcasts/${broadcastRunId}`
                : runId
                  ? `/runs/${runId}`
                  : null;

              return (
                <div
                  key={`${event.timestamp}-${i}`}
                  className={`reveal-item${href ? " activity-row" : ""}`}
                  style={{
                    animationDelay: `${i * 40}ms`,
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.75rem",
                    color: "var(--muted)",
                    padding: "0.375rem 0.5rem",
                    borderBottom: "1px solid var(--concrete-dark)",
                    display: "flex",
                    gap: "0.75rem",
                    alignItems: "baseline",
                  }}
                  onClick={href ? () => router.push(href) : undefined}
                >
                  <span style={{ color: "var(--rust)", minWidth: "120px" }}>{event.type}</span>
                  {signalName && (
                    <span style={{ color: "var(--charcoal)" }}>{String(signalName)}</span>
                  )}
                  <span style={{ marginLeft: "auto" }}>
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
