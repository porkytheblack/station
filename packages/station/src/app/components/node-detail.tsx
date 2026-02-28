"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StatusBadge } from "./status-badge";
import { JsonViewer } from "./json-viewer";

interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

interface NodeDetailProps {
  node: {
    id: string;
    broadcastRunId: string;
    nodeName: string;
    signalName: string;
    signalRunId?: string;
    status: string;
    skipReason?: string;
    input?: string;
    output?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
  };
  logs?: LogEntry[];
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

function CollapsibleSection({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="detail-section">
      <button
        className="collapsible-header"
        onClick={() => setOpen(!open)}
      >
        <span className="collapsible-chevron">{open ? "\u25BE" : "\u25B8"}</span>
        {label}
      </button>
      {open && <div className="collapsible-content">{children}</div>}
    </div>
  );
}

export function NodeDetail({ node, logs }: NodeDetailProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs?.length]);

  return (
    <div className="workflow-panel">
      <div className="node-detail-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className="node-detail-title">{node.nodeName}</span>
          <StatusBadge status={node.status as "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped"} />
        </div>
        <span className="node-detail-meta">
          {node.signalName} {"\u00B7"} {duration(node.startedAt, node.completedAt)}
        </span>
      </div>

      {node.status === "skipped" && node.skipReason && (
        <div className="detail-section">
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.8125rem",
              color: "var(--muted)",
              padding: "0.5rem 0",
            }}
          >
            Skipped: {node.skipReason}
          </div>
        </div>
      )}

      {node.error && (
        <div className="detail-section">
          <div className="error-block">{node.error}</div>
        </div>
      )}

      {/* Logs — primary content */}
      <div className="detail-section">
        <div className="detail-section-label">Logs</div>
        <div className="log-container" style={{ maxHeight: "none", minHeight: "120px" }}>
          {(!logs || logs.length === 0) ? (
            <div style={{
              padding: "1rem",
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
            }}>
              {node.status === "pending" ? "Waiting for execution..." :
               node.status === "skipped" ? "Node was skipped." :
               "No log output captured."}
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

      {/* Collapsible I/O */}
      {node.input && (
        <CollapsibleSection label="Input">
          <JsonViewer data={node.input} />
        </CollapsibleSection>
      )}

      {node.output && (
        <CollapsibleSection label="Output">
          <JsonViewer data={node.output} />
        </CollapsibleSection>
      )}

      {node.signalRunId && (
        <div className="detail-section" style={{ paddingTop: "0.25rem" }}>
          <Link href={`/runs/${node.signalRunId}`} className="meta-value--link" style={{ fontSize: "0.8125rem" }}>
            View signal run &rarr;
          </Link>
        </div>
      )}
    </div>
  );
}
