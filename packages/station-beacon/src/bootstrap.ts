/**
 * Entry point for spawned beacon processes. Spawned by BeaconRunner — not
 * intended for direct use.
 *
 * Responsibilities of the child:
 *  - build the BeaconContext and run the handler,
 *  - translate SIGTERM into a graceful, abortable stop with cleanup,
 *  - report lifecycle signals (started / ready / heartbeat / error) over IPC.
 *
 * Authority over restart decisions and status lives in the PARENT supervisor.
 * The child only exits with 0 (clean/stopped) or non-zero (failure); the parent
 * disambiguates "clean" from "stopped" using its own knowledge of whether it
 * asked this process to stop.
 */

import type { BeaconContext } from "./context.js";
import type { BeaconJobInitMessage } from "./subscribers/index.js";
import { FATAL_EXIT_CODE } from "./types.js";
import { isBeacon } from "./util.js";

const beaconName = process.env.STATION_BEACON_NAME;
const beaconFile = process.env.STATION_BEACON_FILE;
const incarnation = Number(process.env.STATION_BEACON_INCARNATION ?? "1");
const stopTimeoutMs = Number(process.env.STATION_BEACON_STOP_TIMEOUT ?? "10000");

if (!beaconName || !beaconFile) {
  console.error("[station-beacon] Missing required env vars in spawned process");
  process.exit(1);
}

/**
 * The beacon config and signal-adapter configuration (which may contain DB
 * credentials) arrive over the private IPC channel rather than the environment,
 * so they are not exposed via /proc/<pid>/environ. Registered synchronously at
 * module load so a job:init sent immediately after spawn isn't missed.
 */
function waitForJobInit(timeoutMs = 10_000): Promise<BeaconJobInitMessage["data"]> {
  return new Promise((resolve) => {
    if (typeof process.send !== "function") {
      console.error("[station-beacon] No IPC channel — bootstrap must be spawned by BeaconRunner");
      process.exit(1);
    }
    const timer = setTimeout(() => {
      console.error("[station-beacon] Timed out waiting for job:init from supervisor");
      process.exit(1);
    }, timeoutMs);
    timer.unref?.();
    const onMessage = (msg: unknown) => {
      if (msg && typeof msg === "object" && (msg as BeaconJobInitMessage).type === "job:init") {
        clearTimeout(timer);
        process.off("message", onMessage);
        resolve((msg as BeaconJobInitMessage).data);
      }
    };
    process.on("message", onMessage);
  });
}

function sendIPC(
  type:
    | "beacon:started"
    | "beacon:ready"
    | "beacon:heartbeat"
    | "beacon:log"
    | "beacon:stopping"
    | "beacon:error",
  data?: Record<string, unknown>,
): void {
  if (typeof process.send === "function") {
    process.send({
      type,
      beaconName,
      incarnation,
      timestamp: new Date().toISOString(),
      data,
    });
  }
}

/**
 * Send a final IPC message and exit once it has flushed. `process.exit` does not
 * flush pending IPC writes, so a plain `sendIPC(...); process.exit()` can drop
 * the message; this waits for the send callback (with a fallback timer) so the
 * error text reliably reaches the supervisor.
 */
function sendThenExit(type: "beacon:error", data: Record<string, unknown>, code: number): void {
  if (typeof process.send !== "function") process.exit(code);
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.exit(code);
  };
  try {
    process.send!(
      { type, beaconName, incarnation, timestamp: new Date().toISOString(), data },
      exit,
    );
  } catch {
    exit();
  }
  setTimeout(exit, 1_000).unref?.();
}

// ─── Stop coordination ────────────────────────────────────────────────
const abortController = new AbortController();
const stopCallbacks: Array<() => void | Promise<void>> = [];
let resolveStopped!: () => void;
const stoppedPromise = new Promise<void>((r) => {
  resolveStopped = r;
});
let stopping = false;
let readySent = false;

async function requestStop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Arm the exit backstop FIRST so a hanging onStop callback can't disable it.
  const forceExit = setTimeout(() => process.exit(0), stopTimeoutMs);
  forceExit.unref?.();
  sendIPC("beacon:stopping");
  // Aborting first lets stream iterators / fetch calls watching ctx.signal
  // unwind while the registered cleanup callbacks run.
  abortController.abort();
  for (const cb of stopCallbacks) {
    try {
      await cb();
    } catch (err) {
      console.error(`[station-beacon] onStop callback for "${beaconName}" threw:`, err);
    }
  }
  resolveStopped();
}

