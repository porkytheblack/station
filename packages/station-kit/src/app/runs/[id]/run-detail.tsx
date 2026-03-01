"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useApi } from "../../hooks/use-api";
import { useStation } from "../../hooks/use-station";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { StatusBadge } from "../../components/status-badge";
import { StepTimeline } from "../../components/step-timeline";
import { JsonViewer } from "../../components/json-viewer";

interface LogEntry {
  runId: string;
  signalName: string;
  level: string;
  message: string;
  timestamp: string;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function computeDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "\u2014";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  return formatMs(ms);
}

export function RunDetail() {
  const params = useParams();
  const id = params.id as string;
  const api = useApi();
  const { events } = useStation();
  const [run, setRun] = useState<any>(null);
  const [steps, setSteps] = useState<any[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useBreadcrumb(
    run
      ? [
          { label: "Signals", href: "/signals" },
          { label: run.signalName, href: `/signals/${encodeURIComponent(run.signalName)}` },
          { label: `Run ${id.slice(0, 8)}` },
        ]
      : [{ label: "Signals", href: "/signals" }, { label: `Run ${id.slice(0, 8)}` }],
    "signals",
  );

  useEffect(() => {
    async function load() {
      try {
        const [runRes, stepsRes, logsRes] = await Promise.all([
          api.getRun(id),
          api.getRunSteps(id),
          api.getRunLogs(id),
        ]);
        setRun(runRes.data);
        setSteps(stepsRes.data);
        setLogs(logsRes.data);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error("Failed to load run:", err.message);
        }
      }
      setLoading(false);
    }
    load();
  }, [id]);

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    const eventRunId = (latest.data.run as Record<string, unknown>)?.id ?? (latest.data as Record<string, unknown>)?.runId;
    if (eventRunId === id) {
      if (latest.type === "log:output") {
        setLogs((prev) => [...prev, {
          runId: latest.data.runId as string,
          signalName: latest.data.signalName as string,
          level: latest.data.level as string,
          message: latest.data.message as string,
          timestamp: (latest.data.timestamp as string) ?? latest.timestamp,
        }]);
      } else {
        api.getRun(id).then((r) => setRun(r.data)).catch((e) => console.error("Failed to refresh run:", e));
        api.getRunSteps(id).then((r) => setSteps(r.data)).catch((e) => console.error("Failed to refresh steps:", e));
      }
    }
  }, [events.length, id]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await api.cancelRun(id);
      const res = await api.getRun(id);
      setRun(res.data);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("Cancel failed:", err.message);
      }
    }
    setCancelling(false);
  }

  function handleCopyId() {
    navigator.clipboard.writeText(run.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Run</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!run) {
    return (
      <div>
        <h1 className="page-title">Run</h1>
        <div className="empty-state">
          <p className="empty-state-text">Run not found.</p>
        </div>
      </div>
    );
  }

  const canCancel = run.status === "pending" || run.status === "running";

  return (
    <div>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <StatusBadge status={run.status} />
          <Link href={`/signals/${run.signalName}`} className="page-title" style={{ marginBottom: 0, textDecoration: "none" }}>
            {run.signalName}
          </Link>
        </div>
        <div className="page-header-actions">
          {canCancel && (
            <button className="btn btn--danger" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-label">Metadata</div>
        <div className="detail-grid">
          <span className="detail-label">ID</span>
          <span className="detail-value mono" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {run.id}
            <button
              onClick={handleCopyId}
              className="btn btn--sm"
              style={{
                fontSize: "0.625rem",
                padding: "0.125rem 0.375rem",
                lineHeight: 1.2,
              }}
            >
              {copied ? "copied" : "copy"}
            </button>
          </span>

          <span className="detail-label">Signal</span>
          <span className="detail-value">
            <Link href={`/signals/${run.signalName}`} className="mono meta-value--link">
              {run.signalName}
            </Link>
          </span>

          <span className="detail-label">Kind</span>
          <span className="detail-value">{run.kind}</span>

          <span className="detail-label">Attempts</span>
          <span className="detail-value">{run.attempts} of {run.maxAttempts}</span>

          <span className="detail-label">Timeout</span>
          <span className="detail-value mono">{run.timeout ? formatMs(run.timeout) : "\u2014"}</span>

          <span className="detail-label">Duration</span>
          <span className="detail-value mono">{computeDuration(run.startedAt, run.completedAt)}</span>

          <span className="detail-label">Created</span>
          <span className="detail-value mono">{run.createdAt}</span>

          <span className="detail-label">Started</span>
          <span className="detail-value mono">{run.startedAt ?? "\u2014"}</span>

          <span className="detail-label">Completed</span>
          <span className="detail-value mono">{run.completedAt ?? "\u2014"}</span>
        </div>
      </div>

      {run.error && (
        <div className="detail-section">
          <div className="detail-section-label">Error</div>
          <div className="error-block">{run.error}</div>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-label">Input</div>
        <JsonViewer data={run.input} />
      </div>

      {run.output && (
        <div className="detail-section">
          <div className="detail-section-label">Output</div>
          <JsonViewer data={run.output} />
        </div>
      )}

      {steps.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-label">Steps</div>
          <StepTimeline steps={steps} />
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-label">Logs</div>
        <div className="log-container">
          {logs.length === 0 ? (
            <div style={{
              padding: "1rem",
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
            }}>
              {run.status === "pending" ? "Waiting for execution..." : "No log output captured."}
            </div>
          ) : (
            logs.map((log, i) => (
              <div
                key={i}
                className="log-line"
                style={{
                  color: log.level === "stderr" ? "var(--rust)" : "var(--charcoal)",
                }}
              >
                <span className="log-timestamp">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="log-level" data-level={log.level}>
                  {log.level === "stderr" ? "ERR" : "OUT"}
                </span>
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
