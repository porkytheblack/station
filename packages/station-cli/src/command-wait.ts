import { StationApiError, type StationClient } from 'station-client';

export interface SandboxCommandResult {
  id: string; sandboxId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  stdout: string; stderr: string; truncated: boolean; exitCode: number | null;
  startedAt: string; finishedAt?: string;
}
export class CommandWaitError extends Error {
  constructor(readonly code: 'wait_timeout' | 'wait_interrupted' | 'wait_transport_error', readonly exitCode: number, readonly lastResult?: SandboxCommandResult, readonly status = 0) {
    super(code === 'wait_timeout' ? 'Stopped waiting: the remote command may still be running. No cancellation was sent.' : code === 'wait_interrupted' ? 'Stopped waiting after interrupt: the remote command may still be running. No cancellation was sent.' : 'Command polling failed: the remote command may still be running. No cancellation was sent.');
  }
}
export function validateCommandResult(value: unknown, sandboxId: string, runId?: string): SandboxCommandResult {
  if (!value || typeof value !== 'object') throw new StationApiError('invalid_response', 0, 'Invalid sandbox command result.');
  const v = value as SandboxCommandResult;
  if (typeof v.id !== 'string' || !v.id || v.id.length > 256 || v.sandboxId !== sandboxId || runId !== undefined && v.id !== runId ||
      !['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(v.status) || typeof v.stdout !== 'string' || typeof v.stderr !== 'string' || typeof v.truncated !== 'boolean' ||
      !(v.exitCode === null || Number.isSafeInteger(v.exitCode) && v.exitCode >= 0 && v.exitCode <= 255) || v.status === 'completed' && v.exitCode === null) throw new StationApiError('invalid_response', 0, 'Invalid or mismatched sandbox command result.');
  return v;
}
export function commandExitCode(result: SandboxCommandResult): number {
  if (result.status === 'timed_out') return 124;
  if (result.status === 'cancelled') return 130;
  if (result.status === 'interrupted') return 125;
  if (result.status === 'running') throw new Error('Command has not completed.');
  return result.status === 'failed' && !result.exitCode ? 1 : result.exitCode ?? 1;
}
/** Only polls an already accepted command. Never retries exec or sends cancel. */
export async function waitSandboxCommand(client: StationClient, stationId: string, sandboxId: string, initial: unknown, options: { timeoutMs?: number; pollIntervalMs?: number; signal?: AbortSignal } = {}): Promise<SandboxCommandResult> {
  const timeoutMs = options.timeoutMs ?? 300000, interval = options.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000 || !Number.isSafeInteger(interval) || interval < 1 || interval > 5000) throw new Error('Invalid command wait limits.');
  let result = validateCommandResult(initial, sandboxId);
  const deadline = AbortSignal.timeout(timeoutMs), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const interrupted = () => new CommandWaitError(options.signal?.aborted ? 'wait_interrupted' : 'wait_timeout', options.signal?.aborted ? 130 : 124, result);
  while (result.status === 'running') {
    if (signal.aborted) throw interrupted();
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, interval); signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
    if (signal.aborted) throw interrupted();
    try {
      result = validateCommandResult(await client.execution(stationId, 'sandbox', { method: 'command', id: sandboxId, runId: result.id }, signal), sandboxId, result.id);
    } catch (error) {
      if (signal.aborted) throw interrupted();
      if (error instanceof StationApiError) throw new CommandWaitError('wait_transport_error', 1, result, error.status);
      throw error;
    }
  }
  return result;
}
