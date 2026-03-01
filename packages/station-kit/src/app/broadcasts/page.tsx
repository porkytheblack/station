"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi, type BroadcastMeta } from "../hooks/use-api";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { SchemaForm } from "../components/schema-form";

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}m`;
  return `${(ms / 3_600_000).toFixed(0)}h`;
}

export default function BroadcastsPage() {
  const api = useApi();
  const router = useRouter();
  const [broadcasts, setBroadcasts] = useState<BroadcastMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggerTarget, setTriggerTarget] = useState<string | null>(null);
  const [inputJson, setInputJson] = useState("{}");
  const [triggering, setTriggering] = useState(false);

  useBreadcrumb([{ label: "Broadcasts" }], "broadcasts");

  useEffect(() => {
    api.getBroadcasts()
      .then((res) => setBroadcasts(res.data))
      .catch((err: unknown) => {
        if (err instanceof Error) {
          console.error("Failed to load broadcasts:", err.message);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleTrigger(name: string) {
    setTriggering(true);
    try {
      const input = JSON.parse(inputJson);
      await api.triggerBroadcast(name, input);
      setTriggerTarget(null);
      setInputJson("{}");
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("Trigger failed:", err.message);
      }
    }
    setTriggering(false);
  }

  function toggleTrigger(name: string) {
    if (triggerTarget === name) {
      setTriggerTarget(null);
      setInputJson("{}");
    } else {
      setTriggerTarget(name);
      setInputJson("{}");
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Broadcasts</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (broadcasts.length === 0) {
    return (
      <div>
        <h1 className="page-title">Broadcasts</h1>
        <div className="empty-state">
          <p className="empty-state-text">No broadcasts discovered.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Broadcasts</h1>

      <table className="station-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Nodes</th>
            <th>Failure Policy</th>
            <th>Timeout</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {broadcasts.map((b, i) => {
            const isOpen = triggerTarget === b.name;
            return isOpen ? (
              <tr key={b.name} className="reveal-item" style={{ animationDelay: `${i * 40}ms` }}>
                <td colSpan={5} style={{ padding: 0 }}>
                  <div style={{ padding: "0.75rem" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                      <span className="mono" style={{ fontWeight: 600 }}>{b.name}</span>
                      <span style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
                        {b.nodes.length} nodes / {b.failurePolicy} / {b.timeout !== null ? formatMs(b.timeout) : "\u2014"}
                      </span>
                    </div>
                    <SchemaForm
                      schema={null}
                      value={inputJson}
                      onChange={setInputJson}
                    />
                    <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
                      <button
                        className="btn btn--primary"
                        onClick={() => handleTrigger(b.name)}
                        disabled={triggering}
                      >
                        {triggering ? "Dispatching..." : "Dispatch"}
                      </button>
                      <button className="btn" onClick={() => toggleTrigger(b.name)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            ) : (
              <tr
                key={b.name}
                className="reveal-item clickable-row"
                style={{ animationDelay: `${i * 40}ms` }}
                onClick={() => router.push(`/broadcasts/${encodeURIComponent(b.name)}`)}
              >
                <td className="mono">{b.name}</td>
                <td className="mono">{b.nodes.length}</td>
                <td className="mono" style={{ color: "var(--muted)" }}>{b.failurePolicy}</td>
                <td className="mono" style={{ fontSize: "0.8125rem" }}>
                  {b.timeout !== null ? formatMs(b.timeout) : "\u2014"}
                </td>
                <td>
                  <button
                    className="btn btn--sm btn--primary"
                    onClick={(e) => { e.stopPropagation(); toggleTrigger(b.name); }}
                  >
                    Trigger
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
