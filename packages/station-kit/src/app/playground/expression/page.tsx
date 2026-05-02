"use client";

import { useState } from "react";
import { useApi } from "../../hooks/use-api";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";

const STARTER_SOURCE = `input.amount > 100 && input.user.tier == "premium"`;
const STARTER_CONTEXT = JSON.stringify(
  {
    input: {
      amount: 250,
      user: { tier: "premium" },
    },
    upstream: {},
  },
  null,
  2,
);

export default function ExpressionPlaygroundPage() {
  const api = useApi();
  const [source, setSource] = useState(STARTER_SOURCE);
  const [contextJson, setContextJson] = useState(STARTER_CONTEXT);
  const [astJson, setAstJson] = useState<string>("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<unknown>(undefined);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [parseRunning, setParseRunning] = useState(false);
  const [evalRunning, setEvalRunning] = useState(false);

  useBreadcrumb(
    [
      { label: "Tools" },
      { label: "Expression playground" },
    ],
    "playground",
  );

  async function handleParse() {
    setParseError(null);
    setParseRunning(true);
    try {
      const res = await api.parseExpression(source);
      setAstJson(JSON.stringify(res.data.node, null, 2));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
      setAstJson("");
    } finally {
      setParseRunning(false);
    }
  }

  async function handleEvaluate() {
    setEvalError(null);
    setEvalResult(undefined);
    setEvalRunning(true);
    try {
      // First parse if AST is empty
      let node: unknown;
      if (astJson.trim()) {
        node = JSON.parse(astJson);
      } else {
        const parsed = await api.parseExpression(source);
        node = parsed.data.node;
        setAstJson(JSON.stringify(node, null, 2));
      }
      const ctx = JSON.parse(contextJson);
      const res = await api.evaluateExpression(node, ctx);
      setEvalResult(res.data.value);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err));
    } finally {
      setEvalRunning(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">Expression playground</h1>
      <p style={{ color: "var(--muted)", marginBottom: "1.5rem", fontSize: "0.875rem" }}>
        Pure, deterministic expressions used in dynamic broadcast `input` mappings and `when` guards.
        References resolve against `input.*` (broadcast trigger input) and `upstream.nodeName.*` (upstream outputs).
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
        <section>
          <Label>Expression source</Label>
          <textarea
            className="mono"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            rows={4}
            style={editorStyle}
          />
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
            <button className="btn" onClick={handleParse} disabled={parseRunning}>
              {parseRunning ? "Parsing..." : "Parse → AST"}
            </button>
            <button className="btn btn--primary" onClick={handleEvaluate} disabled={evalRunning}>
              {evalRunning ? "Evaluating..." : "Evaluate"}
            </button>
          </div>
          {parseError && (
            <div style={errorStyle}>
              {parseError}
            </div>
          )}
        </section>

        <section>
          <Label>Context (input + upstream)</Label>
          <textarea
            className="mono"
            value={contextJson}
            onChange={(e) => setContextJson(e.target.value)}
            spellCheck={false}
            rows={10}
            style={{ ...editorStyle, minHeight: "180px" }}
          />
        </section>
      </div>

      <section style={{ marginTop: "1.5rem" }}>
        <Label>Parsed AST</Label>
        <textarea
          className="mono"
          value={astJson}
          onChange={(e) => setAstJson(e.target.value)}
          spellCheck={false}
          rows={10}
          placeholder="// Click 'Parse' or paste an ExprNode JSON manually."
          style={{ ...editorStyle, minHeight: "180px" }}
        />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <Label>Result</Label>
        {evalError ? (
          <div style={errorStyle}>{evalError}</div>
        ) : evalResult === undefined ? (
          <div style={{ ...resultStyle, color: "var(--muted)" }}>—</div>
        ) : (
          <pre className="mono" style={resultStyle}>{JSON.stringify(evalResult, null, 2)}</pre>
        )}
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="mono" style={{
      display: "block",
      fontSize: "0.75rem",
      color: "var(--muted)",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      marginBottom: "0.25rem",
    }}>{children}</label>
  );
}

const editorStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.625rem 0.75rem",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "0.8125rem",
  lineHeight: 1.5,
  fontFamily: "var(--mono-font, monospace)",
  resize: "vertical",
};

const errorStyle: React.CSSProperties = {
  marginTop: "0.75rem",
  padding: "0.625rem 0.75rem",
  background: "var(--error-bg, #fee)",
  color: "var(--error, #b00)",
  border: "1px solid var(--error, #b00)",
  borderRadius: "4px",
  fontSize: "0.8125rem",
};

const resultStyle: React.CSSProperties = {
  padding: "0.625rem 0.75rem",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  fontSize: "0.8125rem",
  margin: 0,
  whiteSpace: "pre-wrap",
};
