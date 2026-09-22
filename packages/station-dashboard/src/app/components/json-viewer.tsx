"use client";

import { useState, useCallback } from "react";

function renderValue(value: unknown, depth: number, expandAll: boolean): React.ReactNode {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "boolean") return <span className="json-boolean">{String(value)}</span>;
  if (typeof value === "number") return <span className="json-number">{value}</span>;
  if (typeof value === "string") return <span className="json-string">&quot;{value}&quot;</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>;
    if (!expandAll && depth > 3) {
      return <span>[{value.length} items]</span>;
    }
    return (
      <span>
        {"[\n"}
        {value.map((item, i) => (
          <span key={i}>
            {"  ".repeat(depth + 1)}
            {renderValue(item, depth + 1, expandAll)}
            {i < value.length - 1 ? "," : ""}
            {"\n"}
          </span>
        ))}
        {"  ".repeat(depth)}
        {"]"}
      </span>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span>{"{}"}</span>;
    if (!expandAll && depth > 3) {
      return <span>{`{${entries.length} keys}`}</span>;
    }
    return (
      <span>
        {"{\n"}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {"  ".repeat(depth + 1)}
            <span className="json-key">&quot;{key}&quot;</span>: {renderValue(val, depth + 1, expandAll)}
            {i < entries.length - 1 ? "," : ""}
            {"\n"}
          </span>
        ))}
        {"  ".repeat(depth)}
        {"}"}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

function getRawText(data: string): string {
  try {
    const parsed = JSON.parse(data);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return data;
  }
}

export function JsonViewer({ data, label }: { data: string | undefined | null; label?: string }) {
  const [expanded, setExpanded] = useState(true);
  const [expandAll, setExpandAll] = useState(true);
  const [copyLabel, setCopyLabel] = useState("copy");

  const handleCopy = useCallback(() => {
    if (!data) return;
    const text = getRawText(data);
    navigator.clipboard.writeText(text).then(() => {
      setCopyLabel("copied");
      setTimeout(() => setCopyLabel("copy"), 1500);
    }).catch(() => {
      setCopyLabel("failed");
      setTimeout(() => setCopyLabel("copy"), 1500);
    });
  }, [data]);

  if (!data) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = data;
  }

  const isDeep =
    typeof parsed === "object" &&
    parsed !== null &&
    JSON.stringify(parsed).length > 200;

  return (
    <div>
      {label && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: "0.75rem",
            color: "var(--muted)",
            padding: "0.25rem 0",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
          }}
        >
          {expanded ? "- " : "+ "}
          {label}
        </button>
      )}
      {expanded && (
        <pre className="json-viewer" style={{ position: "relative" }}>
          <button className="copy-btn" onClick={handleCopy} type="button">
            {copyLabel}
          </button>
          {isDeep && (
            <button
              onClick={() => setExpandAll(!expandAll)}
              style={{
                position: "absolute",
                top: "0.5rem",
                right: "4rem",
                background: "var(--wire)",
                border: "none",
                borderRadius: "3px",
                padding: "0.25rem 0.5rem",
                fontFamily: "var(--font-mono)",
                fontSize: "0.625rem",
                color: "var(--muted-light)",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
              type="button"
            >
              {expandAll ? "collapse" : "expand"}
            </button>
          )}
          {renderValue(parsed, 0, expandAll)}
        </pre>
      )}
    </div>
  );
}
