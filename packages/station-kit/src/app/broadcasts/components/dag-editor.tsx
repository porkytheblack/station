"use client";

import { useEffect, useMemo, useState } from "react";
import type { DynamicBroadcastSpec, DynamicNodeSpec, SignalMeta } from "../../hooks/use-api";
import { DAGView, type DagNode } from "../../components/dag-view";
import { useApi } from "../../hooks/use-api";

export interface DagEditorProps {
  spec: DynamicBroadcastSpec;
  onChange: (next: DynamicBroadcastSpec) => void;
  signals: SignalMeta[];
  /**
   * Optional: when provided, the dry-run panel becomes available — the
   * editor calls back so the parent can render trace results.
   */
  onDryRun?: (spec: DynamicBroadcastSpec) => void;
}

/**
 * Visual DAG editor for DynamicBroadcastSpec. Sits alongside the JSON editor
 * — the spec it produces flows back through `onChange` to keep the JSON view
 * in sync. Supports:
 *   - signal palette with click-to-add
 *   - per-node inline form (signalName, dependsOn, input expr, when expr)
 *   - dependency picker dropdown sourced from existing node names
 *   - inline expression validation via /v1/expressions/validate
 */
export function DagEditor({ spec, onChange, signals }: DagEditorProps) {
  const [selectedNode, setSelectedNode] = useState<string | null>(
    spec.nodes[0]?.name ?? null,
  );
  const api = useApi();

  const dagNodes: DagNode[] = useMemo(
    () =>
      spec.nodes.map((n) => ({
        name: n.name,
        signalName: n.signalName,
        dependsOn: n.dependsOn,
      })),
    [spec.nodes],
  );

  const selected = spec.nodes.find((n) => n.name === selectedNode) ?? null;

  function setNodes(updater: (prev: DynamicNodeSpec[]) => DynamicNodeSpec[]) {
    onChange({ ...spec, nodes: updater(spec.nodes) });
  }

  function addNodeForSignal(signal: SignalMeta) {
    const baseName = signal.name;
    let name = baseName;
    let suffix = 1;
    const existing = new Set(spec.nodes.map((n) => n.name));
    while (existing.has(name)) {
      name = `${baseName}_${++suffix}`;
    }
    const newNode: DynamicNodeSpec = {
      name,
      signalName: signal.name,
      dependsOn: spec.nodes.length > 0 ? [spec.nodes[spec.nodes.length - 1].name] : [],
    };
    setNodes((prev) => [...prev, newNode]);
    setSelectedNode(name);
  }

  function removeNode(name: string) {
    setNodes((prev) =>
      prev
        .filter((n) => n.name !== name)
        .map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => d !== name) })),
    );
    if (selectedNode === name) setSelectedNode(null);
  }

  function updateNode(name: string, patch: Partial<DynamicNodeSpec>) {
    setNodes((prev) =>
      prev.map((n) => {
        if (n.name !== name) return n;
        const next = { ...n, ...patch };
        // If renaming, rewrite all dependsOn references after this map step.
        return next;
      }),
    );
    if ("name" in patch && patch.name && patch.name !== name) {
      // Rewire dependencies that referenced the old name.
      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          dependsOn: n.dependsOn.map((d) => (d === name ? (patch.name as string) : d)),
        })),
      );
      setSelectedNode(patch.name);
    }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr 320px", gap: "1rem" }}>
      <SignalPalette signals={signals} onAdd={addNodeForSignal} />

      <div>
        <div className="mono" style={labelStyle}>DAG ({spec.nodes.length} nodes)</div>
        <div style={{
          minHeight: "320px",
          padding: "0.5rem",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          background: "var(--surface)",
          overflowX: "auto",
        }}>
          {spec.nodes.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: "0.875rem", textAlign: "center", padding: "2rem" }}>
              Click a signal in the palette to add the first node.
            </div>
          ) : (
            <DAGView
              nodes={dagNodes}
              selectedNode={selectedNode ?? undefined}
              onNodeClick={(name) => setSelectedNode(name)}
              compact
            />
          )}
        </div>
        <p className="mono" style={{ fontSize: "0.6875rem", color: "var(--muted)", marginTop: "0.375rem" }}>
          Click a node to edit it. Click a palette entry to add another node.
        </p>
      </div>

      <NodeInspector
        node={selected}
        allNodes={spec.nodes}
        onChange={(patch) => selected && updateNode(selected.name, patch)}
        onRemove={(name) => removeNode(name)}
        api={api}
      />
    </div>
  );
}

