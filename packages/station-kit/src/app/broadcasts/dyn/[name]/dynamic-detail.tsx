"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useApi,
  type DynamicBroadcastSpec,
  type DynamicValidationResult,
  type SignalMeta,
} from "../../../hooks/use-api";
import { useBreadcrumb } from "../../../hooks/use-breadcrumb";
import { BroadcastBuilder } from "../../components/broadcast-builder";
import { SchemaForm } from "../../../components/schema-form";

export function DynamicBroadcastDetail({ name }: { name: string }) {
  const api = useApi();
  const router = useRouter();
  const [latest, setLatest] = useState<DynamicBroadcastSpec | null>(null);
  const [versions, setVersions] = useState<DynamicBroadcastSpec[]>([]);
  const [json, setJson] = useState("");
  const [validation, setValidation] = useState<DynamicValidationResult | null>(null);
  const [signals, setSignals] = useState<SignalMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [triggerInput, setTriggerInput] = useState("{}");
  const [lastRunId, setLastRunId] = useState<string | null>(null);

  useBreadcrumb(
    [
      { label: "Broadcasts", href: "/broadcasts" },
      { label: name },
    ],
    "broadcasts",
  );

  useEffect(() => {
    Promise.all([
      api.getBroadcastDefinition(name),
      api.getBroadcastDefinitionVersions(name).catch(() => ({ data: [] as DynamicBroadcastSpec[] })),
      api.getSignals().catch(() => ({ data: [] as SignalMeta[] })),
    ])
      .then(([latestRes, versionsRes, signalsRes]) => {
        setLatest(latestRes.data);
        setJson(JSON.stringify(stripMeta(latestRes.data), null, 2));
        setVersions(versionsRes.data);
        setSignals(signalsRes.data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [name]);

  async function handleValidate() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      setError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const res = await api.validateBroadcastDefinition(parsed as never);
      setValidation(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSave() {
    setError(null);
    setBusy(true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      setError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      return;
    }
    try {
      const res = await api.saveBroadcastDefinition(parsed as never);
      setLatest(res.data);
      const versionsRes = await api.getBroadcastDefinitionVersions(name);
      setVersions(versionsRes.data);
      setValidation({ ok: true, errors: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete dynamic broadcast "${name}"? Run history is retained.`)) return;
    try {
      await api.deleteBroadcastDefinition(name);
      router.push("/broadcasts");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleTrigger() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(triggerInput);
    } catch (err) {
      setError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const res = await api.triggerDynamicBroadcast(name, parsed);
      setLastRunId(res.data.id);
      setTriggerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">{name}</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!latest) {
    return (
      <div>
        <h1 className="page-title">{name}</h1>
        <div className="empty-state">
          <p className="empty-state-text">{error ?? "Not found."}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          <span className="mono">{name}</span>
          <span style={{ marginLeft: "0.5rem", color: "var(--muted)", fontSize: "0.875rem" }}>
            v{latest.version}
          </span>
        </h1>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="btn" onClick={() => setTriggerOpen(!triggerOpen)}>
            {triggerOpen ? "Cancel" : "Trigger"}
          </button>
          <button className="btn btn--danger" onClick={handleDelete}>Delete</button>
        </div>
      </div>

      {lastRunId && (
        <div style={{
          marginBottom: "0.75rem",
          padding: "0.5rem 0.75rem",
          background: "var(--success-bg, #efe)",
          color: "var(--success, #060)",
          borderRadius: "4px",
          fontSize: "0.8125rem",
        }}>
          Triggered run <button
            className="link mono"
            onClick={() => router.push(`/broadcasts/${name}/runs/${lastRunId}`)}
            style={{ background: "none", border: "none", color: "inherit", textDecoration: "underline", cursor: "pointer" }}
          >{lastRunId}</button>
        </div>
      )}

      {triggerOpen && (
        <div style={{ marginBottom: "1rem", padding: "0.75rem", border: "1px solid var(--border)", borderRadius: "4px" }}>
          <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.5rem" }}>
            Trigger input
          </div>
          <SchemaForm schema={null} value={triggerInput} onChange={setTriggerInput} />
          <div style={{ marginTop: "0.5rem" }}>
            <button className="btn btn--primary" onClick={handleTrigger}>Dispatch</button>
          </div>
        </div>
      )}

      <BroadcastBuilder
        json={json}
        onChange={setJson}
        validation={validation}
        signals={signals}
        onValidate={handleValidate}
        onSave={handleSave}
        saveLabel={busy ? "Saving..." : `Save (creates v${latest.version + 1})`}
        saving={busy}
        error={error}
      />

      {versions.length > 0 && (
        <section style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "0.875rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", marginBottom: "0.5rem" }}>
            Version history
          </h2>
          <table className="station-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Updated</th>
                <th>Author</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr
                  key={v.version}
                  className="clickable-row"
                  onClick={() => router.push(`/broadcasts/dyn/${encodeURIComponent(name)}/v/${v.version}`)}
                >
                  <td className="mono">v{v.version}</td>
                  <td className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                    {new Date(v.updatedAt).toLocaleString()}
                  </td>
                  <td className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                    {v.createdBy ?? "—"}
                  </td>
                  <td className="mono" style={{ fontSize: "0.75rem" }}>
                    {v.deletedAt ? <span style={{ color: "var(--error, #b00)" }}>deleted</span> : v.version === latest.version ? "current" : "archived"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function stripMeta(spec: DynamicBroadcastSpec): Record<string, unknown> {
  // The user only edits the durable shape; version/createdAt/etc. are server-managed.
  const { version: _v, createdAt: _c, updatedAt: _u, deletedAt: _d, createdBy: _b, ...rest } = spec;
  return rest;
}
