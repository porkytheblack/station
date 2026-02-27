import { z } from "zod";
import { getAdapter } from "./config.js";
import { SignalValidationError } from "./errors.js";
import { parseInterval } from "./interval.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type Run, type StepDefinition } from "./types.js";
import { SIGNAL_BRAND } from "./util.js";

const VALID_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export interface Signal<TInput = unknown, TOutput = void> {
  readonly [SIGNAL_BRAND]: true;
  readonly name: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema?: z.ZodType<TOutput>;
  readonly handler?: (input: TInput) => Promise<TOutput>;
  readonly steps?: StepDefinition[];
  readonly onCompleteHandler?: (output: TOutput, input: TInput) => Promise<void>;
  readonly interval?: string;
  readonly timeout: number;
  readonly maxAttempts: number;
  readonly maxConcurrency?: number;
  readonly recurringInput?: TInput;
  trigger(input: TInput): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySignal = Signal<any, any>;

interface SignalConfig<TInput, TOutput> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  handler?: (input: TInput) => Promise<TOutput>;
  steps?: StepDefinition[];
  onCompleteHandler?: (output: TOutput, input: TInput) => Promise<void>;
  interval?: string;
  timeout: number;
  maxAttempts: number;
  maxConcurrency?: number;
  recurringInput?: TInput;
}

