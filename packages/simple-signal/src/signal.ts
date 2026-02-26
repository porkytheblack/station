import type z from "zod";
import { getAdapter } from "./config.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type QueueEntry } from "./types.js";

export interface Signal<TInput = unknown> {
  readonly name: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly run: (input: TInput) => Promise<void>;
  readonly interval?: string;
  readonly timeout: number;
  readonly maxAttempts: number;
  trigger(input: TInput): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySignal = Signal<any>;

export class SignalBuilder<TInput = unknown> {
  private _name: string;
  private _inputSchema?: z.ZodType<TInput>;
  private _interval?: string;
  private _timeout: number = DEFAULT_TIMEOUT_MS;
  private _maxAttempts: number = DEFAULT_MAX_ATTEMPTS;

  constructor(name: string) {
    this._name = name;
  }

  input<T>(schema: z.ZodType<T>): SignalBuilder<T> {
    const builder = this as unknown as SignalBuilder<T>;
    builder._inputSchema = schema;
    return builder;
  }

  every(interval: string): this {
    this._interval = interval;
    return this;
  }

  /** Override the default 5-minute timeout (in milliseconds). */
  timeout(ms: number): this {
    this._timeout = ms;
    return this;
  }

  /** Number of retries after the first attempt fails. Total attempts = retries + 1. */
  retries(n: number): this {
    this._maxAttempts = n + 1;
    return this;
  }

  run(fn: (input: TInput) => Promise<void>): Signal<TInput> {
    if (!this._inputSchema) throw new Error("Input schema is required");

    const name = this._name;
    const inputSchema = this._inputSchema;
    const interval = this._interval;
    const timeout = this._timeout;
    const maxAttempts = this._maxAttempts;

    const sig: Signal<TInput> = {
      name,
      inputSchema,
      run: fn,
      interval,
      timeout,
      maxAttempts,
      async trigger(input: TInput): Promise<string> {
        const result = inputSchema.safeParse(input);
        if (!result.success) {
          throw new Error(
            `Invalid input for "${name}": ${result.error.message}`,
          );
        }
        const id = getAdapter().generateId();
        const entry: QueueEntry = {
          id,
          signalName: name,
          kind: "trigger",
          input: JSON.stringify(result.data),
          status: "pending",
          attempts: 0,
          maxAttempts,
          timeout,
          createdAt: new Date(),
        };
        await getAdapter().add(entry);
        return id;
      },
    };

    return sig;
  }
}

export function signal(name: string): SignalBuilder {
  return new SignalBuilder(name);
}
