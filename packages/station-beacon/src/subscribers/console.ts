import type { BeaconInstance, ExitReason } from "../types.js";
import type { BeaconSubscriber } from "./index.js";

/** Logs beacon supervision events to the console. */
export class ConsoleBeaconSubscriber implements BeaconSubscriber {
  private prefix = "[station-beacon]";

  onBeaconDiscovered(event: { beaconName: string; filePath: string }): void {
    console.log(`${this.prefix} Discovered beacon "${event.beaconName}" at ${event.filePath}`);
  }

  onBeaconStarting(event: { instance: BeaconInstance }): void {
    console.log(
      `${this.prefix} Starting "${event.instance.beaconName}" (incarnation ${event.instance.incarnation})`,
    );
  }

  onBeaconStarted(event: { instance: BeaconInstance }): void {
    console.log(
      `${this.prefix} Started "${event.instance.beaconName}" (pid ${event.instance.pid ?? "?"})`,
    );
  }

  onBeaconReady(event: { instance: BeaconInstance }): void {
    console.log(`${this.prefix} Ready "${event.instance.beaconName}"`);
  }

  onBeaconExited(event: { instance: BeaconInstance; reason: ExitReason; code: number | null }): void {
    console.log(
      `${this.prefix} Exited "${event.instance.beaconName}" — reason=${event.reason} code=${event.code ?? "null"}`,
    );
  }

  onBeaconRestartScheduled(event: {
    instance: BeaconInstance;
    delayMs: number;
    nextRestartAt: Date;
  }): void {
    console.log(
      `${this.prefix} Restarting "${event.instance.beaconName}" in ${event.delayMs}ms (attempt ${event.instance.restartCount})`,
    );
  }

  onBeaconStopped(event: { instance: BeaconInstance }): void {
    console.log(`${this.prefix} Stopped "${event.instance.beaconName}"`);
  }

  onBeaconErrored(event: { instance: BeaconInstance; error?: string }): void {
    console.error(
      `${this.prefix} Errored "${event.instance.beaconName}"${event.error ? `: ${event.error}` : ""}`,
    );
  }

  onBeaconStalled(event: { instance: BeaconInstance }): void {
    console.warn(
      `${this.prefix} Stalled "${event.instance.beaconName}" — no heartbeat within deadline, restarting`,
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
    method(`${this.prefix} [${event.instance.beaconName}] ${lines}`);
  }
}
