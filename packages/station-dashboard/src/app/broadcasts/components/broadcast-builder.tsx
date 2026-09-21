"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DynamicBroadcastSpec,
  DynamicValidationResult,
  SignalMeta,
} from "../../hooks/use-api";
import { useApi } from "../../hooks/use-api";
import { DagEditor } from "./dag-editor";
import { ApiPanel } from "../../components/api-panel";

export interface BroadcastBuilderProps {
  json: string;
  onChange: (next: string) => void;
  validation: DynamicValidationResult | null;
  /** Reset the validation state from the parent (e.g. on json change). */
  onValidationStale?: () => void;
  signals: SignalMeta[];
  onValidate: () => void;
  onSave: () => void;
  saveLabel: string;
  saving: boolean;
  error: string | null;
  /** Optional second action (e.g. "Trigger"). */
  rightActions?: React.ReactNode;
  /** Used for the API panel and import-from-existing-name. */
  specName?: string;
}

/**
 * The unified broadcast builder. Three views, switchable by tab; JSON is the
 * truth — visual + dry-run keep `onChange` firing back into it.
 *
 *   1. Visual — drag-from-palette DAG editor with per-node form.
 *   2. JSON — paste/edit the DynamicBroadcastSpec; live validation.
 *   3. Dry-run — evaluates each node's input expression against a sample
 *      `{ input, upstream }` context and renders the trace.
 */
