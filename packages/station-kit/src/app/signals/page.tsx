"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi, type SignalMeta } from "../hooks/use-api";
import { useBreadcrumb } from "../hooks/use-breadcrumb";

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(0)}h`;
}

export default function SignalsPage() {
  const api = useApi();
  const router = useRouter();
  const [signals, setSignals] = useState<SignalMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useBreadcrumb([{ label: "Signals" }], "signals");

  useEffect(() => {
    api.getSignals()
      .then((res) => setSignals(res.data))
      .catch((err: unknown) => {
        if (err instanceof Error) {
          console.error("Failed to load signals:", err.message);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Signals</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (signals.length === 0) {
    return (
      <div>
        <h1 className="page-title">Signals</h1>
        <div className="empty-state">
          <p className="empty-state-text">No signals discovered.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Signals</h1>

      <table className="station-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Schedule</th>
            <th>Timeout</th>
            <th>Retries</th>
            <th>Steps</th>
          </tr>
        </thead>
        <tbody>
          {signals.map((signal, i) => (
            <tr
              key={signal.name}
              className="reveal-item clickable-row"
              style={{ animationDelay: `${i * 40}ms` }}
              onClick={() => router.push(`/signals/${encodeURIComponent(signal.name)}`)}
            >
              <td className="mono">{signal.name}</td>
              <td style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
                {signal.interval ? "recurring" : "trigger"}
              </td>
              <td className="mono" style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
                {signal.interval ?? "\u2014"}
              </td>
              <td className="mono" style={{ fontSize: "0.8125rem" }}>
                {formatMs(signal.timeout)}
              </td>
              <td className="mono" style={{ fontSize: "0.8125rem" }}>
                {signal.maxAttempts > 1 ? signal.maxAttempts - 1 : "0"}
              </td>
              <td className="mono" style={{ fontSize: "0.8125rem" }}>
                {signal.hasSteps ? signal.stepNames.length : "\u2014"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
