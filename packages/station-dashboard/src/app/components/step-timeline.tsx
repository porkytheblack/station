"use client";

import { useState } from "react";
import { JsonViewer } from "./json-viewer";

interface Step {
  id: string;
  runId: string;
  name: string;
  status: string;
  input?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

function duration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function StepDetail({ step }: { step: Step }) {
  const [inputExpanded, setInputExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const hasInput = Boolean(step.input);
  const hasOutput = Boolean(step.output);
  const hasError = Boolean(step.error);

  if (!hasInput && !hasOutput && !hasError) return null;

  return (
    <div style={{ marginTop: "0.5rem" }}>
      {hasError && (
        <div className="error-block" style={{ marginBottom: hasInput || hasOutput ? "0.5rem" : 0 }}>
          {step.error}
        </div>
      )}
      {hasInput && (
        <div style={{ marginBottom: hasOutput ? "0.375rem" : 0 }}>
          <button
            onClick={() => setInputExpanded(!inputExpanded)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: "0.6875rem",
              color: "var(--muted)",
              padding: "0.125rem 0",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            {inputExpanded ? "- " : "+ "}input
          </button>
          {inputExpanded && <JsonViewer data={step.input} />}
        </div>
      )}
      {hasOutput && (
        <div>
          <button
            onClick={() => setOutputExpanded(!outputExpanded)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: "0.6875rem",
              color: "var(--muted)",
              padding: "0.125rem 0",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            {outputExpanded ? "- " : "+ "}output
          </button>
          {outputExpanded && <JsonViewer data={step.output} />}
        </div>
      )}
    </div>
  );
}

export function StepTimeline({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="step-timeline">
      {steps.map((step, i) => {
        const dur = duration(step.startedAt, step.completedAt);
        return (
          <div
            key={step.id}
            className="step-timeline-item reveal-item"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className={`step-timeline-dot step-timeline-dot--${step.status}`} />
            <div className="step-timeline-name">
              {step.name}
              {dur && (
                <span
                  style={{
                    marginLeft: "0.5rem",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6875rem",
                    color: "var(--muted)",
                  }}
                >
                  {dur}
                </span>
              )}
            </div>
            <div className="step-timeline-meta">
              {step.status}
              {step.startedAt && (
                <span style={{ marginLeft: "0.375rem", color: "var(--muted-light)" }}>
                  {new Date(step.startedAt).toLocaleTimeString()}
                </span>
              )}
            </div>
            <StepDetail step={step} />
          </div>
        );
      })}
    </div>
  );
}
