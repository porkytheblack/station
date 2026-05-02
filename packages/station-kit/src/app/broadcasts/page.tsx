"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApi, type BroadcastMeta, type DynamicBroadcastSpec } from "../hooks/use-api";
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
  const [definitions, setDefinitions] = useState<DynamicBroadcastSpec[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggerTarget, setTriggerTarget] = useState<string | null>(null);
  const [inputJson, setInputJson] = useState("{}");
  const [triggering, setTriggering] = useState(false);

  useBreadcrumb([{ label: "Broadcasts" }], "broadcasts");

  useEffect(() => {
    Promise.all([
      api.getBroadcasts().catch(() => ({ data: [] as BroadcastMeta[] })),
      api.getBroadcastDefinitions().catch(() => ({ data: [] as DynamicBroadcastSpec[] })),
    ])
      .then(([staticRes, dynamicRes]) => {
        setBroadcasts(staticRes.data);
        setDefinitions(dynamicRes.data);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleTrigger(name: string, isDynamic: boolean) {
    setTriggering(true);
    try {
      const input = JSON.parse(inputJson);
      if (isDynamic) {
        await api.triggerDynamicBroadcast(name, input);
      } else {
        await api.triggerBroadcast(name, input);
      }
      setTriggerTarget(null);
      setInputJson("{}");
    } catch (err: unknown) {
      if (err instanceof Error) console.error("Trigger failed:", err.message);
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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>Broadcasts</h1>
        <Link href="/broadcasts/new" className="btn btn--primary">+ New dynamic broadcast</Link>
      </div>

      <h2 style={{ fontSize: "0.875rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", marginTop: "1.5rem", marginBottom: "0.5rem" }}>
        File-defined ({broadcasts.length})
      </h2>
      {broadcasts.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-text">No file-defined broadcasts discovered.</p>
        </div>
      ) : (
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
                          {b.nodes.length} nodes / {b.failurePolicy} / {b.timeout !== null ? formatMs(b.timeout) : "—"}
                        </span>
                      </div>
                      <SchemaForm schema={null} value={inputJson} onChange={setInputJson} />
                      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
                        <button className="btn btn--primary" onClick={() => handleTrigger(b.name, false)} disabled={triggering}>
                          {triggering ? "Dispatching..." : "Dispatch"}
                        </button>
                        <button className="btn" onClick={() => toggleTrigger(b.name)}>Cancel</button>
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
                    {b.timeout !== null ? formatMs(b.timeout) : "—"}
                  </td>
                  <td>
                    <button
                      className="btn btn--sm btn--primary"
                      onClick={(e) => { e.stopPropagation(); toggleTrigger(b.name); }}
                    >Trigger</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h2 style={{ fontSize: "0.875rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", marginTop: "2rem", marginBottom: "0.5rem" }}>
        Dynamic ({definitions.length})
      </h2>
      {definitions.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-text">No dynamic broadcasts. <Link href="/broadcasts/new">Create one</Link>.</p>
        </div>
      ) : (
        <table className="station-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Version</th>
              <th>Nodes</th>
              <th>Failure Policy</th>
              <th>Timeout</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {definitions.map((d, i) => {
              const dynKey = `dyn:${d.name}`;
              const isOpen = triggerTarget === dynKey;
              return isOpen ? (
                <tr key={d.name} className="reveal-item" style={{ animationDelay: `${i * 40}ms` }}>
                  <td colSpan={6} style={{ padding: 0 }}>
                    <div style={{ padding: "0.75rem" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                        <span className="mono" style={{ fontWeight: 600 }}>{d.name}</span>
                        <span style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
                          v{d.version} / {d.nodes.length} nodes / {d.failurePolicy}
                        </span>
                      </div>
                      <SchemaForm schema={null} value={inputJson} onChange={setInputJson} />
                      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
                        <button className="btn btn--primary" onClick={() => handleTrigger(d.name, true)} disabled={triggering}>
                          {triggering ? "Dispatching..." : "Dispatch"}
                        </button>
                        <button className="btn" onClick={() => toggleTrigger(dynKey)}>Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr
                  key={d.name}
                  className="reveal-item clickable-row"
                  style={{ animationDelay: `${i * 40}ms` }}
                  onClick={() => router.push(`/broadcasts/dyn/${encodeURIComponent(d.name)}`)}
                >
                  <td className="mono">{d.name}</td>
                  <td className="mono">v{d.version}</td>
                  <td className="mono">{d.nodes.length}</td>
                  <td className="mono" style={{ color: "var(--muted)" }}>{d.failurePolicy}</td>
                  <td className="mono" style={{ fontSize: "0.8125rem" }}>
                    {d.timeout ? formatMs(d.timeout) : "—"}
                  </td>
                  <td>
                    <button
                      className="btn btn--sm btn--primary"
                      onClick={(e) => { e.stopPropagation(); toggleTrigger(dynKey); }}
                    >Trigger</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