// Listening for IPC messages both delivers the parent's stop request AND keeps
// this process's event loop alive while the handler awaits (e.g. a server that
// sits in `untilStopped()`). Without an active handle here, Node would treat a
// never-settling handler await as an "unsettled top-level await" and exit (13).
process.on("message", (msg: { type?: string } | null) => {
  if (msg && msg.type === "stop") void requestStop();
});
process.channel?.ref?.();

// If the supervisor's IPC channel closes (supervisor exited or crashed), don't
// linger as an orphan — unwind gracefully. requestStop() aborts and resolves
// untilStopped() (so a well-behaved handler returns and the process exits) and
// arms its own stopTimeout backstop for a handler that ignores the stop.
process.on("disconnect", () => {
  void requestStop();
});

// Signals are a backstop for external kills (e.g. `kill <pid>`), in addition to
// the IPC stop the supervisor normally sends.
process.on("SIGTERM", () => {
  void requestStop();
});
process.on("SIGINT", () => {
  void requestStop();
});

// ─── Build context ────────────────────────────────────────────────────
function buildContext<TConfig>(config: TConfig): BeaconContext<TConfig> {
  return {
    name: beaconName!,
    config,
    incarnation,
    signal: abortController.signal,
    ready(): void {
      if (readySent) return;
      readySent = true;
      sendIPC("beacon:ready");
    },
    heartbeat(): void {
      sendIPC("beacon:heartbeat");
    },
    log(message: string): void {
      sendIPC("beacon:log", { message });
    },
    onStop(fn: () => void | Promise<void>): void {
      stopCallbacks.push(fn);
    },
    untilStopped(): Promise<void> {
      return stoppedPromise;
    },
  };
}

// ─── Run ──────────────────────────────────────────────────────────────
try {
  const job = await waitForJobInit();
  const rawConfig = job.config;

  // Apply store-managed env vars before the beacon file is imported, so both
  // module-level code and the handler read them via process.env as usual.
  // Delivered over IPC (not the spawn env) to keep secrets out of /proc.
  if (job.env) {
    for (const [key, value] of Object.entries(job.env)) {
      process.env[key] = value;
    }
  }

  // Reconstruct the signal adapter (if provided) so beacon handlers can trigger
  // signals into the shared queue rather than an isolated in-child adapter.
  if (job.signalAdapterName) {
    const { configure, createAdapter } = await import("station-signal");
    if (job.signalAdapterImport) {
      await import(job.signalAdapterImport);
    }
    configure({ adapter: createAdapter(job.signalAdapterName, job.signalAdapterOptions ?? {}) });
  }

  const mod = await import(beaconFile);
  let target: unknown;
  for (const value of Object.values(mod)) {
    if (isBeacon(value) && value.name === beaconName) {
      target = value;
      break;
    }
  }

  if (!target || !isBeacon(target)) {
    console.error(`[station-beacon] Beacon "${beaconName}" not found in ${beaconFile}`);
    // The fatal exit code (not the IPC flag) is what stops the supervisor from
    // restart-looping; flush the message for the error text, then exit.
    sendThenExit("beacon:error", { error: `Beacon "${beaconName}" not found`, fatal: true }, FATAL_EXIT_CODE);
  } else {
    const parsedConfig: unknown = rawConfig ? JSON.parse(rawConfig) : {};
    const result = target.configSchema.safeParse(parsedConfig);
    if (!result.success) {
      const msg = result.error?.message ?? "Unknown config validation error";
      console.error(`[station-beacon] Invalid config for "${beaconName}": ${msg}`);
      // Config errors are fatal — restarting with the same config won't help.
      sendThenExit("beacon:error", { error: msg, fatal: true }, FATAL_EXIT_CODE);
    } else {
      const ctx = buildContext(result.data);
      sendIPC("beacon:started");

      await target.handler(ctx);

      // Handler returned. If we were asked to stop, this is a graceful stop
      // (exit 0). Otherwise it completed on its own — still exit 0; the parent's
      // restart policy decides whether a "clean" exit should be relaunched.
      process.exit(0);
    }
  }
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  console.error(`[station-beacon] Beacon "${beaconName}" threw:`, err);
  // Flush the error text before exiting so the supervisor records the crash
  // reason (a plain send + exit can drop the message). Non-fatal exit code (1)
  // means the restart policy applies.
  sendThenExit("beacon:error", { error: errorMsg }, 1);
}