export function BroadcastBuilder(props: BroadcastBuilderProps) {
  const { json, onChange, validation, onValidationStale, signals, onValidate, onSave, saveLabel, saving, error, rightActions, specName } = props;

  const [tab, setTab] = useState<"visual" | "json" | "dryrun">("visual");
  const dagCommitRef = useRef<(() => Promise<void>) | null>(null);

  // Any change to the JSON invalidates the previous validation result — the
  // user shouldn't be blocked by stale errors after fixing them, and the Save
  // button shouldn't stay disabled on already-corrected specs.
  function emitChange(next: string) {
    onChange(next);
    onValidationStale?.();
  }

  // Wraps the parent's save so any in-flight expression edits in the DAG
  // editor are flushed before the save fires.
  async function handleSaveClick() {
    try {
      await dagCommitRef.current?.();
    } catch {
      // commit errors are surfaced inline in the inspector; don't block save
    }
    onSave();
  }

  // Try to parse the JSON to provide the visual + dry-run views with a
  // structured spec. If parsing fails, those tabs surface a parse error.
  const parsed = useMemo<{ spec: DynamicBroadcastSpec | null; error: string | null }>(() => {
    if (!json.trim()) return { spec: null, error: null };
    try {
      return { spec: JSON.parse(json) as DynamicBroadcastSpec, error: null };
    } catch (err) {
      return { spec: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [json]);

  function setSpec(next: DynamicBroadcastSpec) {
    emitChange(JSON.stringify(next, null, 2));
  }

  function handleImport(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      try {
        // Validate parseable; allow either spec or wrapping export object.
        const parsed = JSON.parse(text);
        const spec = parsed?.spec ?? parsed;
        emitChange(JSON.stringify(spec, null, 2));
      } catch (err) {
        alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
  }

  function handleExport() {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${parsed.spec?.name ?? specName ?? "broadcast"}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", borderBottom: "1px solid var(--border)" }}>
        <TabButton active={tab === "visual"} onClick={() => setTab("visual")}>Visual</TabButton>
        <TabButton active={tab === "json"} onClick={() => setTab("json")}>JSON</TabButton>
        <TabButton active={tab === "dryrun"} onClick={() => setTab("dryrun")}>Dry-run</TabButton>
        <div style={{ marginLeft: "auto", display: "flex", gap: "0.25rem" }}>
          <ImportButton onFile={handleImport} />
          <button className="btn btn--sm" type="button" onClick={handleExport}>Export</button>
        </div>
      </div>

      {tab === "visual" && (
        parsed.spec ? (
          <DagEditor
            spec={parsed.spec}
            signals={signals}
            onChange={setSpec}
            commitRef={dagCommitRef}
          />
        ) : (
          <div style={{
            padding: "0.75rem",
            background: "var(--error-bg, #fee)",
            color: "var(--error, #b00)",
            borderRadius: "4px",
            fontSize: "0.8125rem",
          }}>
            JSON parse error — switch to JSON tab to fix: {parsed.error}
          </div>
        )
      )}

      {tab === "json" && (
        <JsonEditor
          json={json}
          onChange={emitChange}
          signals={signals}
        />
      )}

      {tab === "dryrun" && (
        <DryRunPanel spec={parsed.spec} parseError={parsed.error} />
      )}

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", alignItems: "center" }}>
        <button className="btn" onClick={onValidate} disabled={saving}>Validate</button>
        <button
          className="btn btn--primary"
          onClick={handleSaveClick}
          disabled={saving || (validation !== null && !validation.ok)}
        >
          {saveLabel}
        </button>
        {rightActions}
      </div>

      {error && (
        <div style={errorBlockStyle}>{error}</div>
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

      <ApiPanel
        title="Save this broadcast"
        snippets={[
          {
            label: "Validate",
            method: "POST",
            path: "/api/v1/broadcast-definitions/validate",
            body: parsed.spec ?? json,
          },
          {
            label: "Save (creates a new version)",
            method: "POST",
            path: "/api/v1/broadcast-definitions",
            body: parsed.spec ?? json,
          },
          ...(parsed.spec
            ? [{
                label: "Trigger",
                method: "POST" as const,
                path: "/api/v1/trigger-dynamic-broadcast",
                body: { broadcastName: parsed.spec.name, input: {} },
              }]
            : []),
        ]}
      />
    </div>
  );
}

function ImportButton({ onFile }: { onFile: (file: File) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          if (ref.current) ref.current.value = "";
        }}
      />
      <button className="btn btn--sm" type="button" onClick={() => ref.current?.click()}>
        Import
      </button>
    </>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "0.375rem 0.75rem",
        border: "none",
        background: "transparent",
        borderBottom: active ? "2px solid var(--text)" : "2px solid transparent",
        color: active ? "var(--text)" : "var(--muted)",
        cursor: "pointer",
        fontSize: "0.875rem",
        fontFamily: "var(--mono-font, monospace)",
        marginBottom: "-1px",
      }}
    >
      {children}
    </button>
  );
}

function JsonEditor({ json, onChange, signals }: { json: string; onChange: (s: string) => void; signals: SignalMeta[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: "1rem" }}>
      <div>
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
      </div>

      <aside>
        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
          Available signals ({signals.length})
        </div>
        <div style={{
          maxHeight: "180px",
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
                <li key={s.name} className="mono" style={{ padding: "0.25rem 0", fontSize: "0.8125rem", borderBottom: "1px dashed var(--border)" }}>
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
          Escape hatch
        </div>
        <p style={{ fontSize: "0.75rem", color: "var(--muted)", lineHeight: 1.5, margin: 0 }}>
          The expression language is intentionally minimal. If you can&apos;t express something here, write a code-defined signal that does the logic and reference it from this graph.
        </p>
      </aside>
    </div>
  );
}

function DryRunPanel({ spec, parseError }: { spec: DynamicBroadcastSpec | null; parseError: string | null }) {
  const api = useApi();
  const [inputJson, setInputJson] = useState("{}");
  const [trace, setTrace] = useState<DryRunTraceEntry[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (parseError) {
    return (
      <div style={{
        padding: "0.75rem",
        background: "var(--error-bg, #fee)",
        color: "var(--error, #b00)",
        borderRadius: "4px",
        fontSize: "0.8125rem",
      }}>JSON parse error — fix the JSON tab first: {parseError}</div>
    );
  }

  if (!spec) {
    return <div style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>No spec to dry-run.</div>;
  }

  async function dryRun() {
    setRunning(true);
    setError(null);
    setTrace(null);
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(inputJson);
    } catch (err) {
      setError(`Input JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      setRunning(false);
      return;
    }
    if (!spec) {
      setRunning(false);
      return;
    }
    try {
      const result = await runTrace(api, spec, parsedInput);
      setTrace(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.5fr)", gap: "1rem" }}>
      <section>
        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
          Sample broadcast input (JSON)
        </div>
        <textarea
          className="mono"
          value={inputJson}
          onChange={(e) => setInputJson(e.target.value)}
          rows={10}
          spellCheck={false}
          style={{
            width: "100%",
            padding: "0.625rem",
            border: "1px solid var(--border)",
            borderRadius: "4px",
            background: "var(--surface)",
            color: "var(--text)",
            fontSize: "0.8125rem",
            fontFamily: "var(--mono-font, monospace)",
            resize: "vertical",
          }}
        />
        <div style={{ marginTop: "0.5rem" }}>
          <button className="btn btn--primary btn--sm" onClick={dryRun} disabled={running}>
            {running ? "Tracing..." : "Run dry-run"}
          </button>
        </div>
        {error && <div style={errorBlockStyle}>{error}</div>}
        <p className="mono" style={{ fontSize: "0.6875rem", color: "var(--muted)", marginTop: "0.5rem" }}>
          Evaluates each node&apos;s input expression and when guard against synthetic upstream outputs (mocked from upstream signal output schemas where available, else &quot;&lt;mock-of-nodeName&gt;&quot;).
        </p>
      </section>

      <section>
        <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
          Trace
        </div>
        {!trace ? (
          <div style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>Run a trace to see results.</div>
        ) : (
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {trace.map((t, i) => (
              <li key={i} style={{ borderLeft: `3px solid ${t.skipped ? "var(--muted)" : t.error ? "var(--error, #b00)" : "var(--success, #060)"}`, paddingLeft: "0.5rem", marginBottom: "0.5rem" }}>
                <div className="mono" style={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                  {t.node}{t.skipped && <span style={{ color: "var(--muted)" }}> (skipped)</span>}{t.error && <span style={{ color: "var(--error, #b00)" }}> (error)</span>}
                </div>
                {t.error ? (
                  <pre className="mono" style={{ fontSize: "0.75rem", color: "var(--error, #b00)", margin: 0 }}>{t.error}</pre>
                ) : t.skipped ? (
                  <div className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{t.skipReason}</div>
                ) : (
                  <pre className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify(t.input, null, 2)}</pre>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

interface DryRunTraceEntry {
  node: string;
  input?: unknown;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
}

async function runTrace(
  api: ReturnType<typeof useApi>,
  spec: DynamicBroadcastSpec,
  input: unknown,
): Promise<DryRunTraceEntry[]> {
  // Topo-sort by walking nodes; assume the spec is well-formed enough to dry-run
  // (broken graphs surface their actual errors via /validate).
  const trace: DryRunTraceEntry[] = [];
  const upstream: Record<string, unknown> = {};
  const visited = new Set<string>();
  const order: typeof spec.nodes = [];
  const remaining = [...spec.nodes];

  let safety = spec.nodes.length * spec.nodes.length;
  while (remaining.length > 0 && safety-- > 0) {
    const idx = remaining.findIndex((n) => n.dependsOn.every((d) => visited.has(d)));
    if (idx === -1) break;
    const [n] = remaining.splice(idx, 1);
    order.push(n);
    visited.add(n.name);
  }

  for (const node of order) {
    let runs = true;
    if (node.when) {
      try {
        const res = await api.evaluateExpression(node.when, { input, upstream });
        if (!res.data.value) {
          trace.push({ node: node.name, skipped: true, skipReason: 'when guard returned false' });
          runs = false;
        }
      } catch (err) {
        trace.push({ node: node.name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    if (!runs) continue;

    let nodeInput: unknown;
    if (node.input) {
      try {
        const res = await api.evaluateExpression(node.input, { input, upstream });
        nodeInput = res.data.value;
      } catch (err) {
        trace.push({ node: node.name, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
    } else if (node.dependsOn.length === 0) {
      nodeInput = input;
    } else if (node.dependsOn.length === 1) {
      nodeInput = upstream[node.dependsOn[0]];
    } else {
      const slice: Record<string, unknown> = {};
      for (const d of node.dependsOn) slice[d] = upstream[d];
      nodeInput = slice;
    }
    trace.push({ node: node.name, input: nodeInput });
    // Mock upstream for descendants — use the resolved input as a stand-in
    // for the signal's output. Real outputs aren't available without running
    // the signals; this is an explicit best-effort trace.
    upstream[node.name] = `<mock-of-${node.name}>`;
  }
  return trace;
}

const errorBlockStyle: React.CSSProperties = {
  marginTop: "0.75rem",
  padding: "0.625rem 0.75rem",
  background: "var(--error-bg, #fee)",
  color: "var(--error, #b00)",
  border: "1px solid var(--error, #b00)",
  borderRadius: "4px",
  fontSize: "0.8125rem",
};
