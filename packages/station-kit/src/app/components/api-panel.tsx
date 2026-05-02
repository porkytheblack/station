"use client";

import { useState } from "react";

export interface ApiSnippet {
  label: string;
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface ApiPanelProps {
  title?: string;
  snippets: ApiSnippet[];
}

/**
 * Collapsible "API panel" that mirrors the actions available on the page as
 * `curl` commands. Lowers the barrier from "I clicked a button" to "I can
 * script this." Renders nothing if `snippets` is empty.
 */
export function ApiPanel({ title = "API equivalent", snippets }: ApiPanelProps) {
  const [open, setOpen] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  if (snippets.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{
        marginTop: "1.5rem",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "var(--surface)",
      }}
    >
      <summary
        style={{
          padding: "0.5rem 0.75rem",
          fontSize: "0.75rem",
          fontFamily: "var(--mono-font, monospace)",
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          cursor: "pointer",
          listStyle: "none",
        }}
      >
        ▸ {title}
      </summary>
      <div style={{ padding: "0.5rem 0.75rem 0.75rem" }}>
        {snippets.map((s, i) => {
          const cmd = toCurl(s);
          return (
            <div key={i} style={{ marginBottom: i === snippets.length - 1 ? 0 : "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                  {s.label}
                </div>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(cmd);
                      setCopiedIdx(i);
                      setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
                    } catch {
                      // ignore — user can select-and-copy manually
                    }
                  }}
                >
                  {copiedIdx === i ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="mono" style={{
                margin: 0,
                padding: "0.5rem 0.75rem",
                background: "var(--bg, #fff)",
                border: "1px solid var(--border)",
                borderRadius: "4px",
                fontSize: "0.75rem",
                overflowX: "auto",
                whiteSpace: "pre",
              }}>{cmd}</pre>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function toCurl(snippet: ApiSnippet): string {
  const queryParts: string[] = [];
  if (snippet.query) {
    for (const [k, v] of Object.entries(snippet.query)) {
      if (v === undefined) continue;
      queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  const path = `${snippet.path}${queryParts.length ? `?${queryParts.join("&")}` : ""}`;
  const lines: string[] = [];
  lines.push(`curl -X ${snippet.method} \\`);
  lines.push(`  https://your-station.example.com${path} \\`);
  lines.push(`  -H 'Authorization: Bearer sk_live_…' \\`);
  if (snippet.body !== undefined) {
    lines.push(`  -H 'Content-Type: application/json' \\`);
    const body = typeof snippet.body === "string" ? snippet.body : JSON.stringify(snippet.body, null, 2);
    lines.push(`  -d ${JSON.stringify(body)}`);
  } else {
    // Trim trailing backslash on the last line if there's no body.
    lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, "");
  }
  return lines.join("\n");
}
