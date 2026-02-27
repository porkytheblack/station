/**
 * Custom error classes for simple-signal.
 * Provides structured, actionable errors with error codes.
 */

export class AdapterNotConfiguredError extends Error {
  readonly code = "ADAPTER_NOT_CONFIGURED" as const;

  constructor() {
    super(
      'No adapter configured. Call configure({ adapter }) before triggering signals, ' +
      'or pass an adapter to SignalRunner.',
    );
    this.name = "AdapterNotConfiguredError";
  }
}

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

export class SignalConcurrencyError extends Error {
  readonly code = "SIGNAL_CONCURRENCY_EXCEEDED" as const;
  readonly signalName: string;
  readonly maxConcurrencyPerSignal: number;

  constructor(signalName: string, maxConcurrencyPerSignal: number) {
    super(`Signal "${signalName}" has ${maxConcurrencyPerSignal} runs already active, skipping`);
    this.name = "SignalConcurrencyError";
    this.signalName = signalName;
    this.maxConcurrencyPerSignal = maxConcurrencyPerSignal;
  }
}