function buildSignal<TInput, TOutput>(config: SignalConfig<TInput, TOutput>): Signal<TInput, TOutput> {
  const {
    name, inputSchema, outputSchema, handler, steps,
    onCompleteHandler, interval, timeout, maxAttempts,
    maxConcurrency, recurringInput,
  } = config;

  return {
    [SIGNAL_BRAND]: true as const,
    name,
    inputSchema,
    outputSchema,
    handler,
    steps,
    onCompleteHandler,
    interval,
    timeout,
    maxAttempts,
    maxConcurrency,
    recurringInput,
    async trigger(input: TInput): Promise<string> {
      const result = inputSchema.safeParse(input);
      if (!result.success) {
        throw new SignalValidationError(name, result.error.message);
      }
      const id = getAdapter().generateId();
      const run: Run = {
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
      await getAdapter().addRun(run);
      return id;
    },
  };
}

/**
 * Builder for step-based signals with full type safety.
 * Each `.step()` call carries the output type forward to the next step's input.
 */
export class StepBuilder<TInput, TLast> {
  private _name: string;
  private _inputSchema: z.ZodType<TInput>;
  private _steps: StepDefinition[];
  private _interval?: string;
  private _timeout: number;
  private _maxAttempts: number;
  private _maxConcurrency?: number;
  private _recurringInput?: TInput;

  /** @internal */
  constructor(
    name: string,
    inputSchema: z.ZodType<TInput>,
    steps: StepDefinition[],
    opts: { interval?: string; timeout: number; maxAttempts: number; maxConcurrency?: number; recurringInput?: TInput },
  ) {
    this._name = name;
    this._inputSchema = inputSchema;
    this._steps = steps;
    this._interval = opts.interval;
    this._timeout = opts.timeout;
    this._maxAttempts = opts.maxAttempts;
    this._maxConcurrency = opts.maxConcurrency;
    this._recurringInput = opts.recurringInput;
  }

  step<TNext>(name: string, fn: (prev: TLast) => Promise<TNext>): StepBuilder<TInput, TNext> {
    return new StepBuilder<TInput, TNext>(
      this._name,
      this._inputSchema,
      [...this._steps, { name, fn: fn as unknown as (prev: unknown) => Promise<unknown> }],
      { interval: this._interval, timeout: this._timeout, maxAttempts: this._maxAttempts, maxConcurrency: this._maxConcurrency, recurringInput: this._recurringInput },
    );
  }

  onComplete(fn: (output: TLast, input: TInput) => Promise<void>): Signal<TInput, TLast> {
    return buildSignal<TInput, TLast>({
      name: this._name,
      inputSchema: this._inputSchema,
      steps: this._steps,
      onCompleteHandler: fn,
      interval: this._interval,
      timeout: this._timeout,
      maxAttempts: this._maxAttempts,
      maxConcurrency: this._maxConcurrency,
      recurringInput: this._recurringInput,
    });
  }

  build(): Signal<TInput, TLast> {
    return buildSignal<TInput, TLast>({
      name: this._name,
      inputSchema: this._inputSchema,
      steps: this._steps,
      interval: this._interval,
      timeout: this._timeout,
      maxAttempts: this._maxAttempts,
      maxConcurrency: this._maxConcurrency,
      recurringInput: this._recurringInput,
    });
  }
}

/**
 * A signal that has been built with .run() but not yet had .onComplete() called.
 */
interface BuiltSignal<TInput, TOutput> extends Signal<TInput, TOutput> {
  onComplete(fn: (output: TOutput, input: TInput) => Promise<void>): Signal<TInput, TOutput>;
}

export class SignalBuilder<TInput = unknown, TOutput = void> {
  private _name: string;
  private _inputSchema?: z.ZodType<TInput>;
  private _outputSchema?: z.ZodType<TOutput>;
  private _interval?: string;
  private _timeout: number = DEFAULT_TIMEOUT_MS;
  private _maxAttempts: number = DEFAULT_MAX_ATTEMPTS;
  private _maxConcurrency?: number;
  private _recurringInput?: TInput;

  constructor(name: string) {
    if (!VALID_NAME.test(name)) {
      throw new Error(
        `Invalid signal name "${name}". Names must start with a letter and contain only letters, digits, hyphens, and underscores.`,
      );
    }
    this._name = name;
  }

  private _clone<TI, TO>(): SignalBuilder<TI, TO> {
    const b = new SignalBuilder<TI, TO>(this._name);
    b._inputSchema = this._inputSchema as unknown as z.ZodType<TI> | undefined;
    b._outputSchema = this._outputSchema as unknown as z.ZodType<TO> | undefined;
    b._interval = this._interval;
    b._timeout = this._timeout;
    b._maxAttempts = this._maxAttempts;
    b._maxConcurrency = this._maxConcurrency;
    return b;
  }

  input<T>(schema: z.ZodType<T>): SignalBuilder<T, TOutput> {
    const b = this._clone<T, TOutput>();
    b._inputSchema = schema;
    return b;
  }

  output<T>(schema: z.ZodType<T>): SignalBuilder<TInput, T> {
    const b = this._clone<TInput, T>();
    b._outputSchema = schema;
    return b;
  }

  every(interval: string): this {
    parseInterval(interval); // validate eagerly (L5)
    const b = this._clone<TInput, TOutput>();
    b._interval = interval;
    return b as unknown as this;
  }

  timeout(ms: number): this {
    const b = this._clone<TInput, TOutput>();
    b._timeout = ms;
    return b as unknown as this;
  }

  retries(n: number): this {
    const b = this._clone<TInput, TOutput>();
    b._maxAttempts = n + 1;
    return b as unknown as this;
  }

  concurrency(n: number): this {
    const b = this._clone<TInput, TOutput>();
    b._maxConcurrency = n;
    return b as unknown as this;
  }

  withInput(input: TInput): this {
    const b = this._clone<TInput, TOutput>();
    b._recurringInput = input;
    return b as unknown as this;
  }

  private _config(): Omit<SignalConfig<TInput, TOutput>, "handler" | "steps" | "onCompleteHandler"> {
    return {
      name: this._name,
      inputSchema: this._inputSchema ?? z.object({}) as unknown as z.ZodType<TInput>,
      outputSchema: this._outputSchema,
      interval: this._interval,
      timeout: this._timeout,
      maxAttempts: this._maxAttempts,
      maxConcurrency: this._maxConcurrency,
      recurringInput: this._recurringInput,
    };
  }

  run(fn: (input: TInput) => Promise<TOutput>): BuiltSignal<TInput, TOutput> {
    const config: SignalConfig<TInput, TOutput> = { ...this._config(), handler: fn };
    const sig = buildSignal(config);
    return Object.assign(sig, {
      onComplete(onCompleteFn: (output: TOutput, input: TInput) => Promise<void>): Signal<TInput, TOutput> {
        return buildSignal({ ...config, onCompleteHandler: onCompleteFn });
      },
    });
  }

  /** Start a typed step chain. First step receives TInput. */
  step<TNext>(name: string, fn: (prev: TInput) => Promise<TNext>): StepBuilder<TInput, TNext> {
    const cfg = this._config();
    return new StepBuilder<TInput, TNext>(
      this._name,
      cfg.inputSchema,
      [{ name, fn: fn as unknown as (prev: unknown) => Promise<unknown> }],
      { interval: cfg.interval, timeout: cfg.timeout, maxAttempts: cfg.maxAttempts, maxConcurrency: cfg.maxConcurrency, recurringInput: cfg.recurringInput },
    );
  }
}

export function signal(name: string): SignalBuilder {
  return new SignalBuilder(name);
}
