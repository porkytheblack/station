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

/** No instance exists with the given id. */
export class BeaconInstanceNotFoundError extends Error {
  readonly code = "BEACON_INSTANCE_NOT_FOUND" as const;
  readonly instanceId: string;

  constructor(instanceId: string) {
    super(`Beacon instance "${instanceId}" not found`);
    this.name = "BeaconInstanceNotFoundError";
    this.instanceId = instanceId;
  }
}

/** An instance id is already taken — ids are unique across all beacons. */
export class BeaconInstanceExistsError extends Error {
  readonly code = "BEACON_INSTANCE_EXISTS" as const;
  readonly instanceId: string;

  constructor(instanceId: string) {
    super(`Beacon instance "${instanceId}" already exists`);
    this.name = "BeaconInstanceExistsError";
    this.instanceId = instanceId;
  }
}

/** Creating another instance would exceed the beacon's instance cap. */
export class BeaconInstanceLimitError extends Error {
  readonly code = "BEACON_INSTANCE_LIMIT" as const;
  readonly beaconName: string;
  readonly limit: number;

  constructor(beaconName: string, limit: number) {
    super(
      `Beacon "${beaconName}" already has ${limit} instance${limit === 1 ? "" : "s"} ` +
        `(its limit). Delete an instance, or raise the cap with .maxInstances().`,
    );
    this.name = "BeaconInstanceLimitError";
    this.beaconName = beaconName;
    this.limit = limit;
  }
}
