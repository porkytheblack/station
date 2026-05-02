"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useApi } from "../../hooks/use-api";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { ScheduleForm, type ScheduleFormValue } from "../components/schedule-form";

const INITIAL: ScheduleFormValue = {
  kind: "signal",
  target: "",
  interval: "5m",
  input: "{}",
  enabled: true,
};

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
  );
}
