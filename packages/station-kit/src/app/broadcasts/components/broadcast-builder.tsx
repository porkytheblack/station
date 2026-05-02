"use client";

import type { DynamicValidationResult, SignalMeta } from "../../hooks/use-api";

export interface BroadcastBuilderProps {
  json: string;
  onChange: (next: string) => void;
  validation: DynamicValidationResult | null;
  signals: SignalMeta[];
  onValidate: () => void;
  onSave: () => void;
  saveLabel: string;
  saving: boolean;
  error: string | null;
  /** Optional second action (e.g. "Trigger"). */
  rightActions?: React.ReactNode;
}

/**
 * JSON-editor-first builder for DynamicBroadcastSpec. The architecture vision
 * calls this Stage 1 — pasted JSON is the source of truth, with validation
 * surfaced inline. Stage 2 (visual DAG editor) sits on top of this same shape.
 */
export function BroadcastBuilder(props: BroadcastBuilderProps) {
  const { json, onChange, validation, signals, onValidate, onSave, saveLabel, saving, error, rightActions } = props;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: "1rem" }}>
      <div>
        <label
          className="mono"
          style={{ display: "block", fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.25rem" }}
        >
          DynamicBroadcastSpec (JSON)
        </label>
        <textarea
          className="mono code-input"
          value={json}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            width: "100%",
            minHeight: "420px",
            padding: "0.75rem",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            background: "var(--surface)",
            color: "var(--text)",
            fontSize: "0.8125rem",
            lineHeight: 1.5,
            fontFamily: "var(--mono-font, monospace)",
            resize: "vertical",
          }}
        />

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", alignItems: "center" }}>
          <button className="btn" onClick={onValidate} disabled={saving}>Validate</button>
          <button
            className="btn btn--primary"
            onClick={onSave}
            disabled={saving || (validation !== null && !validation.ok)}
          >
            {saveLabel}
          </button>
          {rightActions}
        </div>

        {error && (
          <div style={{
            marginTop: "0.75rem",
            padding: "0.625rem 0.75rem",
            background: "var(--error-bg, #fee)",
            color: "var(--error, #b00)",
            border: "1px solid var(--error, #b00)",
            borderRadius: "4px",
            fontSize: "0.8125rem",
          }}>
            {error}
          </div>
        )}

        {validation && (
          <div style={{
            marginTop: "0.75rem",
            padding: "0.625rem 0.75rem",
            background: validation.ok ? "var(--success-bg, #efe)" : "var(--error-bg, #fee)",
            color: validation.ok ? "var(--success, #060)" : "var(--error, #b00)",
            border: `1px solid ${validation.ok ? "var(--success, #060)" : "var(--error, #b00)"}`,
            borderRadius: "4px",
            fontSize: "0.8125rem",
          }}>
            {validation.ok ? (
              <span>Validation passed.</span>
            ) : (
              <div>
                <div style={{ marginBottom: "0.5rem", fontWeight: 600 }}>
                  {validation.errors.length} validation error{validation.errors.length === 1 ? "" : "s"}:
                </div>
                <ul style={{ margin: 0, paddingLeft: "1rem" }}>
                  {validation.errors.map((e, i) => (
                    <li key={i} className="mono" style={{ fontSize: "0.75rem" }}>
                      <strong>{e.node}{e.field ? `.${e.field}` : ""}</strong>: {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <aside>
        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
          Available signals ({signals.length})
        </div>
        <div style={{
          maxHeight: "420px",
          overflowY: "auto",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          padding: "0.5rem",
          background: "var(--surface)",
        }}>
          {signals.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>No signals registered.</div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {signals.map((s) => (
                <li
                  key={s.name}
                  className="mono"
                  style={{ padding: "0.25rem 0", fontSize: "0.8125rem", borderBottom: "1px dashed var(--border)" }}
                  title={s.filePath}
                >
                  {s.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "1rem", marginBottom: "0.5rem" }}>
          Expression refs
        </div>
        <ul style={{ margin: 0, paddingLeft: "1rem", fontSize: "0.75rem", color: "var(--muted)" }}>
          <li className="mono">input.foo — broadcast trigger input</li>
          <li className="mono">upstream.nodeName.field — output of an upstream node</li>
          <li className="mono">nodeName.field — shorthand for upstream</li>
        </ul>

        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "1rem", marginBottom: "0.5rem" }}>
          Expression AST kinds
        </div>
        <pre className="mono" style={{
          fontSize: "0.6875rem",
          color: "var(--muted)",
          background: "var(--surface)",
          padding: "0.5rem",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          overflow: "auto",
          margin: 0,
        }}>
{`{ kind: "ref", path: ["input", "x"] }
{ kind: "lit", value: 42 }
{ kind: "op", op: "==", args: [a, b] }
{ kind: "obj", entries: { k: expr } }
{ kind: "arr", items: [expr, ...] }
{ kind: "tmpl", parts: ["pre-", expr] }`}
        </pre>
      </aside>
    </div>
  );
}
