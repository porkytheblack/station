/**
 * Entry point for spawned signal processes.
 * Spawned by SignalRunner — not intended for direct use.
 *
 * Status authority: The PARENT runner is the single source of truth for
 * run status. This child process only sends IPC messages and writes
 * Step records to the adapter. It does NOT write run status.
 */

import { configure, getAdapter } from "./config.js";
import { createAdapter } from "./adapters/registry.js";
// Ensure built-in adapters are registered
import "./adapters/memory.js";
import { SignalNotFoundError, SignalValidationError } from "./errors.js";
import type { AnySignal } from "./signal.js";
import type { Step } from "./types.js";
import { isSignal } from "./util.js";

const signalName = process.env.STATION_SIGNAL_NAME;
const signalFile = process.env.STATION_SIGNAL_FILE;
const runId = process.env.STATION_SIGNAL_RUN_ID;
const rawInput = process.env.STATION_SIGNAL_INPUT;
const adapterName = process.env.STATION_SIGNAL_ADAPTER;
const adapterOptionsRaw = process.env.STATION_SIGNAL_ADAPTER_OPTIONS;
const adapterImport = process.env.STATION_SIGNAL_ADAPTER_IMPORT;

if (!signalName || !signalFile || !runId || rawInput === undefined) {
  console.error("[station-signal] Missing required env vars in spawned process");
  process.exit(1);
}

/**
 * Send a lifecycle event to the parent runner via IPC (if available).
 * Returns a promise that resolves once the message is flushed (H4).
 */
function sendIPC(
  type: "run:started" | "run:completed" | "run:failed" | "step:completed" | "onComplete:error",
  data?: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    if (typeof process.send === "function") {
      process.send(
        {
          type,
          runId,
          signalName,
          timestamp: new Date().toISOString(),
          data,
        },
        () => resolve(),
      );
    } else {
      resolve();
    }
  });
}

/**
 * Execute a step-based signal with Step records.
 * Resumes from the last completed step on retry/crash.
 */
async function executeSteps(
  value: AnySignal,
  input: unknown,
): Promise<unknown> {
  const stepDefs = value.steps!;
  const adapter = getAdapter();

  // Load existing steps (if resuming after crash/retry)
  const existingSteps = await adapter.getSteps(runId!);
  const completedSteps = new Map<string, Step>();
  for (const step of existingSteps) {
    if (step.status === "completed") {
      completedSteps.set(step.name, step);
    } else if (step.status === "running") {
      // Stale "running" step from a crashed process — mark as failed
      await adapter.updateStep(step.id, {
        status: "failed",
        completedAt: new Date(),
        error: "Process crashed during step execution",
      });
    }
  }

  let prev: unknown = input;
  let output: unknown;

  for (const { name: stepName, fn } of stepDefs) {
    // If this step was already completed, use its stored output
    const existing = completedSteps.get(stepName);
    if (existing) {
      prev = existing.output ? JSON.parse(existing.output) : undefined;
      output = prev;
      continue;
    }

    // Create Step record
    const stepId = adapter.generateId();
    const step: Step = {
      id: stepId,
      runId: runId!,
      name: stepName,
      status: "running",
      input: JSON.stringify(prev),
      startedAt: new Date(),
    };
    await adapter.addStep(step);

    try {
      output = await fn(prev);
      prev = output;

      await adapter.updateStep(stepId, {
        status: "completed",
        output: JSON.stringify(output),
        completedAt: new Date(),
      });

      await sendIPC("step:completed", {
        stepId,
        stepName,
        output: JSON.stringify(output),
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await adapter.updateStep(stepId, {
        status: "failed",
        error: errorMsg,
        completedAt: new Date(),
      });
      throw err;
    }
  }

  return output;
}

try {
  // Reconstruct the adapter in this child process (for step persistence)
  if (adapterName) {
    if (adapterImport) {
      await import(adapterImport);
    }
    const options = adapterOptionsRaw ? JSON.parse(adapterOptionsRaw) : {};
    configure({ adapter: createAdapter(adapterName, options) });
  } else {
    // No serializable adapter — use MemoryAdapter for in-process step tracking.
    configure({ adapter: createAdapter("memory", {}) });
  }

  const mod = await import(signalFile);
  let found = false;

  for (const value of Object.values(mod)) {
    if (isSignal(value) && value.name === signalName) {
      // H3: Warn when step-based signal runs without a serializable adapter
      if (value.steps && !adapterName) {
        console.warn(
          `[station-signal] Signal "${signalName}" uses steps but no serializable adapter is configured. ` +
          "Step state will not persist across retries or crashes. Consider using SqliteAdapter.",
        );
      }

      const parsed: unknown = JSON.parse(rawInput);
      const result = value.inputSchema.safeParse(parsed);

      if (!result.success) {
        const err = new SignalValidationError(signalName, result.error?.message ?? "Unknown validation error");
        console.error(`[station-signal] ${err.message}`);
        await sendIPC("run:failed", { error: err.message, retryable: false });
        process.exit(1);
      }

      await sendIPC("run:started");

      // H5: No child-side timeout. The parent runner's checkTimeouts() is the
      // single authority for timeout enforcement, preventing double-timeout races.
      let output: unknown;

      if (value.steps) {
        output = await executeSteps(value, result.data);
      } else if (value.handler) {
        output = await value.handler(result.data);
      }

      // Validate output against schema if present
      if (value.outputSchema && output !== undefined) {
        const outputResult = value.outputSchema.safeParse(output);
        if (!outputResult.success) {
          throw new SignalValidationError(
            signalName,
            `Output validation failed: ${outputResult.error.message}`,
          );
        }
        output = outputResult.data;
      }

      const serializedOutput = output !== undefined ? JSON.stringify(output) : undefined;

      // M1: Call onComplete handler, report errors via IPC (don't fail the run)
      if (value.onCompleteHandler && output !== undefined) {
        try {
          await value.onCompleteHandler(output, result.data);
        } catch (onCompleteErr) {
          const errMsg = onCompleteErr instanceof Error ? onCompleteErr.message : String(onCompleteErr);
          console.error(
            `[station-signal] onComplete handler for "${signalName}" threw:`,
            onCompleteErr,
          );
          await sendIPC("onComplete:error", { error: errMsg });
        }
      }

      await sendIPC("run:completed", { output: serializedOutput });

      found = true;
      break;
    }
  }

  if (!found) {
    const err = new SignalNotFoundError(signalName, signalFile);
    console.error(`[station-signal] ${err.message}`);
    await sendIPC("run:failed", { error: err.message, retryable: false });
    process.exit(1);
  }

  // H4: Let the event loop drain naturally instead of process.exit(0)
  // so IPC messages are fully flushed before the process ends.
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error(`[station-signal] Signal "${signalName}" failed:`, err);
  // Timeouts and validation errors are not retryable
  const retryable = !(err instanceof SignalValidationError);
  await sendIPC("run:failed", { error: errorMsg, retryable });
  process.exit(1);
}
