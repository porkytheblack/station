/**
 * Custom error classes for station-signal.
 * Provides structured, actionable errors with error codes.
 */

export class SignalValidationError extends Error {
  readonly code = "SIGNAL_VALIDATION_ERROR" as const;
  readonly signalName: string;

  constructor(signalName: string, zodMessage: string) {
    super(
      `Invalid input for signal "${signalName}": ${zodMessage}`,
    );
    this.name = "SignalValidationError";
    this.signalName = signalName;
  }
}

export class SignalTimeoutError extends Error {
  readonly code = "SIGNAL_TIMEOUT" as const;
  readonly signalName: string;
  readonly timeoutMs: number;

  constructor(signalName: string, timeoutMs: number) {
    super(`Signal "${signalName}" timed out after ${timeoutMs}ms`);
    this.name = "SignalTimeoutError";
    this.signalName = signalName;
    this.timeoutMs = timeoutMs;
  }
}

export class SignalNotFoundError extends Error {
  readonly code = "SIGNAL_NOT_FOUND" as const;
  readonly signalName: string;
  readonly filePath: string;

  constructor(signalName: string, filePath: string) {
    super(`Signal "${signalName}" not found in ${filePath}`);
    this.name = "SignalNotFoundError";
    this.signalName = signalName;
    this.filePath = filePath;
  }
}

export class StationRemoteError extends Error {
  readonly code = "STATION_REMOTE_ERROR" as const;
  readonly statusCode: number;
  readonly remoteError?: string;

  constructor(statusCode: number, remoteError?: string, remoteMessage?: string) {
    const msg = remoteMessage
      ? `Station server returned ${statusCode}: ${remoteMessage}`
      : `Station server returned ${statusCode}`;
    super(msg);
    this.name = "StationRemoteError";
    this.statusCode = statusCode;
    this.remoteError = remoteError;
  }
}

