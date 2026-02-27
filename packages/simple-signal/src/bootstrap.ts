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
import { SignalNotFoundError, SignalTimeoutError, SignalValidationError } from "./errors.js";
import type { AnySignal } from "./signal.js";
import type { Step } from "./types.js";
import { isSignal } from "./util.js";

const signalName = process.env.SIMPLE_SIGNAL_NAME;
const signalFile = process.env.SIMPLE_SIGNAL_FILE;
const runId = process.env.SIMPLE_SIGNAL_RUN_ID;
const rawInput = process.env.SIMPLE_SIGNAL_INPUT;
const timeoutMs = parseInt(process.env.SIMPLE_SIGNAL_TIMEOUT ?? "300000", 10);
const adapterName = process.env.SIMPLE_SIGNAL_ADAPTER;
const adapterOptionsRaw = process.env.SIMPLE_SIGNAL_ADAPTER_OPTIONS;
const adapterImport = process.env.SIMPLE_SIGNAL_ADAPTER_IMPORT;

if (!signalName || !signalFile || !runId || rawInput === undefined) {
  console.error("[simple-signal] Missing required env vars in spawned process");
  process.exit(1);
}

/** Send a lifecycle event to the parent runner via IPC (if available). */
function sendIPC(
  type: "run:started" | "run:completed" | "run:failed" | "step:completed",
  data?: Record<string, unknown>,
): void {
  if (typeof process.send === "function") {
    process.send({
      type,
      runId,
      signalName,
      timestamp: new Date().toISOString(),
      data,
    });
  }
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

      sendIPC("step:completed", {
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
    // No adapter specified — use MemoryAdapter for in-process step tracking
    configure({ adapter: createAdapter("memory", {}) });
  }

  const mod = await import(signalFile);
  let found = false;

  for (const value of Object.values(mod)) {
    if (isSignal(value) && value.name === signalName) {
      const parsed: unknown = JSON.parse(rawInput);
      const result = value.inputSchema.safeParse(parsed);

      if (!result.success) {
        const err = new SignalValidationError(signalName, result.error?.message ?? "Unknown validation error");
        console.error(`[simple-signal] ${err.message}`);
        sendIPC("run:failed", { error: err.message, retryable: false });
        process.exit(1);
      }

      sendIPC("run:started");

      // Execute handler or steps with timeout
      let output: unknown;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          (async () => {
            if (value.steps) {
              output = await executeSteps(value, result.data);
            } else if (value.handler) {
              output = await value.handler(result.data);
            }
          })(),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new SignalTimeoutError(signalName, timeoutMs)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
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

      // Call onComplete handler in this child process
      if (value.onCompleteHandler && output !== undefined) {
        await value.onCompleteHandler(output, result.data);
      }

      sendIPC("run:completed", { output: serializedOutput });

      found = true;
      break;
    }
  }

  if (!found) {
    const err = new SignalNotFoundError(signalName, signalFile);
    console.error(`[simple-signal] ${err.message}`);
    sendIPC("run:failed", { error: err.message, retryable: false });
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error(`[simple-signal] Signal "${signalName}" failed:`, err);
  sendIPC("run:failed", { error: errorMsg, retryable: true });
  process.exit(1);
}
