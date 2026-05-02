"use client";

import { useEffect, useState } from "react";
import { useApi, type ScheduleKind } from "../../hooks/use-api";

export interface ScheduleFormValue {
  kind: ScheduleKind;
  target: string;
  interval: string;
  input: string;
  enabled: boolean;
}

export interface ScheduleFormProps {
  value: ScheduleFormValue;
  onChange: (next: ScheduleFormValue) => void;
  /** When true, kind/target are locked (edit mode). */
  locked?: boolean;
}

export function ScheduleForm({ value, onChange, locked }: ScheduleFormProps) {
  const api = useApi();
  const [signalNames, setSignalNames] = useState<string[]>([]);
  const [staticBroadcastNames, setStaticBroadcastNames] = useState<string[]>([]);
  const [dynamicBroadcastNames, setDynamicBroadcastNames] = useState<string[]>([]);

  useEffect(() => {
    Promise.all([
      api.getSignals().catch(() => ({ data: [] })),
      api.getBroadcasts().catch(() => ({ data: [] })),
      api.getBroadcastDefinitions().catch(() => ({ data: [] })),
    ]).then(([sigs, stat, dyn]) => {
      setSignalNames(sigs.data.map((s) => s.name));
      setStaticBroadcastNames(stat.data.map((b) => b.name));
      setDynamicBroadcastNames(dyn.data.map((d) => d.name));
    });
  }, []);

  const targetOptions =
    value.kind === "signal"
      ? signalNames
      : value.kind === "broadcast-static"
        ? staticBroadcastNames
        : dynamicBroadcastNames;

  return (
    <div style={{ display: "grid", gap: "1rem", maxWidth: "640px" }}>
      <Field label="Kind">
        <select
          value={value.kind}
          disabled={locked}
          onChange={(e) => onChange({ ...value, kind: e.target.value as ScheduleKind, target: "" })}
          className="mono"
          style={selectStyle}
        >
          <option value="signal">signal</option>
          <option value="broadcast-static">broadcast-static</option>
          <option value="broadcast-dynamic">broadcast-dynamic</option>
        </select>
      </Field>

      <Field label="Target" hint={`${targetOptions.length} available`}>
        {locked ? (
          <input className="mono" value={value.target} readOnly style={inputStyle} />
        ) : (
          <input
            className="mono"
            value={value.target}
            list={`schedule-targets-${value.kind}`}
            onChange={(e) => onChange({ ...value, target: e.target.value })}
            placeholder="signal or broadcast name"
            style={inputStyle}
          />
        )}
        <datalist id={`schedule-targets-${value.kind}`}>
          {targetOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <Field label="Interval" hint='e.g. "30s", "5m", "1h", "1d"'>
        <input
          className="mono"
          value={value.interval}
          onChange={(e) => onChange({ ...value, interval: e.target.value })}
          placeholder="5m"
          style={inputStyle}
        />
      </Field>

      <Field label="Input (JSON)">
        <textarea
          className="mono"
          value={value.input}
          onChange={(e) => onChange({ ...value, input: e.target.value })}
          rows={6}
          spellCheck={false}
          style={{ ...inputStyle, fontFamily: "var(--mono-font, monospace)", fontSize: "0.8125rem" }}
        />
      </Field>

      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <span className="mono" style={{ fontSize: "0.875rem" }}>Enabled</span>
      </label>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.25rem" }}>
        <label className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{label}</label>
        {hint && <span className="mono" style={{ fontSize: "0.6875rem", color: "var(--muted)" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.625rem",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: "0.875rem",
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: "auto",
};
