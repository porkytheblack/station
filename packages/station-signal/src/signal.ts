import { z } from "zod";
import { getAdapter, getTriggerAdapter, notifyLocalEnqueue } from "./config.js";
import { SignalValidationError } from "./errors.js";
import { parseInterval } from "./interval.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type Run, type StepDefinition } from "./types.js";
import { SIGNAL_BRAND } from "./util.js";

const VALID_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  readonly networkConcurrency?: number;
  readonly placement?: SignalPlacement;
  readonly recurringInput?: TInput;
  /** Env var keys that must be present (store-managed or process env) for a run to dispatch. */
  readonly requiredEnv?: string[];
  trigger(input: TInput): Promise<string>;
}

export interface SignalPlacement {
  /** Station labels that must match exactly before this signal may be claimed. */
  labels?: Record<string, string>;
}

export interface SignalConcurrency {
  /** Concurrent runs of this signal allowed in one station. */
  station?: number;
  /** Concurrent runs of this signal allowed across the Station Network. */
  network?: number;
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
  networkConcurrency?: number;
  placement?: SignalPlacement;
  recurringInput?: TInput;
  requiredEnv?: string[];
}

function buildSignal<TInput, TOutput>(config: SignalConfig<TInput, TOutput>): Signal<TInput, TOutput> {
  const {
    name, inputSchema, outputSchema, handler, steps,
    onCompleteHandler, interval, timeout, maxAttempts,
    maxConcurrency, networkConcurrency, placement, recurringInput, requiredEnv,
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
    networkConcurrency,
    placement,
    recurringInput,
    requiredEnv,
    async trigger(input: TInput): Promise<string> {
      const result = inputSchema.safeParse(input);
      if (!result.success) {
        throw new SignalValidationError(name, result.error.message);
      }

      // Remote trigger path
      const triggerAdapter = getTriggerAdapter();
      if (triggerAdapter) {
        return triggerAdapter.trigger(name, result.data);
      }

      // Local trigger path
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
      notifyLocalEnqueue();
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
  private _networkConcurrency?: number;
  private _placement?: SignalPlacement;
  private _recurringInput?: TInput;
  private _requiredEnv?: string[];

  /** @internal */
  constructor(
    name: string,
    inputSchema: z.ZodType<TInput>,
    steps: StepDefinition[],
    opts: { interval?: string; timeout: number; maxAttempts: number; maxConcurrency?: number; networkConcurrency?: number; placement?: SignalPlacement; recurringInput?: TInput; requiredEnv?: string[] },
  ) {
    this._name = name;
    this._inputSchema = inputSchema;
    this._steps = steps;
    this._interval = opts.interval;
    this._timeout = opts.timeout;
    this._maxAttempts = opts.maxAttempts;
    this._maxConcurrency = opts.maxConcurrency;
    this._networkConcurrency = opts.networkConcurrency;
    this._placement = opts.placement;
    this._recurringInput = opts.recurringInput;
    this._requiredEnv = opts.requiredEnv;
  }

  step<TNext>(name: string, fn: (prev: TLast) => Promise<TNext>): StepBuilder<TInput, TNext> {
    return new StepBuilder<TInput, TNext>(
      this._name,
      this._inputSchema,
      [...this._steps, { name, fn: fn as unknown as (prev: unknown) => Promise<unknown> }],
      { interval: this._interval, timeout: this._timeout, maxAttempts: this._maxAttempts, maxConcurrency: this._maxConcurrency, networkConcurrency: this._networkConcurrency, placement: this._placement, recurringInput: this._recurringInput, requiredEnv: this._requiredEnv },
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
      networkConcurrency: this._networkConcurrency,
      placement: this._placement,
      recurringInput: this._recurringInput,
      requiredEnv: this._requiredEnv,
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
      networkConcurrency: this._networkConcurrency,
      placement: this._placement,
      recurringInput: this._recurringInput,
      requiredEnv: this._requiredEnv,
    });
  }
}

/**
 * A signal that has been built with .run() but not yet had .onComplete() called.
 */
export interface BuiltSignal<TInput, TOutput> extends Signal<TInput, TOutput> {
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
  private _networkConcurrency?: number;
  private _placement?: SignalPlacement;
  private _recurringInput?: TInput;
  private _requiredEnv?: string[];

  constructor(name: string) {
    if (!VALID_NAME.test(name)) {
      throw new Error(
        `Invalid signal name "${name}". Names must start with a letter and contain only letters, digits, hyphens, and underscores.`,
      );
    }
    this._name = name;
  }

  // All builder methods return new instances (immutable builder pattern).
  // This prevents footguns where branching from a shared builder mutates the original.

  private _clone(): SignalBuilder<TInput, TOutput> {
    const b = new SignalBuilder<TInput, TOutput>(this._name);
    b._inputSchema = this._inputSchema;
    b._outputSchema = this._outputSchema;
    b._interval = this._interval;
    b._timeout = this._timeout;
    b._maxAttempts = this._maxAttempts;
    b._maxConcurrency = this._maxConcurrency;
    b._networkConcurrency = this._networkConcurrency;
    b._placement = this._placement;
    b._recurringInput = this._recurringInput;
    b._requiredEnv = this._requiredEnv;
    return b;
  }

  input<T>(schema: z.ZodType<T>): SignalBuilder<T, TOutput> {
    const b = new SignalBuilder<T, TOutput>(this._name);
    b._inputSchema = schema;
    b._outputSchema = this._outputSchema as unknown as z.ZodType<TOutput> | undefined;
    b._interval = this._interval;
    b._timeout = this._timeout;
    b._maxAttempts = this._maxAttempts;
    b._maxConcurrency = this._maxConcurrency;
    b._networkConcurrency = this._networkConcurrency;
    b._placement = this._placement;
    b._requiredEnv = this._requiredEnv;
    return b;
  }

  output<T>(schema: z.ZodType<T>): SignalBuilder<TInput, T> {
    const b = new SignalBuilder<TInput, T>(this._name);
    b._inputSchema = this._inputSchema as unknown as z.ZodType<TInput> | undefined;
    b._outputSchema = schema;
    b._interval = this._interval;
    b._timeout = this._timeout;
    b._maxAttempts = this._maxAttempts;
    b._maxConcurrency = this._maxConcurrency;
    b._networkConcurrency = this._networkConcurrency;
    b._placement = this._placement;
    b._recurringInput = this._recurringInput as unknown as TInput | undefined;
    b._requiredEnv = this._requiredEnv;
    return b;
  }

  every(interval: string): SignalBuilder<TInput, TOutput> {
    parseInterval(interval); // validate eagerly
    const b = this._clone();
    b._interval = interval;
    return b;
  }

  timeout(ms: number): SignalBuilder<TInput, TOutput> {
    const b = this._clone();
    b._timeout = ms;
    return b;
  }

  retries(n: number): SignalBuilder<TInput, TOutput> {
    const b = this._clone();
    b._maxAttempts = n + 1;
    return b;
  }

  concurrency(value: number | SignalConcurrency): SignalBuilder<TInput, TOutput> {
    const b = this._clone();
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 1) throw new Error("Signal concurrency must be a positive integer.");
      b._maxConcurrency = value;
    } else {
      if (value.station !== undefined && (!Number.isInteger(value.station) || value.station < 1)) {
        throw new Error("Station concurrency must be a positive integer.");
      }
      if (value.network !== undefined && (!Number.isInteger(value.network) || value.network < 1)) {
        throw new Error("Network concurrency must be a positive integer.");
      }
      b._maxConcurrency = value.station;
      b._networkConcurrency = value.network;
    }
    return b;
  }

  placement(policy: SignalPlacement): SignalBuilder<TInput, TOutput> {
    const b = this._clone();
    b._placement = { labels: policy.labels ? { ...policy.labels } : undefined };
    return b;
  }

  withInput(input: TInput): SignalBuilder<TInput, TOutput> {
    const b = this._clone();
    b._recurringInput = input;
    return b;
  }

  /**
   * Declare env vars this signal needs. Before dispatching a run, the runner
   * verifies each key is available — from the runner's env provider (the
   * Station env store) or the host process env — and fails the run with a
   * clear error when any is missing. Provided vars are injected into the
   * child process env, so handlers read them via `process.env.KEY` as usual.
   */
  env(...keys: string[]): SignalBuilder<TInput, TOutput> {
    for (const key of keys) {
      if (!VALID_ENV_KEY.test(key)) {
        throw new Error(
          `Invalid env key "${key}" for signal "${this._name}". Keys must start with a letter or underscore and contain only letters, digits, and underscores.`,
        );
      }
    }
    const b = this._clone();
    const merged = [...(this._requiredEnv ?? []), ...keys];
    b._requiredEnv = Array.from(new Set(merged));
    return b;
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
      networkConcurrency: this._networkConcurrency,
      placement: this._placement,
      recurringInput: this._recurringInput,
      requiredEnv: this._requiredEnv,
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
      { interval: cfg.interval, timeout: cfg.timeout, maxAttempts: cfg.maxAttempts, maxConcurrency: cfg.maxConcurrency, networkConcurrency: cfg.networkConcurrency, placement: cfg.placement, recurringInput: cfg.recurringInput, requiredEnv: cfg.requiredEnv },
    );
  }
}

export function signal(name: string): SignalBuilder {
  return new SignalBuilder(name);
}
