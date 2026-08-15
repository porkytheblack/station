import type { ControllerLease, StationHeartbeat, StationNode } from "./types.js";

export interface StationListFilter {
  networkId?: string;
  status?: StationNode["status"];
  role?: StationNode["role"];
}

export interface StationNetworkAdapter {
  upsertStation(station: StationNode): Promise<void>;
  getStation(id: string): Promise<StationNode | null>;
  listStations(filter?: StationListFilter): Promise<StationNode[]>;
  heartbeat(id: string, heartbeat: StationHeartbeat): Promise<boolean>;
  removeStation(id: string): Promise<void>;
  markOfflineBefore(cutoff: Date, networkId?: string): Promise<number>;

  acquireControllerLease(lease: ControllerLease, now: Date): Promise<boolean>;
  renewControllerLease(name: string, holderId: string, token: string, expiresAt: Date, now?: Date): Promise<boolean>;
  releaseControllerLease(name: string, holderId: string, token: string): Promise<boolean>;
  getControllerLease(name: string): Promise<ControllerLease | null>;

  ping(): Promise<boolean>;
  close?(): Promise<void>;
}