function SignalPalette({ signals, onAdd }: { signals: SignalMeta[]; onAdd: (s: SignalMeta) => void }) {
  const [filter, setFilter] = useState("");
  const visible = signals.filter((s) =>
    filter ? s.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );
  return (
    <aside>
      <div className="mono" style={labelStyle}>Signals ({signals.length})</div>
      <input
        className="mono"
        placeholder="Filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{
          ...inputStyle,
          marginBottom: "0.375rem",
          fontSize: "0.75rem",
        }}
      />
      <div style={{
        maxHeight: "360px",
        overflowY: "auto",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "var(--surface)",
      }}>
        {visible.length === 0 ? (
          <div style={{ padding: "0.5rem", fontSize: "0.75rem", color: "var(--muted)" }}>
            {signals.length === 0 ? "No signals registered." : "No matches."}
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {visible.map((s) => (
              <li key={s.name}>
                <button
                  className="mono"
                  type="button"
                  onClick={() => onAdd(s)}
                  title={s.filePath}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "0.375rem 0.5rem",
                    background: "transparent",
                    border: "none",
                    borderBottom: "1px dashed var(--border)",
                    color: "var(--text)",
                    fontSize: "0.8125rem",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-hover, rgba(0,0,0,0.04))";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                  }}
                >
                  + {s.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

interface NodeInspectorProps {
  node: DynamicNodeSpec | null;
  allNodes: DynamicNodeSpec[];
  onChange: (patch: Partial<DynamicNodeSpec>) => void;
  onRemove: (name: string) => void;
  api: ReturnType<typeof useApi>;
}

function NodeInspector({ node, allNodes, onChange, onRemove, api }: NodeInspectorProps) {
  const [inputSrc, setInputSrc] = useState<string>("");
  const [whenSrc, setWhenSrc] = useState<string>("");
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [whenErr, setWhenErr] = useState<string | null>(null);

  // Keep editor source in sync when the selected node changes.
  useEffect(() => {
    if (!node) {
      setInputSrc("");
      setWhenSrc("");
      return;
    }
    setInputSrc(node.input ? JSON.stringify(node.input, null, 2) : "");
    setWhenSrc(node.when ? JSON.stringify(node.when, null, 2) : "");
    setInputErr(null);
    setWhenErr(null);
  }, [node?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) {
    return (
      <aside>
        <div className="mono" style={labelStyle}>Inspector</div>
        <div style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>Select a node to edit.</div>
      </aside>
    );
  }

  const candidateDeps = allNodes.filter((n) => n.name !== node.name);

  async function tryCommitInput() {
    if (!inputSrc.trim()) {
      onChange({ input: undefined });
      setInputErr(null);
      return;
    }
    // Accept either JSON AST (preferred) or a parser source.
    try {
      const ast = JSON.parse(inputSrc);
      onChange({ input: ast });
      setInputErr(null);
      return;
    } catch {
      // fall through — try the parser
    }
    try {
      const res = await api.parseExpression(inputSrc);
      onChange({ input: res.data.node });
      setInputErr(null);
    } catch (err) {
      setInputErr(err instanceof Error ? err.message : String(err));
    }
  }

  async function tryCommitWhen() {
    if (!whenSrc.trim()) {
      onChange({ when: undefined });
      setWhenErr(null);
      return;
    }
    try {
      const ast = JSON.parse(whenSrc);
      onChange({ when: ast });
      setWhenErr(null);
      return;
    } catch {
      // fall through
    }
    try {
      const res = await api.parseExpression(whenSrc);
      onChange({ when: res.data.node });
      setWhenErr(null);
    } catch (err) {
      setWhenErr(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <aside style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div className="mono" style={labelStyle}>Node: {node.name}</div>

      <div>
        <Label>Node name</Label>
        <input
          className="mono"
          value={node.name}
          onChange={(e) => onChange({ name: e.target.value })}
          style={inputStyle}
        />
      </div>

      <div>
        <Label>Signal</Label>
        <div className="mono" style={{ fontSize: "0.8125rem" }}>{node.signalName}</div>
      </div>

      <div>
        <Label>Depends on</Label>
        <div style={{
          padding: "0.375rem",
          border: "1px solid var(--border)",
          borderRadius: "4px",
          background: "var(--surface)",
          minHeight: "40px",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.25rem",
        }}>
          {node.dependsOn.length === 0 ? (
            <span style={{ color: "var(--muted)", fontSize: "0.75rem", padding: "0.125rem" }}>
              (root node)
            </span>
          ) : (
            node.dependsOn.map((dep) => (
              <span
                key={dep}
                className="mono"
                style={{
                  fontSize: "0.75rem",
                  padding: "0.125rem 0.375rem",
                  background: "var(--text)",
                  color: "var(--surface)",
                  borderRadius: "3px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.25rem",
                }}
              >
                {dep}
                <button
                  type="button"
                  onClick={() => onChange({ dependsOn: node.dependsOn.filter((d) => d !== dep) })}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: "0.875rem", lineHeight: 1 }}
                  aria-label={`Remove ${dep}`}
                >×</button>
              </span>
            ))
          )}
        </div>
        <select
          className="mono"
          value=""
          onChange={(e) => {
            const dep = e.target.value;
            if (!dep) return;
            if (node.dependsOn.includes(dep)) return;
            onChange({ dependsOn: [...node.dependsOn, dep] });
            (e.target as HTMLSelectElement).value = "";
          }}
          style={{ ...inputStyle, marginTop: "0.375rem", fontSize: "0.75rem" }}
        >
          <option value="">+ Add dependency…</option>
          {candidateDeps
            .filter((c) => !node.dependsOn.includes(c.name))
            .map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
        </select>
      </div>

      <div>
        <Label>input mapper (expression source or AST JSON)</Label>
        <textarea
          className="mono"
          value={inputSrc}
          onChange={(e) => setInputSrc(e.target.value)}
          onBlur={tryCommitInput}
          rows={4}
          spellCheck={false}
          placeholder={`e.g. {"to": input.email}\nor: input.email`}
          style={{ ...inputStyle, fontSize: "0.75rem", fontFamily: "var(--mono-font, monospace)" }}
        />
        {inputErr && <ErrorBlurb>{inputErr}</ErrorBlurb>}
      </div>

      <div>
        <Label>when guard (boolean expression)</Label>
        <textarea
          className="mono"
          value={whenSrc}
          onChange={(e) => setWhenSrc(e.target.value)}
          onBlur={tryCommitWhen}
          rows={3}
          spellCheck={false}
          placeholder={`e.g. input.amount > 100`}
          style={{ ...inputStyle, fontSize: "0.75rem", fontFamily: "var(--mono-font, monospace)" }}
        />
        {whenErr && <ErrorBlurb>{whenErr}</ErrorBlurb>}
      </div>

      <button
        type="button"
        className="btn btn--danger btn--sm"
        onClick={() => onRemove(node.name)}
      >
        Remove node
      </button>
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="mono" style={{
      display: "block",
      fontSize: "0.6875rem",
      color: "var(--muted)",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      marginBottom: "0.25rem",
    }}>{children}</label>
  );
}

function ErrorBlurb({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: "0.25rem",
      fontSize: "0.6875rem",
      color: "var(--error, #b00)",
    }}>{children}</div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: "0.375rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.375rem 0.5rem",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "0.8125rem",
};
