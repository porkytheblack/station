"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "../../hooks/use-api";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { ScheduleForm, type ScheduleFormValue } from "../components/schedule-form";
import { ApiPanel } from "../../components/api-panel";

const INITIAL: ScheduleFormValue = {
  kind: "signal",
  target: "",
  interval: "5m",
  input: "{}",
  enabled: true,
};

const INTERVAL_REGEX = /^(\d+)(ms|s|m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
};

function parseIntervalLocal(s: string): number | null {
  const m = INTERVAL_REGEX.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

export default function NewSchedulePage() {
  const api = useApi();
  const router = useRouter();
  const [value, setValue] = useState<ScheduleFormValue>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useBreadcrumb(
    [
      { label: "Schedules", href: "/schedules" },
      { label: "New" },
    ],
    "schedules",
  );

  // Compute the next 5 fire times locally so users can see the cadence
  // before saving.
  const previewFires = useMemo(() => {
    const ms = parseIntervalLocal(value.interval);
    if (ms === null || ms <= 0) return [];
    const now = Date.now();
    const out: string[] = [];
    for (let i = 1; i <= 5; i++) {
      out.push(new Date(now + ms * i).toISOString());
    }
    return out;
  }, [value.interval]);

  async function handleSave() {
    setError(null);
    if (!value.target) {
      setError("Target is required.");
      return;
    }
    let inputParsed: unknown = undefined;
    if (value.input.trim()) {
      try {
        inputParsed = JSON.parse(value.input);
      } catch (err) {
        setError(`Input JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    setBusy(true);
    try {
      const res = await api.createSchedule({
        kind: value.kind,
        target: value.target,
        interval: value.interval,
        input: inputParsed,
        enabled: value.enabled,
      });
      router.push(`/schedules/${res.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">New schedule</h1>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: "2rem" }}>
        <div>
          <ScheduleForm value={value} onChange={setValue} />

          {error && (
            <div style={{
              marginTop: "1rem",
              padding: "0.625rem 0.75rem",
              background: "var(--error-bg, #fee)",
              color: "var(--error, #b00)",
              border: "1px solid var(--error, #b00)",
              borderRadius: "4px",
              fontSize: "0.8125rem",
              maxWidth: "640px",
            }}>{error}</div>
          )}

          <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.5rem" }}>
            <button className="btn btn--primary" onClick={handleSave} disabled={busy}>
              {busy ? "Creating..." : "Create schedule"}
            </button>
            <button className="btn" onClick={() => router.push("/schedules")}>Cancel</button>
          </div>
        </div>

        <aside>
          <h3 className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.5rem" }}>
            Next fire times (preview)
          </h3>
          {previewFires.length === 0 ? (
            <div className="mono" style={{ fontSize: "0.75rem", color: "var(--error, #b00)" }}>
              Invalid interval. Use formats like &quot;30s&quot;, &quot;5m&quot;, &quot;1h&quot;, &quot;1d&quot;, &quot;1w&quot;.
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {previewFires.map((iso, i) => (
                <li key={i} className="mono" style={{
                  fontSize: "0.8125rem",
                  padding: "0.375rem 0",
                  borderBottom: "1px dashed var(--border)",
                  color: i === 0 ? "var(--text)" : "var(--muted)",
                }}>
                  {new Date(iso).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <ApiPanel
        title="Create this schedule"
        snippets={[
          {
            label: "POST /api/v1/schedules",
            method: "POST",
            path: "/api/v1/schedules",
            body: {
              kind: value.kind,
              target: value.target,
              interval: value.interval,
              enabled: value.enabled,
              input: tryParse(value.input),
            },
          },
        ]}
      />
    </div>
  );
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
