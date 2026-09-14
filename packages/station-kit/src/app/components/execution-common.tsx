"use client";

import { useId } from "react";
import type { ExecutionStation } from "../hooks/use-execution";

export function ExecutionOwner({ label, stations, owner, onChange, busy, refresh }: {
  label: string; stations: ExecutionStation[]; owner: string; onChange: (id: string) => void; busy: boolean; refresh: () => Promise<void>;
}) {
  const station = stations.find((node) => node.stationId === owner);
  const selectorId = useId();
  return <div className="execution-owner">
    <label className="execution-owner-label" htmlFor={selectorId}>{label}</label>
    <div className="execution-owner-controls">
      <select id={selectorId} className="input-text" aria-label={label} value={owner} disabled={busy} onChange={(event) => onChange(event.target.value)}>
        {!owner && <option value="">Select a station</option>}
        {owner && !station && <option value={owner}>{owner} · unavailable</option>}
        {stations.map((node) => <option key={node.stationId} value={node.stationId}>{node.name} · {node.status}{!node.available ? " · unavailable" : ""}</option>)}
      </select>
    <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>Refresh stations</button>
    <div className="execution-owner-status">
    {station?.backends && <span className="execution-note">{Object.values(station.backends).filter(Boolean).join(" · ")}</span>}
    {station && <span className={`status-badge status-${station.available ? station.status === "draining" ? "pending" : "completed" : "failed"}`}>{station.available ? station.status : "unavailable"}</span>}
    </div>
    </div>
  </div>;
}
export function ExecutionAlert({ error }: { error: string }) {
  return error ? <div className="execution-error" role="alert">{error}</div> : null;
}
export function OwnerNotice({ station }: { station?: ExecutionStation }) {
  if (!station?.available) return <p className="execution-note" role="status">This owner is unavailable. Its resources stay assigned to it; selecting another station will not move them.</p>;
  if (station.status === "draining") return <p className="execution-note" role="status">This station is draining. You can inspect and close existing resources, but cannot start new work.</p>;
  return null;
}
