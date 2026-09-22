import { StationApiError } from 'station-client';
import { CommandWaitError } from './command-wait.js';
/** JSON failures deliberately exclude arbitrary provider messages, stack traces and request bodies. */
export function serializeCliError(error: unknown) {
  if (error instanceof CommandWaitError) return { error: { code: error.code, status: error.status, message: error.message } };
  if (error instanceof StationApiError) return { error: {
    code: /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'request_failed',
    status: Number.isInteger(error.status) && error.status >= 0 && error.status <= 599 ? error.status : 0,
    message: 'Station API request failed. No automatic retry was made.',
  } };
  return { error: { code: 'cli_error', status: 0, message: 'Station command failed. Check arguments and local configuration.' } };
}
export function cliErrorExitCode(error: unknown): number { return error instanceof CommandWaitError ? error.exitCode : 1; }
