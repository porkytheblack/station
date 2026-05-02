"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useApi, type DynamicBroadcastSpec } from "../../../../../hooks/use-api";
import { useBreadcrumb } from "../../../../../hooks/use-breadcrumb";
import { ApiPanel } from "../../../../../components/api-panel";

export function VersionView({ name, version }: { name: string; version: number }) {
  const api = useApi();
  const [versions, setVersions] = useState<DynamicBroadcastSpec[]>([]);
  const [spec, setSpec] = useState<DynamicBroadcastSpec | null>(null);
  const [compareTo, setCompareTo] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useBreadcrumb(
    [
      { label: "Broadcasts", href: "/broadcasts" },
      { label: name, href: `/broadcasts/dyn/${encodeURIComponent(name)}` },
      { label: `v${version}` },
    ],
    "broadcasts",
  );

  useEffect(() => {
    Promise.all([
      api.getBroadcastDefinitionVersions(name),
      api.getBroadcastDefinition(name).then((r) => r.data, () => null),
    ])
      .then(([versionsRes]) => {
        setVersions(versionsRes.data);
        const found = versionsRes.data.find((v) => v.version === version);
        setSpec(found ?? null);
        // Default compare target = the version immediately before this one
        const prev = versionsRes.data.find((v) => v.version === version - 1);
        setCompareTo(prev?.version ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [name, version]);

  const compareSpec = useMemo(
    () => versions.find((v) => v.version === compareTo) ?? null,
    [versions, compareTo],
  );

  const diff = useMemo(() => {
    if (!spec || !compareSpec) return null;
    return computeDiff(stripVolatile(compareSpec), stripVolatile(spec));
  }, [spec, compareSpec]);

  if (loading) {
    return (
      <div>
        <h1 className="page-title">{name} v{version}</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!spec) {
    return (
      <div>
        <h1 className="page-title">{name} v{version}</h1>
        <div className="empty-state"><p className="empty-state-text">{error ?? "Version not found."}</p></div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          <span className="mono">{name}</span>
          <span style={{ marginLeft: "0.5rem", color: "var(--muted)", fontSize: "0.875rem" }}>v{version}</span>
          {spec.deletedAt && (
            <span style={{
              marginLeft: "0.75rem",
              fontSize: "0.6875rem",
              padding: "0.125rem 0.375rem",
              borderRadius: "3px",
              background: "var(--error-bg, #fee)",
              color: "var(--error, #b00)",
            }}>deleted</span>
          )}
        </h1>
        <Link href={`/broadcasts/dyn/${encodeURIComponent(name)}`} className="btn">Back to current</Link>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gap: "1rem",
        marginBottom: "1rem",
      }}>
        <div>
          <div className="mono" style={labelStyle}>Compare to</div>
          <select
            className="mono"
            value={compareTo ?? ""}
            onChange={(e) => setCompareTo(e.target.value ? Number(e.target.value) : null)}
            style={{
              width: "100%",
              padding: "0.5rem 0.625rem",
              border: "1px solid var(--border)",
              borderRadius: "4px",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: "0.875rem",
            }}
          >
            <option value="">— No comparison —</option>
            {versions
              .filter((v) => v.version !== version)
              .map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                  {v.deletedAt ? " (deleted)" : ""}
                  {" — "}
                  {new Date(v.updatedAt).toLocaleString()}
                </option>
              ))}
          </select>
        </div>
        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", alignSelf: "end" }}>
          {compareSpec
            ? `Diffing v${compareSpec.version} → v${spec.version}`
            : "Showing the spec as-saved (no diff)."}
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: compareSpec ? "minmax(0, 1fr) minmax(0, 1fr)" : "1fr",
        gap: "1rem",
      }}>
        {compareSpec && (
          <DiffPane title={`v${compareSpec.version}`} spec={compareSpec} highlight={diff?.removedLines ?? new Set()} side="left" />
        )}
        <DiffPane title={`v${spec.version}`} spec={spec} highlight={diff?.addedLines ?? new Set()} side="right" />
      </div>

      <ApiPanel
        title="Inspect this version"
        snippets={[
          {
            label: "Get this version",
            method: "GET",
            path: `/api/v1/broadcast-definitions/${encodeURIComponent(name)}/versions/${version}`,
          },
          {
            label: "List all versions",
            method: "GET",
            path: `/api/v1/broadcast-definitions/${encodeURIComponent(name)}/versions`,
          },
        ]}
      />
    </div>
  );
}

function DiffPane({
  title,
  spec,
  highlight,
  side,
}: {
  title: string;
  spec: DynamicBroadcastSpec;
  highlight: Set<number>;
  side: "left" | "right";
}) {
  const lines = JSON.stringify(stripVolatile(spec), null, 2).split("\n");
  return (
    <div>
      <div className="mono" style={labelStyle}>{title}</div>
      <pre className="mono" style={{
        margin: 0,
        padding: "0.5rem",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        fontSize: "0.75rem",
        lineHeight: 1.5,
        overflowX: "auto",
        maxHeight: "640px",
        overflowY: "auto",
      }}>
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              padding: "0 0.25rem",
              background: highlight.has(i)
                ? side === "left"
                  ? "rgba(196, 131, 74, 0.18)"
                  : "rgba(107, 153, 98, 0.18)"
                : "transparent",
              whiteSpace: "pre",
            }}
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

interface DiffResult {
  addedLines: Set<number>;
  removedLines: Set<number>;
}

/**
 * Line-level naive diff: marks lines unique to each side. Works well for the
 * small JSON specs typical of broadcast definitions; for larger specs a real
 * Myers diff would be better but is overkill here.
 */
function computeDiff(left: unknown, right: unknown): DiffResult {
  const leftLines = JSON.stringify(left, null, 2).split("\n");
  const rightLines = JSON.stringify(right, null, 2).split("\n");
  const leftSet = new Map<string, number[]>();
  for (let i = 0; i < leftLines.length; i++) {
    const list = leftSet.get(leftLines[i]);
    if (list) list.push(i);
    else leftSet.set(leftLines[i], [i]);
  }
  const rightSet = new Map<string, number[]>();
  for (let i = 0; i < rightLines.length; i++) {
    const list = rightSet.get(rightLines[i]);
    if (list) list.push(i);
    else rightSet.set(rightLines[i], [i]);
  }
  const addedLines = new Set<number>();
  const removedLines = new Set<number>();
  for (let i = 0; i < rightLines.length; i++) {
    const counterpart = leftSet.get(rightLines[i]);
    if (!counterpart || counterpart.length === 0) {
      addedLines.add(i);
    } else {
      counterpart.shift();
    }
  }
  for (let i = 0; i < leftLines.length; i++) {
    const counterpart = rightSet.get(leftLines[i]);
    if (!counterpart || counterpart.length === 0) {
      removedLines.add(i);
    } else {
      counterpart.shift();
    }
  }
  return { addedLines, removedLines };
}

function stripVolatile(spec: DynamicBroadcastSpec): Omit<DynamicBroadcastSpec, "createdAt" | "updatedAt" | "deletedAt" | "createdBy" | "version"> & { version: number } {
  const { createdAt: _c, updatedAt: _u, deletedAt: _d, createdBy: _b, ...rest } = spec;
  return rest;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: "0.375rem",
};
