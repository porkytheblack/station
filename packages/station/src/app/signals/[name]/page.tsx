"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useApi, type SignalMeta, type SchemaField } from "../../hooks/use-api";
import { useStation } from "../../hooks/use-station";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { RunTable } from "../../components/run-table";
import { SchemaForm } from "../../components/schema-form";

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(0)}h`;
}

function renderSchemaInline(schema: SchemaField): string {
  if (schema.type === "object" && schema.properties) {
    const fields = Object.entries(schema.properties)
      .map(([key, field]) => `${key}: ${field.type}${field.required ? "" : "?"}`)
      .join(", ");
    return `{ ${fields} }`;
  }
  if (schema.type === "array" && schema.items) {
    return `${renderSchemaInline(schema.items)}[]`;
  }
  if (schema.type === "enum" && schema.values) {
    return schema.values.map((v) => `"${v}"`).join(" | ");
  }
  return schema.type;
}

const STATUS_FILTERS = ["all", "completed", "failed", "running", "pending"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export default function SignalDetailPage() {
  const params = useParams();
  const name = params.name as string;
  const decodedName = decodeURIComponent(name);
  const api = useApi();
  const { events } = useStation();

  const [signal, setSignal] = useState<SignalMeta | null>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [inputJson, setInputJson] = useState("{}");
  const [filter, setFilter] = useState<StatusFilter>("all");

  useBreadcrumb(
    [{ label: "Signals", href: "/signals" }, { label: decodedName }],
    "signals",
  );

  const loadRuns = useCallback(() => {
    api.getSignalRuns(name).then((r) => setRuns(r.data)).catch(() => {});
  }, [name]);

  useEffect(() => {
    async function load() {
      try {
        const [signalRes, runsRes] = await Promise.all([
          api.getSignal(name),
          api.getSignalRuns(name),
        ]);
        setSignal(signalRes.data);
        setRuns(runsRes.data);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error("Failed to load signal:", err.message);
        }
      }
      setLoading(false);
    }
    load();
  }, [name]);

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (latest.type.startsWith("run:")) {
      const eventSignal =
        (latest.data.run as Record<string, unknown>)?.signalName ??
        (latest.data as Record<string, unknown>).signalName;
      if (eventSignal === decodedName) {
        loadRuns();
      }
    }
  }, [events.length, decodedName, loadRuns]);

  async function handleTrigger() {
    setTriggering(true);
    try {
      const input = JSON.parse(inputJson);
      await api.triggerSignal(name, input);
      setInputJson("{}");
      setTimeout(loadRuns, 300);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("Trigger failed:", err.message);
      }
    }
    setTriggering(false);
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">{decodedName}</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!signal) {
    return (
      <div>
        <h1 className="page-title">{decodedName}</h1>
        <div className="empty-state">
          <p className="empty-state-text">Signal not found.</p>
        </div>
      </div>
    );
  }

  const hasSchema = signal.inputSchema !== null || signal.outputSchema !== null;
  const filteredRuns = filter === "all" ? runs : runs.filter((r) => r.status === filter);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title" style={{ marginBottom: 0 }}>{decodedName}</h1>
        <div className="page-header-actions">
          <button className="btn btn--primary" onClick={handleTrigger} disabled={triggering}>
            {triggering ? "Dispatching..." : "Trigger"}
          </button>
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-label">Configuration</div>
        <div className="config-grid">
          <div className="config-item">
            <span className="config-item-label">Schedule</span>
            <span className="config-item-value">{signal.interval ?? "Manual trigger"}</span>
          </div>
          <div className="config-item">
            <span className="config-item-label">Timeout</span>
            <span className="config-item-value">{formatMs(signal.timeout)}</span>
          </div>
          <div className="config-item">
            <span className="config-item-label">Max Attempts</span>
            <span className="config-item-value">{signal.maxAttempts}</span>
          </div>
          <div className="config-item">
            <span className="config-item-label">Max Concurrency</span>
            <span className="config-item-value">{signal.maxConcurrency ?? "\u2014"}</span>
          </div>
          <div className="config-item">
            <span className="config-item-label">Steps</span>
            <span className="config-item-value">
              {signal.hasSteps ? signal.stepNames.join(", ") : "Single handler"}
            </span>
          </div>
        </div>
      </div>

      {hasSchema && (
        <div className="detail-section">
          <div className="detail-section-label">Schema</div>
          <div className="schema-pair">
            <div>
              <div style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--muted)",
                marginBottom: "0.5rem",
              }}>
                Input
              </div>
              {signal.inputSchema ? (
                <pre className="json-viewer" style={{ fontSize: "0.75rem" }}>
                  {renderSchemaInline(signal.inputSchema)}
                </pre>
              ) : (
                <span style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>None</span>
              )}
            </div>
            <div>
              <div style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.6875rem",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: "var(--muted)",
                marginBottom: "0.5rem",
              }}>
                Output
              </div>
              {signal.outputSchema ? (
                <pre className="json-viewer" style={{ fontSize: "0.75rem" }}>
                  {renderSchemaInline(signal.outputSchema)}
                </pre>
              ) : (
                <span style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>None</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-label">Trigger</div>
        <SchemaForm
          schema={signal.inputSchema}
          value={inputJson}
          onChange={setInputJson}
        />
        <div style={{ marginTop: "0.5rem" }}>
          <button
            className="btn btn--primary"
            onClick={handleTrigger}
            disabled={triggering}
          >
            {triggering ? "Dispatching..." : "Dispatch"}
          </button>
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-label">Run History</div>
        <div className="filter-bar">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f}
              className={`filter-btn${filter === f ? " filter-btn--active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <RunTable runs={filteredRuns} />
      </div>
    </div>
  );
}
