"use client";

import { useRouter } from "next/navigation";
import { StatusBadge } from "./status-badge";
import { RelativeTime } from "./relative-time";

interface Run {
  id: string;
  signalName: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

function duration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function truncateError(error: string | undefined, maxLen: number): string {
  if (!error) return "-";
  if (error.length <= maxLen) return error;
  return error.slice(0, maxLen) + "\u2026";
}

export function RunTable({ runs }: { runs: Run[] }) {
  const router = useRouter();

  if (runs.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-text">No runs recorded.</p>
      </div>
    );
  }

  return (
    <table className="station-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Signal</th>
          <th>Run ID</th>
          <th>Duration</th>
          <th>Created</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run, i) => (
          <tr
            key={run.id}
            className="reveal-item clickable-row"
            style={{ animationDelay: `${i * 40}ms` }}
            onClick={() => router.push(`/runs/${run.id}`)}
          >
            <td>
              <StatusBadge status={run.status as "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped"} />
            </td>
            <td className="mono">{run.signalName}</td>
            <td className="mono truncate" title={run.id}>
              {run.id.slice(0, 8)}
            </td>
            <td className="mono">{duration(run.startedAt, run.completedAt)}</td>
            <td>
              <RelativeTime date={run.createdAt} />
            </td>
            <td
              style={{
                color: run.error ? "var(--rust)" : "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.75rem",
                maxWidth: "200px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={run.error ?? undefined}
            >
              {truncateError(run.error, 60)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
