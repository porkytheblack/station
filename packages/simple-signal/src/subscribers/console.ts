import type { Run, Step } from "../types.js";
import type { SignalSubscriber } from "./index.js";

export class ConsoleSubscriber implements SignalSubscriber {
  private prefix = "[simple-signal]";

  onSignalDiscovered(event: { signalName: string; filePath: string }): void {
    console.log(
      `${this.prefix} Discovered signal "${event.signalName}" at ${event.filePath}`,
    );
  }

  onRunDispatched(event: { run: Run }): void {
    console.log(
      `${this.prefix} Dispatched "${event.run.signalName}" (${event.run.id})`,
    );
  }

  onRunStarted(event: { run: Run }): void {
    console.log(
      `${this.prefix} Started "${event.run.signalName}" (${event.run.id})`,
    );
  }

  onRunCompleted(event: { run: Run; output?: string }): void {
    const outputStr = event.output
      ? ` → ${event.output.length > 200 ? event.output.slice(0, 200) + "…" : event.output}`
      : "";
    console.log(
      `${this.prefix} Completed "${event.run.signalName}" (${event.run.id})${outputStr}`,
    );
  }

  onRunTimeout(event: { run: Run }): void {
    console.warn(
      `${this.prefix} Timeout "${event.run.signalName}" (${event.run.id})`,
    );
  }

  onRunRetry(event: {
    run: Run;
    attempt: number;
    maxAttempts: number;
  }): void {
    console.log(
      `${this.prefix} Retry "${event.run.signalName}" (${event.run.id}) — attempt ${event.attempt}/${event.maxAttempts}`,
    );
  }

  onRunFailed(event: { run: Run; error?: string }): void {
    console.error(
      `${this.prefix} Failed "${event.run.signalName}" (${event.run.id})${event.error ? `: ${event.error}` : ""}`,
    );
  }

  onRunCancelled(event: { run: Run }): void {
    console.log(
      `${this.prefix} Cancelled "${event.run.signalName}" (${event.run.id})`,
    );
  }

  onRunRescheduled(event: { run: Run; nextRunAt: Date }): void {
    console.log(
      `${this.prefix} Rescheduled "${event.run.signalName}" (${event.run.id}) — next at ${event.nextRunAt.toISOString()}`,
    );
  }

  onStepCompleted(event: { run: Run; step: Step }): void {
    console.log(
      `${this.prefix} Step "${event.step.name}" completed for "${event.run.signalName}" (${event.run.id})`,
    );
  }

  onLogOutput(event: {
    run: Run;
    level: "stdout" | "stderr";
    message: string;
  }): void {
    const lines = event.message.trimEnd();
    if (!lines) return;
    const method = event.level === "stderr" ? console.error : console.log;
    method(`${this.prefix} [${event.run.signalName}] ${lines}`);
  }
}
