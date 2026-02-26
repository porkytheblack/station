import type { QueueEntry } from "../types.js";
import type { SignalSubscriber } from "./index.js";

export class ConsoleSubscriber implements SignalSubscriber {
  private prefix = "[simple-signal]";

  onSignalDiscovered(event: { signalName: string; filePath: string }): void {
    console.log(
      `${this.prefix} Discovered signal "${event.signalName}" at ${event.filePath}`,
    );
  }

  onEntryDispatched(event: { entry: QueueEntry }): void {
    console.log(
      `${this.prefix} Dispatched "${event.entry.signalName}" (${event.entry.id})`,
    );
  }

  onEntryStarted(event: { entry: QueueEntry }): void {
    console.log(
      `${this.prefix} Started "${event.entry.signalName}" (${event.entry.id})`,
    );
  }

  onEntryCompleted(event: { entry: QueueEntry }): void {
    console.log(
      `${this.prefix} Completed "${event.entry.signalName}" (${event.entry.id})`,
    );
  }

  onEntryTimeout(event: { entry: QueueEntry }): void {
    console.warn(
      `${this.prefix} Timeout "${event.entry.signalName}" (${event.entry.id})`,
    );
  }

  onEntryRetry(event: {
    entry: QueueEntry;
    attempt: number;
    maxAttempts: number;
  }): void {
    console.log(
      `${this.prefix} Retry "${event.entry.signalName}" (${event.entry.id}) — attempt ${event.attempt}/${event.maxAttempts}`,
    );
  }

  onEntryFailed(event: { entry: QueueEntry; error?: string }): void {
    console.error(
      `${this.prefix} Failed "${event.entry.signalName}" (${event.entry.id})${event.error ? `: ${event.error}` : ""}`,
    );
  }

  onEntryRescheduled(event: { entry: QueueEntry; nextRunAt: Date }): void {
    console.log(
      `${this.prefix} Rescheduled "${event.entry.signalName}" (${event.entry.id}) — next at ${event.nextRunAt.toISOString()}`,
    );
  }

  onLogOutput(event: {
    entry: QueueEntry;
    level: "stdout" | "stderr";
    message: string;
  }): void {
    const lines = event.message.trimEnd();
    if (!lines) return;
    const method = event.level === "stderr" ? console.error : console.log;
    method(`${this.prefix} [${event.entry.signalName}] ${lines}`);
  }
}
