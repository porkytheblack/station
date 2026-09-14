export interface BrowserRecordingFrame { id: string; capturedAt: string; bytes: number }
export interface BrowserRecording {
  id: string;
  sessionId: string;
  backend: string;
  startedAt: string;
  stoppedAt?: string;
  status: "recording" | "stopped" | "limit" | "error";
  intervalMs: number;
  frames: BrowserRecordingFrame[];
  bytes: number;
  skipped: number;
  error?: string;
  recovered?: boolean;
}
export interface BrowserRecordingOptions {
  /** Required when reopening recording storage already bound to this tenant. */
  tenantId?: string;
  /** Dedicated durable recording root; exclusive single-manager ownership. */
  recordingRootDir?: string;
  /** Stopped recording retention, default 7 days; minimum 100 ms. */
  recordingTtlMs?: number;
  /** Session inactivity timeout, default 15 minutes. Recording ticks do not renew it. */
  idleTimeoutMs?: number;
  /** Maximum redacted in-memory audit events, default 1000. */
  auditLimit?: number;
  /** Fixed worker-side capture cadence. Default 5000; range 100–3600000 ms. */
  intervalMs?: number;
  /** Maximum frames in one recording. Default 120; range 1–10000. */
  maxFrames?: number;
  /** Includes stopped recordings retained in memory. Default 16; range 1–1024. */
  maxRecordings?: number;
  /** Total PNG bytes retained across recordings. Default 64 MiB; range 1–1 GiB. */
  maxTotalBytes?: number;
}
