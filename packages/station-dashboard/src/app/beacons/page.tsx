"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi, type BeaconListItem } from "../hooks/use-api";
import { useStation } from "../hooks/use-station";
import { useBreadcrumb } from "../hooks/use-breadcrumb";
import { StatusBadge } from "../components/status-badge";

/**
 * One badge for a whole beacon: the definition-owned instance's status if there
 * is one, otherwise "running" when any instance is up, else the first instance's
 * status. Beacons with no instances at all get no badge.
 */
function summaryStatus(b: BeaconListItem): BeaconListItem["instances"][number]["status"] | null {
  if (b.instance) return b.instance.status;
  if (b.runningCount > 0) return "running";
  return b.instances[0]?.status ?? null;
}

export default function BeaconsPage() {
  const api = useApi();
  const router = useRouter();
  const { events } = useStation();
  const [beacons, setBeacons] = useState<BeaconListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useBreadcrumb([{ label: "Beacons" }], "beacons");

  useEffect(() => {
    api.getBeacons()
      .then((res) => setBeacons(res.data))
      .catch((err: unknown) => {
        if (err instanceof Error) console.error("Failed to load beacons:", err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  // Live-refresh the list on any beacon lifecycle event.
  useEffect(() => {
    if (events.length === 0) return;
    if (!events[0].type.startsWith("beacon:")) return;
    api.getBeacons().then((res) => setBeacons(res.data)).catch(() => {});
  }, [events.length]);

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Beacons</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (beacons.length === 0) {
    return (
      <div>
        <h1 className="page-title">Beacons</h1>
        <div className="empty-state">
          <p className="empty-state-text">No beacons discovered.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="page-title">Beacons</h1>

      <table className="station-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Name</th>
            <th>Kind</th>
            <th>Start mode</th>
            <th>Instances</th>
            <th>Running</th>
            <th>Restarts</th>
          </tr>
        </thead>
        <tbody>
          {beacons.map((b, i) => (
            <tr
              key={b.name}
              className="reveal-item clickable-row"
              style={{ animationDelay: `${i * 40}ms` }}
              onClick={() => router.push(`/beacons/${encodeURIComponent(b.name)}`)}
            >
              <td>
                {summaryStatus(b) ? (
                  <StatusBadge status={summaryStatus(b)!} />
                ) : (
                  <span style={{ color: "var(--muted)" }}>{"—"}</span>
                )}
              </td>
              <td className="mono">{b.name}</td>
              <td style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>{b.mode ?? "—"}</td>
              <td className="mono" style={{ color: "var(--muted)", fontSize: "0.8125rem" }}>
                {b.startMode ?? "—"}
              </td>
              <td className="mono" style={{ fontSize: "0.8125rem" }}>{b.instanceCount}</td>
              <td className="mono" style={{ fontSize: "0.8125rem" }}>{b.runningCount}</td>
              <td className="mono" style={{ fontSize: "0.8125rem" }}>
                {b.instances.reduce((sum, i) => sum + i.restartCount, 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
