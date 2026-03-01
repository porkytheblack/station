export class BroadcastValidationError extends Error {
  readonly code: string = "BROADCAST_VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "BroadcastValidationError";
  }
}

export class BroadcastCycleError extends BroadcastValidationError {
  override readonly code = "BROADCAST_CYCLE_ERROR";
  readonly cycle: string[];
  constructor(broadcastName: string, cycle: string[]) {
    super(
      `Broadcast "${broadcastName}" contains a cycle: ${cycle.join(" → ")}`,
    );
    this.name = "BroadcastCycleError";
    this.cycle = cycle;
  }
}
