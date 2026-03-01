import { isSignal } from "station-signal";
import { isBroadcast } from "station-broadcast";
import type { SignalSubscriber, Run, Step } from "station-signal";
import type { BroadcastSubscriber, BroadcastRun, BroadcastNodeRun } from "station-broadcast";
import type { WebSocketHub } from "./ws.js";
import type { SSEHub } from "./sse.js";
import type { LogBuffer } from "./log-buffer.js";
import type { LogStore } from "./log-store.js";
import { serializeZodSchema, type SignalMeta, type BroadcastMeta } from "./metadata.js";

function serializeRun(run: Run): Record<string, unknown> {
  return {
    ...run,
    nextRunAt: run.nextRunAt?.toISOString(),
    lastRunAt: run.lastRunAt?.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    createdAt: run.createdAt.toISOString(),
  };
}

function serializeBroadcastRun(run: BroadcastRun): Record<string, unknown> {
  return {
    ...run,
    nextRunAt: run.nextRunAt?.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    createdAt: run.createdAt.toISOString(),
  };
}

function serializeNodeRun(nr: BroadcastNodeRun): Record<string, unknown> {
  return {
    ...nr,
    startedAt: nr.startedAt?.toISOString(),
    completedAt: nr.completedAt?.toISOString(),
  };
}

export class StationSignalSubscriber implements SignalSubscriber {
  private logBuffer?: LogBuffer;
  private logStore?: LogStore;
  private sseHub?: SSEHub;
  private signalMetaMap = new Map<string, SignalMeta>();

  constructor(private hub: WebSocketHub, logBuffer?: LogBuffer, logStore?: LogStore) {
    this.logBuffer = logBuffer;
    this.logStore = logStore;
  }

  /** Attach an SSE hub so events are also pushed to SSE clients. */
  setSSEHub(sseHub: SSEHub): void {
    this.sseHub = sseHub;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const event = { type, timestamp: new Date().toISOString(), data };
    this.hub.broadcast(event);
    this.sseHub?.broadcast(event);
  }

  getSignalMeta(name: string): SignalMeta | undefined {
    return this.signalMetaMap.get(name);
  }

  getAllSignalMeta(): SignalMeta[] {
    return [...this.signalMetaMap.values()];
  }

  onSignalDiscovered(event: { signalName: string; filePath: string }): void {
    this.emit("signal:discovered", event);

    // Async metadata collection — import is cached by Node
    import(event.filePath).then((mod) => {
      for (const value of Object.values(mod)) {
        if (isSignal(value) && value.name === event.signalName) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sig = value as any;
          this.signalMetaMap.set(event.signalName, {
            name: sig.name,
            filePath: event.filePath,
            inputSchema: sig.inputSchema ? serializeZodSchema(sig.inputSchema) : null,
            outputSchema: sig.outputSchema ? serializeZodSchema(sig.outputSchema) : null,
            interval: sig.interval ?? null,
            timeout: sig.timeout,
            maxAttempts: sig.maxAttempts,
            maxConcurrency: sig.maxConcurrency ?? null,
            hasSteps: Array.isArray(sig.steps) && sig.steps.length > 0,
            stepNames: sig.steps?.map((s: { name: string }) => s.name) ?? [],
          });
          break;
        }
      }
    }).catch(() => {});
  }

  onRunDispatched(event: { run: Run }): void {
    this.emit("run:dispatched", { run: serializeRun(event.run) });
  }

  onRunStarted(event: { run: Run }): void {
    this.emit("run:started", { run: serializeRun(event.run) });
  }

  onRunCompleted(event: { run: Run; output?: string }): void {
    this.emit("run:completed", { run: serializeRun(event.run), output: event.output });
  }

  onRunTimeout(event: { run: Run }): void {
    this.emit("run:timeout", { run: serializeRun(event.run) });
  }

  onRunRetry(event: { run: Run; attempt: number; maxAttempts: number }): void {
    this.emit("run:retry", {
      run: serializeRun(event.run),
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
    });
  }

  onRunFailed(event: { run: Run; error?: string }): void {
    this.emit("run:failed", { run: serializeRun(event.run), error: event.error ?? "" });
  }

  onRunCancelled(event: { run: Run }): void {
    this.emit("run:cancelled", { run: serializeRun(event.run) });
  }

  onRunSkipped(event: { run: Run; reason: string }): void {
    this.emit("run:skipped", { run: serializeRun(event.run), reason: event.reason });
  }

  onRunRescheduled(event: { run: Run; nextRunAt: Date }): void {
    this.emit("run:rescheduled", {
      run: serializeRun(event.run),
      nextRunAt: event.nextRunAt.toISOString(),
    });
  }

  onStepStarted(event: { run: Run; step: Pick<Step, "id" | "runId" | "name"> }): void {
    this.emit("step:started", { run: serializeRun(event.run), step: event.step });
  }

  onStepCompleted(event: { run: Run; step: Step }): void {
    this.emit("step:completed", {
      run: serializeRun(event.run),
      step: {
        ...event.step,
        startedAt: event.step.startedAt?.toISOString(),
        completedAt: event.step.completedAt?.toISOString(),
      },
    });
  }

  onStepFailed(event: { run: Run; step: Step }): void {
    this.emit("step:failed", {
      run: serializeRun(event.run),
      step: {
        ...event.step,
        startedAt: event.step.startedAt?.toISOString(),
        completedAt: event.step.completedAt?.toISOString(),
      },
    });
  }

  onCompleteError(event: { run: Run; error: string }): void {
    this.emit("run:completeError", { run: serializeRun(event.run), error: event.error });
  }

  onLogOutput(event: { run: Run; level: "stdout" | "stderr"; message: string }): void {
    const timestamp = new Date().toISOString();
    const entry = {
      runId: event.run.id,
      signalName: event.run.signalName,
      level: event.level,
      message: event.message,
      timestamp,
    };
    this.logBuffer?.add(entry);
    this.logStore?.add(entry);
    this.emit("log:output", entry);
  }
}

