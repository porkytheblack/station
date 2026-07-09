import type { BackoffConfig, DesiredState, ExitReason, RestartPolicy } from "./types.js";

/**
 * Pure supervision logic — no I/O, no timers. Kept separate so the restart
 * decision and backoff curve are trivially unit-testable.
 */

/**
 * Decide whether a beacon should be restarted after its process exited.
 *
 * A beacon is never restarted when the operator wants it stopped, nor when the
 * supervisor itself asked it to stop. Otherwise the restart policy governs:
 *  - `never`      → never restart
 *  - `on-failure` → restart only on a crash/failure, a stall, or a startup timeout
 *  - `always`     → restart on any exit (clean or failure), as long as the stop
 *                   wasn't operator-initiated
 */
export function shouldRestart(
  policy: RestartPolicy,
  exitReason: ExitReason,
  desiredState: DesiredState,
): boolean {
  if (desiredState === "stopped") return false;
  if (exitReason === "stopped") return false;
  if (policy === "never") return false;
  if (policy === "on-failure") {
    return exitReason === "failure" || exitReason === "stalled" || exitReason === "startup-timeout";
  }
  // policy === "always"
  return true;
}

/**
 * Exponential backoff delay for the Nth consecutive restart (0-based).
 * `attempt` 0 → `baseMs`; each further attempt multiplies by `factor`, capped
 * at `maxMs`.
 */
export function computeBackoffMs(attempt: number, cfg: BackoffConfig): number {
  const n = Math.max(0, Math.floor(attempt));
  const raw = cfg.baseMs * Math.pow(cfg.factor, n);
  return Math.min(cfg.maxMs, Math.round(raw));
}

/**
 * Whether an incarnation stayed up long enough to be considered healthy, so the
 * consecutive-restart counter can reset. Prevents a beacon that ran fine for
 * hours from restarting at the top of the backoff curve after a single blip.
 */
export function shouldResetBackoff(uptimeMs: number, cfg: BackoffConfig): boolean {
  return uptimeMs >= cfg.resetAfterMs;
}
