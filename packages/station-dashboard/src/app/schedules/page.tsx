"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi, type Schedule } from "../hooks/use-api";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { ApiPanel } from "../components/api-panel";

const KIND_LABEL: Record<Schedule["kind"], string> = {
  signal: "Signal",
  "broadcast-static": "Broadcast (file)",
  "broadcast-dynamic": "Broadcast (dynamic)",
};

export default function SchedulesPage() {
  const api = useApi();
  const router = useRouter();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useBreadcrumb([{ label: "Schedules" }], "schedules");

  useEffect(() => {
    api.getSchedules()
      .then((res) => setSchedules(res.data))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Schedules</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>Schedules</h1>
        <Link href="/schedules/new" className="btn btn--primary">+ New schedule</Link>
      </div>

      {error && (
        <div style={{
          marginBottom: "1rem",
          padding: "0.625rem 0.75rem",
          background: "var(--error-bg, #fee)",
          color: "var(--error, #b00)",
          borderRadius: "4px",
          fontSize: "0.8125rem",
        }}>{error}</div>
      )}

      {schedules.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-text">
            No schedules yet. <Link href="/schedules/new">Create one</Link> to fire signals or broadcasts on intervals.
          </p>
        </div>
      ) : (
        <table className="station-table">
          <thead>
            <tr>
              <th>Target</th>
              <th>Kind</th>
              <th>Interval</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr
                key={s.id}
                className="clickable-row"
                onClick={() => router.push(`/schedules/${s.id}`)}
              >
                <td className="mono">{s.target}</td>
                <td className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{KIND_LABEL[s.kind]}</td>
                <td className="mono">{s.interval ?? `${s.cron} (${s.timezone ?? "UTC"})`}</td>
                <td className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                  {new Date(s.nextRunAt).toLocaleString()}
                </td>
                <td className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                  {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "—"}
                </td>
                <td className="mono" style={{ fontSize: "0.75rem" }}>
                  <span style={{
                    padding: "0.125rem 0.375rem",
                    borderRadius: "3px",
                    background: s.enabled ? "var(--success-bg, #efe)" : "var(--surface)",
                    color: s.enabled ? "var(--success, #060)" : "var(--muted)",
                  }}>
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ApiPanel
        title="List & manage schedules"
        snippets={[
          { label: "List all", method: "GET", path: "/api/v1/schedules" },
          { label: "List by kind", method: "GET", path: "/api/v1/schedules", query: { kind: "signal" } },
          {
            label: "Create",
            method: "POST",
            path: "/api/v1/schedules",
            body: { kind: "signal", target: "<signalName>", interval: "5m", enabled: true, input: {} },
          },
        ]}
      />
    </div>
  );
}
