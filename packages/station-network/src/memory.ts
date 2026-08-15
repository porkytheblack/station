import type { StationNetworkAdapter, StationListFilter } from "./adapters.js";
import type { ControllerLease, StationHeartbeat, StationNode } from "./types.js";

function cloneStation(station: StationNode): StationNode {
  return {
    ...station,
    labels: { ...station.labels },
    capacity: { ...station.capacity },
    definitions: {
      signals: [...station.definitions.signals],
      broadcasts: [...station.definitions.broadcasts],
      beacons: [...station.definitions.beacons],
      beaconMetadata: station.definitions.beaconMetadata?.map((item) => ({
        ...item,
        requiredEnv: item.requiredEnv ? [...item.requiredEnv] : undefined,
      })),
    },
  };
}

export class StationNetworkMemoryAdapter implements StationNetworkAdapter {
  private stations = new Map<string, StationNode>();
  private leases = new Map<string, ControllerLease>();

  async upsertStation(station: StationNode): Promise<void> {
    this.stations.set(station.id, cloneStation(station));
  }

  async getStation(id: string): Promise<StationNode | null> {
    const station = this.stations.get(id);
    return station ? cloneStation(station) : null;
  }

  async listStations(filter?: StationListFilter): Promise<StationNode[]> {
    return Array.from(this.stations.values())
      .filter((station) => !filter?.networkId || station.networkId === filter.networkId)
      .filter((station) => !filter?.status || station.status === filter.status)
      .filter((station) => !filter?.role || station.role === filter.role)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(cloneStation);
  }

  async heartbeat(id: string, heartbeat: StationHeartbeat): Promise<boolean> {
    const station = this.stations.get(id);
    if (!station) return false;
    Object.assign(station, heartbeat, {
      labels: heartbeat.labels ? { ...heartbeat.labels } : station.labels,
      capacity: { ...heartbeat.capacity },
      definitions: {
        signals: [...heartbeat.definitions.signals],
        broadcasts: [...heartbeat.definitions.broadcasts],
        beacons: [...heartbeat.definitions.beacons],
        beaconMetadata: heartbeat.definitions.beaconMetadata?.map((item) => ({
          ...item,
          requiredEnv: item.requiredEnv ? [...item.requiredEnv] : undefined,
        })),
      },
    });
    return true;
  }

  async removeStation(id: string): Promise<void> {
    this.stations.delete(id);
  }

  async markOfflineBefore(cutoff: Date, networkId?: string): Promise<number> {
    let changed = 0;
    for (const station of this.stations.values()) {
      if (networkId && station.networkId !== networkId) continue;
      if (station.status !== "offline" && station.leaseExpiresAt <= cutoff) {
        station.status = "offline";
        changed++;
      }
    }
    return changed;
  }

  async acquireControllerLease(lease: ControllerLease, now: Date): Promise<boolean> {
    const current = this.leases.get(lease.name);
    if (current && current.expiresAt > now && (current.holderId !== lease.holderId || current.token !== lease.token)) {
      return false;
    }
    this.leases.set(lease.name, { ...lease });
    return true;
  }

  async renewControllerLease(name: string, holderId: string, token: string, expiresAt: Date, now = new Date()): Promise<boolean> {
    const current = this.leases.get(name);
    if (!current || current.holderId !== holderId || current.token !== token || current.expiresAt <= now) return false;
    current.expiresAt = expiresAt;
    return true;
  }

  async releaseControllerLease(name: string, holderId: string, token: string): Promise<boolean> {
    const current = this.leases.get(name);
    if (!current || current.holderId !== holderId || current.token !== token) return false;
    this.leases.delete(name);
    return true;
  }

  async getControllerLease(name: string): Promise<ControllerLease | null> {
    const lease = this.leases.get(name);
    return lease ? { ...lease } : null;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // Shared in-process adapters may be used by several stations. Closing one
    // client must not erase the entire network's state.
  }
}
