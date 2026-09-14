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
}
export interface BrowserRecordingOptions {
  /** Fixed worker-side capture cadence. Default 5000; range 100–3600000 ms. */
  intervalMs?: number;
  /** Maximum frames in one recording. Default 120; range 1–10000. */
  maxFrames?: number;
  /** Includes stopped recordings retained in memory. Default 16; range 1–1024. */
  maxRecordings?: number;
  /** Total PNG bytes retained across recordings. Default 64 MiB; range 1–1 GiB. */
  maxTotalBytes?: number;
}
