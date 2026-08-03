import type { BeaconInstance, ExitReason } from "../types.js";
import type { BeaconSubscriber } from "./index.js";

/** Logs beacon supervision events to the console. */
export class ConsoleBeaconSubscriber implements BeaconSubscriber {
  private prefix = "[station-beacon]";

  /**
   * A beacon can have several instances running at once, so lines name the
   * instance too — except for a beacon's definition-owned instance, whose id is
   * just the beacon name and would read as noise.
   */
  private label(inst: BeaconInstance): string {
    return inst.id === inst.beaconName ? inst.beaconName : `${inst.beaconName}[${inst.id}]`;
  }

  onBeaconDiscovered(event: { beaconName: string; filePath: string }): void {
    console.log(`${this.prefix} Discovered beacon "${event.beaconName}" at ${event.filePath}`);
  }

  onBeaconInstanceCreated(event: { instance: BeaconInstance }): void {
    console.log(`${this.prefix} Created instance "${this.label(event.instance)}"`);
  }

  onBeaconInstanceRemoved(event: { instance: BeaconInstance }): void {
    console.log(`${this.prefix} Removed instance "${this.label(event.instance)}"`);
  }

  onBeaconStarting(event: { instance: BeaconInstance }): void {
    console.log(
      `${this.prefix} Starting "${this.label(event.instance)}" (incarnation ${event.instance.incarnation})`,
    );
  }

  onBeaconStarted(event: { instance: BeaconInstance }): void {
    console.log(
      `${this.prefix} Started "${this.label(event.instance)}" (pid ${event.instance.pid ?? "?"})`,
    );
  }

  onBeaconReady(event: { instance: BeaconInstance }): void {
    console.log(`${this.prefix} Ready "${this.label(event.instance)}"`);
  }

  onBeaconExited(event: { instance: BeaconInstance; reason: ExitReason; code: number | null }): void {
    console.log(
      `${this.prefix} Exited "${this.label(event.instance)}" — reason=${event.reason} code=${event.code ?? "null"}`,
    );
  }

  onBeaconRestartScheduled(event: {
    instance: BeaconInstance;
    delayMs: number;
    nextRestartAt: Date;
  }): void {
    console.log(
      `${this.prefix} Restarting "${this.label(event.instance)}" in ${event.delayMs}ms (attempt ${event.instance.restartCount})`,
    );
  }

  onBeaconStopped(event: { instance: BeaconInstance }): void {
    console.log(`${this.prefix} Stopped "${this.label(event.instance)}"`);
  }

  onBeaconErrored(event: { instance: BeaconInstance; error?: string }): void {
    console.error(
      `${this.prefix} Errored "${this.label(event.instance)}"${event.error ? `: ${event.error}` : ""}`,
    );
  }

  onBeaconStalled(event: { instance: BeaconInstance }): void {
    const detail = event.instance.lastError ?? "liveness deadline missed";
    console.warn(
      `${this.prefix} Stalled "${this.label(event.instance)}" — ${detail}, restarting`,
    );
  }

  onBeaconLog(event: {
    instance: BeaconInstance;
    level: "log" | "stdout" | "stderr";
    message: string;
  }): void {
    const lines = event.message.trimEnd();
    if (!lines) return;
    const method = event.level === "stderr" ? console.error : console.log;
    method(`${this.prefix} [${this.label(event.instance)}] ${lines}`);
  }
}
