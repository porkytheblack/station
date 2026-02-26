/**
 * Entry point for spawned signal processes.
 * Spawned by SignalRunner — not intended for direct use.
 *
 * Import ordering guarantee:
 *   1. await import(signalFile) runs first — all module-level code in the
 *      signal file executes here, including any configure() calls that swap
 *      in a shared adapter (Redis, Postgres, etc.)
 *   2. updateStatus() calls getAdapter() only after step 1, so they always
 *      see whatever adapter the signal file configured.
 */

// Static import is fine here — getAdapter() reads _adapter at call time,
// so it returns whatever the signal file set via configure().
import { getAdapter } from "./config.js";
import type { QueueEntry } from "./types.js";

const signalName = process.env.SIMPLE_SIGNAL_NAME;
const signalFile = process.env.SIMPLE_SIGNAL_FILE;
const entryId = process.env.SIMPLE_SIGNAL_ENTRY_ID;
const rawInput = process.env.SIMPLE_SIGNAL_INPUT;
const timeoutMs = parseInt(process.env.SIMPLE_SIGNAL_TIMEOUT ?? "300000", 10);
const configModule = process.env.SIMPLE_SIGNAL_CONFIG_MODULE;

if (!signalName || !signalFile || !entryId || rawInput === undefined) {
  console.error("[simple-signal] Missing required env vars in spawned process");
  process.exit(1);
}

type SafeParseResult =
  | { success: true; data: unknown }
  | { success: false; error: { message: string } };

function isSignal(
  value: unknown,
): value is {
  name: string;
  inputSchema: { safeParse(v: unknown): SafeParseResult };
  run: (input: unknown) => Promise<void>;
} {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.run === "function" &&
    typeof v.inputSchema === "object" &&
    v.inputSchema !== null &&
    typeof (v.inputSchema as Record<string, unknown>).safeParse === "function"
  );
}

async function updateStatus(patch: Partial<QueueEntry>): Promise<void> {
  try {
    // With a shared external adapter (Redis, Postgres), updates are visible
    // to the runner. With MemoryAdapter, updates stay local to this process
    // and the runner relies on timeout detection instead.
    await getAdapter().update(entryId!, patch);
  } catch {
    // non-fatal — status updates are best-effort in bootstrap
  }
}

/** Send a lifecycle event to the parent runner via IPC (if available). */
function sendIPC(
  type: "entry:started" | "entry:completed" | "entry:failed",
  data?: Record<string, unknown>,
): void {
  if (typeof process.send === "function") {
    process.send({
      type,
      entryId,
      signalName,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}

try {
  // If a configModule was provided by the runner, import it first.
  // This calls configure() and sets up the shared adapter before anything
  // else runs — the signal file and all status updates will use it.
  if (configModule) {
    await import(configModule);
  }

  const mod = await import(signalFile);
  let found = false;

  for (const value of Object.values(mod)) {
    if (isSignal(value) && value.name === signalName) {
      const parsed: unknown = JSON.parse(rawInput);
      const result = value.inputSchema.safeParse(parsed);

      if (!result.success) {
        console.error(
          `[simple-signal] Invalid input for "${signalName}":`,
          result.error?.message,
        );
        sendIPC("entry:failed", { error: `Invalid input: ${result.error?.message}` });
        await updateStatus({ status: "failed", completedAt: new Date() });
        process.exit(1);
      }

      // Signal the runner (if using a shared adapter) that we've started
      await updateStatus({ status: "running", startedAt: new Date() });
      sendIPC("entry:started");

      // Enforce the timeout via Promise.race
      await Promise.race([
        value.run(result.data),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Signal "${signalName}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);

      sendIPC("entry:completed");
      await updateStatus({ status: "completed", completedAt: new Date() });
      found = true;
      break;
    }
  }

  if (!found) {
    console.error(
      `[simple-signal] Signal "${signalName}" not found in ${signalFile}`,
    );
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  console.error(`[simple-signal] Signal "${signalName}" failed:`, err);
  sendIPC("entry:failed", { error: err instanceof Error ? err.message : String(err) });
  await updateStatus({ status: "failed", completedAt: new Date() });
  process.exit(1);
}
