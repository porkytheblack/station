"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  useApi,
  type EnvVar,
  type EnvTarget,
  type EnvTargetKind,
  type SignalMeta,
  type BeaconListItem,
} from "../hooks/use-api";
import { useBreadcrumb } from "../hooks/use-breadcrumb";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.625rem",
  fontFamily: "var(--font-body)",
  fontSize: "0.875rem",
  border: "1px solid var(--concrete-dark)",
  borderRadius: "4px",
  background: "var(--surface)",
  color: "var(--charcoal)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  color: "var(--muted)",
  marginBottom: "0.25rem",
  fontFamily: "var(--font-mono)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function targetKey(t: EnvTarget): string {
  return `${t.kind}:${t.name}`;
}

function describeScope(targets: EnvTarget[]): string {
  if (targets.length === 0) return "Global";
  return targets.map((t) => `${t.name}`).join(", ");
}

interface EnvFormState {
  key: string;
  value: string;
  secret: boolean;
  scope: "global" | "scoped";
  targets: EnvTarget[];
}

const EMPTY_FORM: EnvFormState = { key: "", value: "", secret: false, scope: "global", targets: [] };

export default function EnvironmentPage() {
  const api = useApi();
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [signals, setSignals] = useState<SignalMeta[]>([]);
  const [beacons, setBeacons] = useState<BeaconListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<EnvFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);

  useBreadcrumb([{ label: "Environment" }], "environment");

  const load = useCallback(() => {
    Promise.all([api.getEnvVars(), api.getSignals(), api.getBeacons()])
      .then(([v, s, b]) => {
        setVars(v.data);
        setSignals(s.data);
        setBeacons(b.data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error) setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Which keys each signal/beacon declares via `.env()` — surfaced so the
  // operator can see, at a glance, whether a required var is defined yet.
  const requiredByTarget = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of signals) {
      if (s.requiredEnv && s.requiredEnv.length > 0) map.set(`signal:${s.name}`, s.requiredEnv);
    }
    for (const b of beacons) {
      if (b.requiredEnv && b.requiredEnv.length > 0) map.set(`beacon:${b.name}`, b.requiredEnv);
    }
    return map;
  }, [signals, beacons]);

  // Keys satisfied by a global var or a var scoped to that exact target.
  const providedByTarget = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const ensure = (k: string) => { if (!map.has(k)) map.set(k, new Set()); return map.get(k)!; };
    for (const v of vars) {
      if (v.targets.length === 0) {
        for (const [tk] of requiredByTarget) ensure(tk).add(v.key);
      } else {
        for (const t of v.targets) ensure(targetKey(t)).add(v.key);
      }
    }
    return map;
  }, [vars, requiredByTarget]);

  const missingRequirements = useMemo(() => {
    const out: Array<{ target: string; keys: string[] }> = [];
    for (const [tk, keys] of requiredByTarget) {
      const provided = providedByTarget.get(tk) ?? new Set();
      const missing = keys.filter((k) => !provided.has(k));
      if (missing.length > 0) out.push({ target: tk, keys: missing });
    }
    return out;
  }, [requiredByTarget, providedByTarget]);

  function toggleTarget(kind: EnvTargetKind, name: string) {
    setForm((prev) => {
      const exists = prev.targets.some((t) => t.kind === kind && t.name === name);
      return {
        ...prev,
        targets: exists
          ? prev.targets.filter((t) => !(t.kind === kind && t.name === name))
          : [...prev.targets, { kind, name }],
      };
    });
  }

  async function handleCreate() {
    if (!form.key.trim()) return;
    setSaving(true);
    try {
      await api.createEnvVar({
        key: form.key.trim(),
        value: form.value,
        secret: form.secret,
        targets: form.scope === "global" ? [] : form.targets,
      });
      setForm(EMPTY_FORM);
      setShowCreate(false);
      setError(null);
      load();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
    }
    setSaving(false);
  }

  async function handleSaveEdit(id: string) {
    try {
      await api.updateEnvVar(id, { value: editValue });
      setEditingId(null);
      setEditValue("");
      setError(null);
      load();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteEnvVar(id);
      setDeleting(null);
      load();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Environment</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>Environment</h1>
        <button className="btn btn--primary" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "+ New variable"}
        </button>
      </div>

      <p style={{ fontSize: "0.8125rem", color: "var(--muted)", marginTop: 0, marginBottom: "1.25rem", maxWidth: "44rem" }}>
        Variables are injected into runs as <code className="mono">process.env</code>. Leave a variable
        global to feed every signal and beacon, or scope it to specific targets — a scoped variable
        overrides a global one with the same key. Signals and beacons can require a variable via
        <code className="mono"> .env(&quot;KEY&quot;)</code>; a run won&apos;t start until the value exists.
      </p>

      {error && (
        <div className="detail-section" style={{ color: "var(--rust)", fontSize: "0.8125rem" }}>
          {error}
        </div>
      )}

      {missingRequirements.length > 0 && (
        <div className="detail-section" style={{
          borderLeft: "3px solid var(--rust)",
          background: "var(--concrete)",
          marginBottom: "1.25rem",
        }}>
          <div className="detail-section-label" style={{ color: "var(--rust)" }}>Missing required variables</div>
          {missingRequirements.map((m) => (
            <div key={m.target} style={{ fontSize: "0.8125rem", marginTop: "0.375rem" }}>
              <span className="mono">{m.target}</span>
              {" needs "}
              {m.keys.map((k) => <span key={k} className="mono" style={{ color: "var(--rust)" }}>{k} </span>)}
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="detail-section" style={{ border: "1px solid var(--concrete-dark)", borderRadius: "6px", marginBottom: "1.25rem" }}>
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.75rem" }}>
            <div style={{ flex: "0 0 40%" }}>
              <label style={labelStyle}>Key</label>
              <input
                type="text"
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="STRIPE_API_KEY"
                className="mono"
                style={inputStyle}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Value</label>
              <input
                type={form.secret ? "password" : "text"}
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                placeholder="value"
                className="mono"
                style={inputStyle}
              />
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem", marginBottom: "0.75rem", cursor: "pointer" }}>
            <input type="checkbox" checked={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.checked })} />
            Secret (value is write-only — hidden after saving)
          </label>

          <div style={{ marginBottom: "0.75rem" }}>
            <label style={labelStyle}>Scope</label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                className={`filter-btn${form.scope === "global" ? " filter-btn--active" : ""}`}
                onClick={() => setForm({ ...form, scope: "global" })}
              >
                Global
              </button>
              <button
                className={`filter-btn${form.scope === "scoped" ? " filter-btn--active" : ""}`}
                onClick={() => setForm({ ...form, scope: "scoped" })}
              >
                Specific targets
              </button>
            </div>
          </div>

          {form.scope === "scoped" && (
            <div style={{ marginBottom: "0.75rem" }}>
              {signals.length > 0 && (
                <>
                  <label style={labelStyle}>Signals</label>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
                    {signals.map((s) => (
                      <button
                        key={s.name}
                        onClick={() => toggleTarget("signal", s.name)}
                        className={`filter-btn${form.targets.some((t) => t.kind === "signal" && t.name === s.name) ? " filter-btn--active" : ""}`}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {beacons.length > 0 && (
                <>
                  <label style={labelStyle}>Beacons</label>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {beacons.map((b) => (
                      <button
                        key={b.name}
                        onClick={() => toggleTarget("beacon", b.name)}
                        className={`filter-btn${form.targets.some((t) => t.kind === "beacon" && t.name === b.name) ? " filter-btn--active" : ""}`}
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {signals.length === 0 && beacons.length === 0 && (
                <p style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>No signals or beacons discovered.</p>
              )}
            </div>
          )}

          <button
            className="btn btn--primary"
            onClick={handleCreate}
            disabled={saving || !form.key.trim() || (form.scope === "scoped" && form.targets.length === 0)}
          >
            {saving ? "Saving..." : "Save variable"}
          </button>
        </div>
      )}

      {vars.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-text">No environment variables. Add one to feed values into your signals and beacons.</p>
        </div>
      ) : (
        <table className="station-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th>Scope</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vars.map((v, i) => (
              <tr key={v.id} className="reveal-item" style={{ animationDelay: `${i * 40}ms` }}>
                <td className="mono" style={{ fontWeight: 500 }}>{v.key}</td>
                <td className="mono" style={{ color: "var(--muted)", fontSize: "0.8125rem", maxWidth: "18rem" }}>
                  {editingId === v.id ? (
                    <input
                      type={v.secret ? "password" : "text"}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="mono"
                      style={{ ...inputStyle, padding: "0.25rem 0.5rem" }}
                      autoFocus
                    />
                  ) : v.secret ? (
                    <span style={{ letterSpacing: "0.15em" }}>••••••••</span>
                  ) : (
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block", maxWidth: "18rem", verticalAlign: "bottom" }}>
                      {v.value}
                    </span>
                  )}
                </td>
                <td style={{ fontSize: "0.8125rem" }}>
                  {v.targets.length === 0 ? (
                    <span style={{ fontSize: "0.6875rem", fontFamily: "var(--font-mono)", padding: "0.125rem 0.375rem", borderRadius: "3px", background: "var(--patina)", color: "#fff" }}>global</span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>{describeScope(v.targets)}</span>
                  )}
                </td>
                <td style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{formatDate(v.updatedAt)}</td>
                <td>
                  {editingId === v.id ? (
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button className="btn" onClick={() => handleSaveEdit(v.id)} style={{ fontSize: "0.75rem", color: "var(--patina)" }}>Save</button>
                      <button className="btn" onClick={() => { setEditingId(null); setEditValue(""); }} style={{ fontSize: "0.75rem" }}>Cancel</button>
                    </div>
                  ) : deleting === v.id ? (
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button className="btn" onClick={() => handleDelete(v.id)} style={{ fontSize: "0.75rem", color: "var(--rust)", borderColor: "var(--rust)" }}>Confirm</button>
                      <button className="btn" onClick={() => setDeleting(null)} style={{ fontSize: "0.75rem" }}>Cancel</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button className="btn" onClick={() => { setEditingId(v.id); setEditValue(v.secret ? "" : (v.value ?? "")); }} style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Edit</button>
                      <button className="btn" onClick={() => setDeleting(v.id)} style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Delete</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
