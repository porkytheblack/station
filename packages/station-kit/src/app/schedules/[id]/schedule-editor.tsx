"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi, type Schedule } from "../../hooks/use-api";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { ScheduleForm, type ScheduleFormValue } from "../components/schedule-form";

export function ScheduleEditor({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [value, setValue] = useState<ScheduleFormValue | null>(null);
  const [previewFires, setPreviewFires] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useBreadcrumb(
    [
      { label: "Schedules", href: "/schedules" },
      { label: schedule?.target ?? id },
    ],
    "schedules",
  );

  useEffect(() => {
    api.getSchedule(id)
      .then((res) => {
        setSchedule(res.data);
        setValue({
          kind: res.data.kind,
          target: res.data.target,
          interval: res.data.interval,
          input: res.data.input !== undefined ? JSON.stringify(res.data.input, null, 2) : "{}",
          enabled: res.data.enabled,
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));

    api.previewSchedule(id, 5).then((res) => setPreviewFires(res.data.fires)).catch(() => {});
  }, [id]);

  async function handleSave() {
    if (!value) return;
    setError(null);
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
      const res = await api.updateSchedule(id, {
        interval: value.interval,
        input: inputParsed,
        enabled: value.enabled,
      });
      setSchedule(res.data);
      setSavedAt(Date.now());
      const preview = await api.previewSchedule(id, 5);
      setPreviewFires(preview.data.fires);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this schedule?")) return;
    try {
      await api.deleteSchedule(id);
      router.push("/schedules");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Schedule</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!schedule || !value) {
    return (
      <div>
        <h1 className="page-title">Schedule</h1>
        <div className="empty-state">
          <p className="empty-state-text">{error ?? "Not found."}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          <span className="mono">{schedule.target}</span>
        </h1>
        <button className="btn btn--danger" onClick={handleDelete}>Delete</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: "2rem" }}>
        <div>
          <ScheduleForm value={value} onChange={setValue} locked />

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

          <div style={{ marginTop: "1.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button className="btn btn--primary" onClick={handleSave} disabled={busy}>
              {busy ? "Saving..." : "Save"}
            </button>
            {savedAt && Date.now() - savedAt < 3000 && (
              <span className="mono" style={{ fontSize: "0.75rem", color: "var(--success, #060)" }}>Saved</span>
            )}
          </div>
        </div>

        <aside>
          <h3 className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "0.5rem" }}>
            Next fire times
          </h3>
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

          <h3 className="mono" style={{ fontSize: "0.75rem", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: "1.5rem", marginBottom: "0.5rem" }}>
            Last run
          </h3>
          <div className="mono" style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>
            {schedule.lastRunAt ? (
              <>
                <div>{new Date(schedule.lastRunAt).toLocaleString()}</div>
                {schedule.lastRunStatus && <div>status: {schedule.lastRunStatus}</div>}
                {schedule.lastRunId && <div>id: {schedule.lastRunId}</div>}
              </>
            ) : "Never run."}
          </div>
        </aside>
      </div>
    </div>
  );
}
