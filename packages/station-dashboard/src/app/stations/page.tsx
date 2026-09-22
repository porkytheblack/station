"use client";

import { useEffect, useState } from "react";
import { ApiPanel } from "../components/api-panel";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { useApi, type StationNode } from "../hooks/use-api";

export default function StationsPage() {
  const api = useApi();
  const [stations, setStations] = useState<StationNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  useBreadcrumb([{ label: "Stations" }], "stations");

  const refresh = () => api.getStations().then((r) => setStations(r.data)).catch((e) => setError(String(e)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, []);

  return <div>
    <h1 className="page-title">Station Network</h1>
    <p style={{ color: "var(--muted)", marginBottom: "1.25rem" }}>
      Headquarters and execution stations registered in this network.
    </p>
    {error && <div className="empty-state"><p className="empty-state-text">{error}</p></div>}
    <table className="station-table">
      <thead><tr><th>Station</th><th>Role</th><th>Status</th><th>Capacity</th><th>Definitions</th><th>Last heartbeat</th><th></th></tr></thead>
      <tbody>{stations.map((s) => <tr key={s.id}>
        <td><div>{s.name}</div><div className="mono" style={{fontSize:"0.7rem",color:"var(--muted)"}}>{s.id}</div></td>
        <td className="mono">{s.role}</td>
        <td><span className={`status-badge status-${s.status === "online" ? "completed" : s.status === "draining" ? "pending" : "failed"}`}>{s.status}</span></td>
        <td className="mono">{s.capacity.activeRuns} / {s.capacity.maxConcurrent}</td>
        <td className="mono" style={{fontSize:"0.75rem"}}>{s.definitions.signals.length} signals · {s.definitions.broadcasts.length} broadcasts · {s.definitions.beacons.length} beacons</td>
        <td className="mono" style={{fontSize:"0.75rem",color:"var(--muted)"}}>{new Date(s.lastHeartbeatAt).toLocaleString()}</td>
        <td>{s.role !== "headquarters" && <button className="btn" onClick={async () => { await api.updateStationStatus(s.id, s.status === "draining" ? "online" : "draining"); await refresh(); }}>{s.status === "draining" ? "Resume" : "Drain"}</button>}</td>
      </tr>)}</tbody>
    </table>
    {!error && stations.length === 0 && <div className="empty-state"><p className="empty-state-text">No stations have registered.</p></div>}
    <ApiPanel title="Inspect the Station Network" snippets={[{label:"List stations",method:"GET",path:"/api/v1/stations"}]} />
  </div>;
}
