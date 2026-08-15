export type StationRole = "headquarters" | "station" | "standalone";
export type StationStatus = "online" | "draining" | "offline";

export interface StationCapacity {
  maxConcurrent: number;
  activeRuns: number;
}

export interface StationDefinitions {
  signals: string[];
  broadcasts: string[];
  beacons: string[];
  /** Rich beacon catalog used by Headquarters without importing worker code. */
  beaconMetadata?: Array<{
    name: string;
    filePath?: string;
    mode: "run" | "poll";
    restartPolicy: string;
    startMode: string;
    autoStart: boolean;
    maxInstances: number;
    requiredEnv?: string[];
  }>;
}

export interface StationNode {
  id: string;
  networkId: string;
  name: string;
  role: StationRole;
  status: StationStatus;
  labels: Record<string, string>;
  capacity: StationCapacity;
  definitions: StationDefinitions;
  version?: string;
  endpoint?: string;
  startedAt: Date;
  lastHeartbeatAt: Date;
  leaseExpiresAt: Date;
}

export type StationHeartbeat = Pick<
  StationNode,
  "status" | "capacity" | "definitions" | "lastHeartbeatAt" | "leaseExpiresAt"
> & Partial<Pick<StationNode, "labels" | "version" | "endpoint">>;

export interface ControllerLease {
  name: string;
  holderId: string;
  token: string;
  expiresAt: Date;
}
