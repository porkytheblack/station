import type { AnySignal, Signal } from "simple-signal";
import { isSignal, parseInterval } from "simple-signal";
import { getBroadcastAdapter } from "./config.js";
import { BroadcastValidationError } from "./errors.js";
import type { BroadcastRun, FailurePolicy } from "./types.js";
import { BROADCAST_BRAND, topologicalSort } from "./util.js";

/** A named node in the broadcast DAG. */
export interface BroadcastNode {
  readonly name: string;
  readonly signalName: string;
  /** Reference to the actual Signal object — used for input validation via signal.trigger(). */
  readonly signal: AnySignal;
  readonly dependsOn: readonly string[];
  readonly timeout: number;
  readonly maxAttempts: number;
  readonly map?: (upstream: Record<string, unknown>) => unknown;
  readonly when?: (upstream: Record<string, unknown>) => boolean;
}

export interface BroadcastDefinition {
  readonly [BROADCAST_BRAND]: true;
  readonly name: string;
  readonly nodes: readonly BroadcastNode[];
  readonly failurePolicy: FailurePolicy;
  /** Max time (ms) the entire broadcast may run before being auto-failed. */
  readonly timeout?: number;
  readonly interval?: string;
  readonly recurringInput?: unknown;
  trigger(input: unknown): Promise<string>;
}

export interface ThenOptions {
  /** Node label (defaults to signal name). */
  as?: string;
  /** Explicit upstream dependencies (defaults to all nodes in the previous tier). */
  after?: string[];
  /** Transform upstream outputs into this node's input. */
  map?: (upstream: Record<string, unknown>) => unknown;
  /** Conditional guard — skip this node if the predicate returns false. */
  when?: (upstream: Record<string, unknown>) => boolean;
}

export class BroadcastChain<TInput> {
  /** @internal */
  readonly _name: string;
  /** @internal */
  readonly _nodes: BroadcastNode[];
  /** @internal */
  readonly _lastTier: string[];
  /** @internal */
  readonly _failurePolicy: FailurePolicy;
  /** @internal */
  readonly _timeout?: number;
  /** @internal */
  readonly _interval?: string;
  /** @internal */
  readonly _recurringInput?: unknown;

  /** @internal */
  constructor(opts: {
    name: string;
    nodes: BroadcastNode[];
    lastTier: string[];
    failurePolicy: FailurePolicy;
    timeout?: number;
    interval?: string;
    recurringInput?: unknown;
  }) {
    this._name = opts.name;
    this._nodes = opts.nodes;
    this._lastTier = opts.lastTier;
    this._failurePolicy = opts.failurePolicy;
    this._timeout = opts.timeout;
    this._interval = opts.interval;
    this._recurringInput = opts.recurringInput;
  }

  /** @internal */
  private _clone(overrides: Partial<ConstructorParameters<typeof BroadcastChain>[0]> = {}): BroadcastChain<TInput> {
    return new BroadcastChain<TInput>({
      name: this._name,
      nodes: this._nodes,
      lastTier: this._lastTier,
      failurePolicy: this._failurePolicy,
      timeout: this._timeout,
      interval: this._interval,
      recurringInput: this._recurringInput,
      ...overrides,
    });
  }

  /**
   * Add one or more signals to the DAG.
   *
   * - `.then(signal)` — runs after the previous tier, pass-through data
   * - `.then(signal, { as, after, map, when })` — single signal with options
   * - `.then(signal1, signal2, ...)` — fan-out: all run in parallel after previous tier
   */
  then(...args: (AnySignal | ThenOptions)[]): BroadcastChain<TInput> {
    const signals: AnySignal[] = [];
    let options: ThenOptions | undefined;

    for (const arg of args) {
      if (isSignal(arg)) {
        signals.push(arg);
      } else if (typeof arg === "object" && arg !== null) {
        options = arg as ThenOptions;
      }
    }

    if (signals.length === 0) {
      throw new BroadcastValidationError(
        `then() requires at least one signal in broadcast "${this._name}".`,
      );
    }

    // Single signal with options
    if (signals.length === 1) {
      const sig = signals[0];
      const nodeName = options?.as ?? sig.name;
      const deps = options?.after ? [...options.after] : [...this._lastTier];

      const node: BroadcastNode = {
        name: nodeName,
        signalName: sig.name,
        signal: sig,
        dependsOn: deps,
        timeout: sig.timeout,
        maxAttempts: sig.maxAttempts,
        map: options?.map,
        when: options?.when,
      };

      return this._clone({ nodes: [...this._nodes, node], lastTier: [nodeName] });
    }

    // Fan-out with options is ambiguous — throw an error
    if (options) {
      throw new BroadcastValidationError(
        `Options (as, after, map, when) cannot be used with fan-out (multiple signals) in broadcast "${this._name}". ` +
        `Use separate .then() calls with options for each signal instead.`,
      );
    }

    // Fan-out: multiple signals, all depend on the last tier
    const newNodes: BroadcastNode[] = [];
    const newTier: string[] = [];

    for (const sig of signals) {
      newNodes.push({
        name: sig.name,
        signalName: sig.name,
        signal: sig,
        dependsOn: [...this._lastTier],
        timeout: sig.timeout,
        maxAttempts: sig.maxAttempts,
      });
      newTier.push(sig.name);
    }

    return this._clone({ nodes: [...this._nodes, ...newNodes], lastTier: newTier });
  }