export class StationBroadcastSubscriber implements BroadcastSubscriber {
  private broadcastMetaMap = new Map<string, BroadcastMeta>();
  private sseHub?: SSEHub;

  constructor(private hub: WebSocketHub) {}

  /** Attach an SSE hub so events are also pushed to SSE clients. */
  setSSEHub(sseHub: SSEHub): void {
    this.sseHub = sseHub;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const event = { type, timestamp: new Date().toISOString(), data };
    this.hub.broadcast(event);
    this.sseHub?.broadcast(event);
  }

  getBroadcastMeta(name: string): BroadcastMeta | undefined {
    return this.broadcastMetaMap.get(name);
  }

  getAllBroadcastMeta(): BroadcastMeta[] {
    return [...this.broadcastMetaMap.values()];
  }

  onBroadcastDiscovered(event: { broadcastName: string; filePath: string }): void {
    this.emit("broadcast:discovered", event);

    import(event.filePath).then((mod) => {
      for (const value of Object.values(mod)) {
        if (isBroadcast(value) && value.name === event.broadcastName) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bc = value as any;
          this.broadcastMetaMap.set(event.broadcastName, {
            name: bc.name,
            filePath: event.filePath,
            nodes: bc.nodes.map((n: { name: string; signalName: string; dependsOn: readonly string[] }) => ({
              name: n.name,
              signalName: n.signalName,
              dependsOn: [...n.dependsOn],
            })),
            failurePolicy: bc.failurePolicy,
            timeout: bc.timeout ?? null,
            interval: bc.interval ?? null,
          });
          break;
        }
      }
    }).catch(() => {});
  }

  onBroadcastQueued(event: { broadcastRun: BroadcastRun }): void {
    this.emit("broadcast:queued", { broadcastRun: serializeBroadcastRun(event.broadcastRun) });
  }

  onBroadcastStarted(event: { broadcastRun: BroadcastRun }): void {
    this.emit("broadcast:started", { broadcastRun: serializeBroadcastRun(event.broadcastRun) });
  }

  onBroadcastCompleted(event: { broadcastRun: BroadcastRun }): void {
    this.emit("broadcast:completed", { broadcastRun: serializeBroadcastRun(event.broadcastRun) });
  }

  onBroadcastFailed(event: { broadcastRun: BroadcastRun; error: string }): void {
    this.emit("broadcast:failed", {
      broadcastRun: serializeBroadcastRun(event.broadcastRun),
      error: event.error,
    });
  }

  onBroadcastCancelled(event: { broadcastRun: BroadcastRun }): void {
    this.emit("broadcast:cancelled", { broadcastRun: serializeBroadcastRun(event.broadcastRun) });
  }

  onNodeTriggered(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void {
    this.emit("node:triggered", {
      broadcastRun: serializeBroadcastRun(event.broadcastRun),
      nodeRun: serializeNodeRun(event.nodeRun),
    });
  }

  onNodeCompleted(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void {
    this.emit("node:completed", {
      broadcastRun: serializeBroadcastRun(event.broadcastRun),
      nodeRun: serializeNodeRun(event.nodeRun),
    });
  }

  onNodeFailed(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; error: string }): void {
    this.emit("node:failed", {
      broadcastRun: serializeBroadcastRun(event.broadcastRun),
      nodeRun: serializeNodeRun(event.nodeRun),
      error: event.error,
    });
  }

  onNodeSkipped(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; reason: string }): void {
    this.emit("node:skipped", {
      broadcastRun: serializeBroadcastRun(event.broadcastRun),
      nodeRun: serializeNodeRun(event.nodeRun),
      reason: event.reason,
    });
  }
}
