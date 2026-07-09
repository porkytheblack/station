/**
 * Custom error classes for station-beacon.
 * Structured, actionable errors with stable error codes.
 */

export class BeaconValidationError extends Error {
  readonly code = "BEACON_VALIDATION_ERROR" as const;
  readonly beaconName: string;

  constructor(beaconName: string, message: string) {
    super(`Invalid config for beacon "${beaconName}": ${message}`);
    this.name = "BeaconValidationError";
    this.beaconName = beaconName;
  }
}

export class BeaconNotFoundError extends Error {
  readonly code = "BEACON_NOT_FOUND" as const;
  readonly beaconName: string;
  readonly filePath: string;

  constructor(beaconName: string, filePath: string) {
    super(`Beacon "${beaconName}" not found in ${filePath}`);
    this.name = "BeaconNotFoundError";
    this.beaconName = beaconName;
    this.filePath = filePath;
  }
}

export class BeaconDefinitionError extends Error {
  readonly code = "BEACON_DEFINITION_ERROR" as const;
  readonly beaconName: string;

  constructor(beaconName: string, message: string) {
    super(`Invalid beacon "${beaconName}": ${message}`);
    this.name = "BeaconDefinitionError";
    this.beaconName = beaconName;
  }
}