  /** Set a broadcast-level timeout (ms). Auto-fails the broadcast if exceeded. */
  timeout(ms: number): BroadcastChain<TInput> {
    return this._clone({ timeout: ms });
  }

  every(interval: string): BroadcastChain<TInput> {
    parseInterval(interval);
    return this._clone({ interval });
  }

  withInput(input: TInput): BroadcastChain<TInput> {
    return this._clone({ recurringInput: input });
  }

  onFailure(policy: FailurePolicy): BroadcastChain<TInput> {
    return this._clone({ failurePolicy: policy });
  }

  build(): BroadcastDefinition {
    this.validate();

    const name = this._name;
    const nodes = [...this._nodes];
    const failurePolicy = this._failurePolicy;
    const timeout = this._timeout;
    const interval = this._interval;
    const recurringInput = this._recurringInput;

    return {
      [BROADCAST_BRAND]: true as const,
      name,
      nodes,
      failurePolicy,
      timeout,
      interval,
      recurringInput,
      async trigger(input: unknown): Promise<string> {
        const adapter = getBroadcastAdapter();
        const id = adapter.generateId();
        const run: BroadcastRun = {
          id,
          broadcastName: name,
          input: JSON.stringify(input),
          status: "pending",
          failurePolicy,
          timeout,
          createdAt: new Date(),
        };
        await adapter.addBroadcastRun(run);
        return id;
      },
    };
  }

  private validate(): void {
    const names = new Set<string>();

    // Check for duplicate node names
    for (const node of this._nodes) {
      if (names.has(node.name)) {
        throw new BroadcastValidationError(
          `Duplicate node name "${node.name}" in broadcast "${this._name}". ` +
          `Use the "as" option to disambiguate.`,
        );
      }
      names.add(node.name);
    }

    // Check for missing dependencies
    for (const node of this._nodes) {
      for (const dep of node.dependsOn) {
        if (!names.has(dep)) {
          throw new BroadcastValidationError(
            `Node "${node.name}" depends on "${dep}", but no node named "${dep}" ` +
            `exists in broadcast "${this._name}".`,
          );
        }
      }
    }

    // Cycle detection via topological sort (throws BroadcastCycleError)
    topologicalSort(this._name, this._nodes);
  }
}

const VALID_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export class BroadcastBuilder {
  private _name: string;

  constructor(name: string) {
    if (!VALID_NAME.test(name)) {
      throw new Error(
        `Invalid broadcast name "${name}". Names must start with a letter and contain only letters, digits, hyphens, and underscores.`,
      );
    }
    this._name = name;
  }

  /** Set the root signal — the entry point of the broadcast. Input type is inferred from the signal. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input<T>(rootSignal: Signal<T, any>): BroadcastChain<T> {
    const node: BroadcastNode = {
      name: rootSignal.name,
      signalName: rootSignal.name,
      signal: rootSignal,
      dependsOn: [],
      timeout: rootSignal.timeout,
      maxAttempts: rootSignal.maxAttempts,
    };
    return new BroadcastChain<T>({
      name: this._name,
      nodes: [node],
      lastTier: [rootSignal.name],
      failurePolicy: "fail-fast",
    });
  }
}

export function broadcast(name: string): BroadcastBuilder {
  return new BroadcastBuilder(name);
}
