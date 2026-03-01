"use client";

import { useEffect, useState, useCallback } from "react";
import { useApi } from "../hooks/use-api";
import { useBreadcrumb } from "../hooks/use-breadcrumb";

interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsed: string | null;
  expiresAt: string | null;
  revoked: boolean;
}

const AVAILABLE_SCOPES = ["trigger", "read", "cancel", "admin"] as const;

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export default function SettingsPage() {
  const api = useApi();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(["trigger", "read"]);
  const [creating, setCreating] = useState(false);

  // Newly created key (shown once)
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Revoke confirmation
  const [revoking, setRevoking] = useState<string | null>(null);

  useBreadcrumb([{ label: "Settings" }], "settings");

  const loadKeys = useCallback(() => {
    api.getApiKeys()
      .then((res) => { setKeys(res.data); setError(null); })
      .catch((err: unknown) => {
        if (err instanceof Error) setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  async function handleCreate() {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const res = await api.createApiKey(newKeyName.trim(), newKeyScopes);
      setCreatedKey(res.data.key);
      setNewKeyName("");
      setNewKeyScopes(["trigger", "read"]);
      setShowCreate(false);
      setCopied(false);
      loadKeys();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
    }
    setCreating(false);
  }

  async function handleRevoke(id: string) {
    try {
      await api.revokeApiKey(id);
      setRevoking(null);
      loadKeys();
    } catch (err: unknown) {
      if (err instanceof Error) setError(err.message);
    }
  }

  function toggleScope(scope: string) {
    setNewKeyScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function copyKey() {
    if (!createdKey) return;
    await navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Settings</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  const activeKeys = keys.filter((k) => !k.revoked);
  const revokedKeys = keys.filter((k) => k.revoked);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title" style={{ marginBottom: 0 }}>Settings</h1>
      </div>

      {error && (
        <div className="detail-section" style={{ color: "var(--rust)", fontSize: "0.8125rem" }}>
          {error}
        </div>
      )}

      {/* Created key banner */}
      {createdKey && (
        <div className="detail-section" style={{
          background: "var(--patina)",
          color: "#fff",
          borderRadius: "6px",
          padding: "1rem 1.25rem",
          marginBottom: "1.5rem",
        }}>
          <div style={{ fontSize: "0.8125rem", fontWeight: 500, marginBottom: "0.5rem" }}>
            Key created. Copy it now — it won't be shown again.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <code style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.8125rem",
              background: "rgba(0,0,0,0.2)",
              padding: "0.375rem 0.625rem",
              borderRadius: "4px",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}>
              {createdKey}
            </code>
            <button
              className="btn btn--primary"
              onClick={copyKey}
              style={{ flexShrink: 0, minWidth: "5rem" }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              className="btn"
              onClick={() => setCreatedKey(null)}
              style={{ flexShrink: 0, color: "#fff", borderColor: "rgba(255,255,255,0.4)" }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="detail-section">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <div className="detail-section-label" style={{ marginBottom: 0 }}>API Keys</div>
          <button className="btn btn--primary" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "Cancel" : "Create key"}
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div style={{
            border: "1px solid var(--concrete-dark)",
            borderRadius: "6px",
            padding: "1rem",
            marginBottom: "1rem",
          }}>
            <div style={{ marginBottom: "0.75rem" }}>
              <label style={{ display: "block", fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.25rem", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Name
              </label>
              <input
                type="text"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Production App"
                style={{
                  width: "100%",
                  padding: "0.5rem 0.625rem",
                  fontFamily: "var(--font-body)",
                  fontSize: "0.875rem",
                  border: "1px solid var(--concrete-dark)",
                  borderRadius: "4px",
                  background: "var(--surface)",
                  color: "var(--charcoal)",
                }}
              />
            </div>
            <div style={{ marginBottom: "0.75rem" }}>
              <label style={{ display: "block", fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.5rem", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Scopes
              </label>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {AVAILABLE_SCOPES.map((scope) => (
                  <button
                    key={scope}
                    onClick={() => toggleScope(scope)}
                    className={`filter-btn${newKeyScopes.includes(scope) ? " filter-btn--active" : ""}`}
                  >
                    {scope}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="btn btn--primary"
              onClick={handleCreate}
              disabled={creating || !newKeyName.trim() || newKeyScopes.length === 0}
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        )}

        {/* Active keys */}
        {activeKeys.length === 0 && !showCreate ? (
          <div className="empty-state">
            <p className="empty-state-text">No API keys. Create one to enable remote triggers.</p>
          </div>
        ) : activeKeys.length > 0 ? (
          <table className="station-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeKeys.map((key, i) => (
                <tr key={key.id} className="reveal-item" style={{ animationDelay: `${i * 40}ms` }}>
                  <td style={{ fontWeight: 500 }}>{key.name}</td>
                  <td className="mono" style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{key.keyPrefix}...</td>
                  <td>
                    <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                      {key.scopes.map((s) => (
                        <span key={s} style={{
                          fontSize: "0.6875rem",
                          fontFamily: "var(--font-mono)",
                          padding: "0.125rem 0.375rem",
                          borderRadius: "3px",
                          background: "var(--concrete-dark)",
                          color: "var(--muted)",
                        }}>{s}</span>
                      ))}
                    </div>
                  </td>
                  <td style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{formatDate(key.createdAt)}</td>
                  <td style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>
                    {key.lastUsed ? timeSince(key.lastUsed) : "Never"}
                  </td>
                  <td>
                    {revoking === key.id ? (
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <button className="btn" onClick={() => handleRevoke(key.id)} style={{ color: "var(--rust)", borderColor: "var(--rust)", fontSize: "0.75rem" }}>
                          Confirm
                        </button>
                        <button className="btn" onClick={() => setRevoking(null)} style={{ fontSize: "0.75rem" }}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button className="btn" onClick={() => setRevoking(key.id)} style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {/* Revoked keys */}
        {revokedKeys.length > 0 && (
          <div style={{ marginTop: "1.5rem" }}>
            <div className="detail-section-label" style={{ color: "var(--muted)", fontSize: "0.6875rem" }}>Revoked</div>
            <table className="station-table" style={{ opacity: 0.5 }}>
              <tbody>
                {revokedKeys.map((key) => (
                  <tr key={key.id}>
                    <td style={{ textDecoration: "line-through" }}>{key.name}</td>
                    <td className="mono" style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{key.keyPrefix}...</td>
                    <td style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>{formatDate(key.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
