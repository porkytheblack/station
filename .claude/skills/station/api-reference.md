# Station API Reference

Complete reference for all Station packages. Every export, type, interface, and method signature.

---

## 1. station-signal

### Exports

```ts
import {
  // Builder
  signal, SignalBuilder, StepBuilder,
  // Runner
  SignalRunner,
  // Configuration
  configure, getAdapter, getTriggerAdapter, isConfigured,
  // Interval parser
  parseInterval,
  // Adapters
  MemoryAdapter, registerAdapter, createAdapter, hasAdapter,
  isSerializableAdapter,
  // Subscribers
  ConsoleSubscriber,
  // Remote trigger
  HttpTriggerAdapter,
  // Type guards
  isSignal, SIGNAL_BRAND,
  // Zod re-export
  z,
  // Constants
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_ATTEMPTS,
  // Types
  type Signal, type AnySignal,
  type SignalRunnerOptions,
  type ConfigureOptions,
  type Run, type RunKind, type RunStatus, type RunPatch,
  type Step, type StepStatus, type StepPatch, type StepDefinition,
  type SignalQueueAdapter, type SerializableAdapter, type AdapterManifest,
  type SignalSubscriber, type IPCMessage,
  type TriggerAdapter,
  type HttpTriggerOptions,
  // Errors
  SignalValidationError, SignalTimeoutError, SignalNotFoundError, StationRemoteError,
} from "station-signal";
```

### Constants

```ts
const DEFAULT_TIMEOUT_MS = 300_000;  // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 1;      // no retry by default
```

### signal() Builder

```ts
function signal(name: string): SignalBuilder;
```

Name must match `/^[a-zA-Z][a-zA-Z0-9_-]*$/`.

#### SignalBuilder

```ts
class SignalBuilder<TInput = unknown, TOutput = void> {
  constructor(name: string);

  /** Set input schema. Infers TInput from Zod type. */
  input<T>(schema: z.ZodType<T>): SignalBuilder<T, TOutput>;

  /** Set output schema. Infers TOutput from Zod type. */
  output<T>(schema: z.ZodType<T>): SignalBuilder<TInput, T>;

  /** Set recurring interval. Format: "<number><s|m|h|d>" (e.g. "5m", "1h"). */
  every(interval: string): SignalBuilder<TInput, TOutput>;

  /** Set timeout in milliseconds. Default: 300000 (5 min). */
  timeout(ms: number): SignalBuilder<TInput, TOutput>;

  /** Set retries. maxAttempts = n + 1. Default: 0 retries (1 attempt). */
  retries(n: number): SignalBuilder<TInput, TOutput>;

  /** Set max concurrent runs for this signal. */
  concurrency(n: number): SignalBuilder<TInput, TOutput>;

  /** Set default input for recurring signals. */
  withInput(input: TInput): SignalBuilder<TInput, TOutput>;

  /** Single-handler signal. Returns BuiltSignal with optional .onComplete(). */
  run(fn: (input: TInput) => Promise<TOutput>): BuiltSignal<TInput, TOutput>;

  /** Start a step chain. First step receives TInput. */
  step<TNext>(name: string, fn: (prev: TInput) => Promise<TNext>): StepBuilder<TInput, TNext>;
}
```

#### BuiltSignal (returned by `.run()`)

```ts
interface BuiltSignal<TInput, TOutput> extends Signal<TInput, TOutput> {
  onComplete(fn: (output: TOutput, input: TInput) => Promise<void>): Signal<TInput, TOutput>;
}
```

#### StepBuilder

```ts
class StepBuilder<TInput, TLast> {
  /** Add another step. Input is previous step's output. */
  step<TNext>(name: string, fn: (prev: TLast) => Promise<TNext>): StepBuilder<TInput, TNext>;

  /** Add an onComplete handler and finalize. */
  onComplete(fn: (output: TLast, input: TInput) => Promise<void>): Signal<TInput, TLast>;

  /** Finalize without onComplete handler. */
  build(): Signal<TInput, TLast>;
}
```

#### Usage patterns

```ts
// Single-handler signal
const mySignal = signal("my-signal")
  .input(z.object({ url: z.string() }))
  .output(z.object({ status: z.number() }))
  .timeout(60_000)
  .retries(2)
  .run(async (input) => {
    return { status: 200 };
  });

// Single-handler with onComplete
const withComplete = signal("with-complete")
  .input(z.object({ id: z.string() }))
  .run(async (input) => {
    return { processed: true };
  })
  .onComplete(async (output, input) => {
    console.log("Done:", output);
  });

// Step-based signal
const pipeline = signal("pipeline")
  .input(z.object({ data: z.string() }))
  .step("parse", async (input) => {
    return { parsed: JSON.parse(input.data) };
  })
  .step("transform", async (prev) => {
    return { transformed: prev.parsed };
  })
  .onComplete(async (output, input) => {
    console.log("Pipeline done:", output);
  });

// Recurring signal
const recurring = signal("health-check")
  .input(z.object({ endpoint: z.string() }))
  .every("5m")
  .withInput({ endpoint: "https://api.example.com" })
  .run(async (input) => {
    const res = await fetch(input.endpoint);
    return { ok: res.ok };
  });
```

### Signal Interface

```ts
interface Signal<TInput = unknown, TOutput = void> {
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

  /**
   * Trigger the signal. Validates input against inputSchema.
   * Returns the run ID.
   *
   * If a TriggerAdapter is configured (remote mode), sends to remote server.
   * Otherwise writes directly to the local adapter.
   */
  trigger(input: TInput): Promise<string>;
}

type AnySignal = Signal<any, any>;
```

### SignalRunner

```ts
interface SignalRunnerOptions {
  signalsDir?: string;
  adapter?: SignalQueueAdapter;
  pollIntervalMs?: number;          // default: 1000
  maxAttempts?: number;              // default: 1
  subscribers?: SignalSubscriber[];
  maxConcurrent?: number;            // default: 5
  retryBackoffMs?: number;           // default: 1000
}

class SignalRunner {
  constructor(options?: SignalRunnerOptions);

  /**
   * Convenience factory. Auto-discovers signals from signalsDir.
   * Defaults to [ConsoleSubscriber()] if no subscribers provided.
   */
  static create(signalsDir: string, options?: Omit<SignalRunnerOptions, "signalsDir">): SignalRunner;

  /** The underlying queue adapter. */
  getAdapter(): SignalQueueAdapter;

  /** Register a signal by name and file path. */
  register(name: string, filePath: string, options?: { maxConcurrency?: number }): this;

  /** Add a subscriber. */
  subscribe(subscriber: SignalSubscriber): this;

  /** List all registered signals with metadata. */
  listRegistered(): Array<{ name: string; filePath: string; maxConcurrency?: number }>;

  /** Check whether a signal is registered by name. */
  hasSignal(name: string): boolean;

  /** Get a run by ID. */
  getRun(id: string): Promise<Run | null>;

  /** List all runs for a signal. */
  listRuns(signalName: string): Promise<Run[]>;

  /** Get steps for a run. */
  getSteps(runId: string): Promise<Step[]>;

  /**
   * Wait for a run to reach a terminal status (completed, failed, cancelled).
   * Returns the run, or null if not found (and waitForExistence is false).
   */
  waitForRun(runId: string, opts?: {
    pollMs?: number;           // default: 200
    timeoutMs?: number;        // default: 60000
    waitForExistence?: boolean; // default: false
  }): Promise<Run | null>;

  /** Purge completed/failed/cancelled runs older than the given age. Returns count deleted. */
  purgeCompleted(olderThanMs: number): Promise<number>;

  /** Cancel a run. Marks as cancelled and kills child process. Returns false if already terminal. */
  cancel(runId: string): Promise<boolean>;

  /** Start the runner loop. Blocks until stop() is called. */
  start(): Promise<void>;

  /** Stop the runner. Optionally wait for active children. */
  stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;
}
```

### configure()

```ts
interface ConfigureOptions {
  /** Local adapter for in-process signal storage. */
  adapter?: SignalQueueAdapter;
  /** Remote Station server endpoint (e.g. "https://station.example.com"). */
  endpoint?: string;
  /** API key for authenticating with the remote Station server. */
  apiKey?: string;
  /** Custom trigger adapter (advanced -- overrides endpoint/apiKey). */
  triggerAdapter?: TriggerAdapter;
}

function configure(options: ConfigureOptions): void;
function getAdapter(): SignalQueueAdapter;
function getTriggerAdapter(): TriggerAdapter | null;
function isConfigured(): boolean;
```

Auto-configuration from environment variables on first access:
- `STATION_ENDPOINT` -- sets endpoint
- `STATION_API_KEY` -- sets apiKey

### Run Type

```ts
type RunKind = "trigger" | "recurring";
type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface Run {
  id: string;
  signalName: string;
  kind: RunKind;
  input: string;           // JSON-serialized
  output?: string;         // JSON-serialized TOutput
  error?: string;
  status: RunStatus;
  attempts: number;
  maxAttempts: number;
  timeout: number;         // ms
  interval?: string;       // e.g. "5m" (recurring only)
  nextRunAt?: Date;
  lastRunAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

type RunPatch = Partial<Omit<Run, "id" | "signalName" | "kind" | "createdAt">>;
```

### Step Type

```ts
type StepStatus = "pending" | "running" | "completed" | "failed";

interface Step {
  id: string;
  runId: string;
  name: string;
  status: StepStatus;
  input?: string;      // JSON
  output?: string;     // JSON
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

type StepPatch = Partial<Omit<Step, "id" | "runId" | "name">>;

interface StepDefinition {
  name: string;
  fn: (prev: unknown) => Promise<unknown>;
}
```

### SignalQueueAdapter Interface

```ts
interface SignalQueueAdapter {
  // Run methods
  addRun(run: Run): Promise<void>;
  removeRun(id: string): Promise<void>;
  getRunsDue(): Promise<Run[]>;
  getRunsRunning(): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  listRuns(signalName: string): Promise<Run[]>;
  hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean>;
  purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number>;

  // Step methods
  addStep(step: Step): Promise<void>;
  updateStep(id: string, patch: StepPatch): Promise<void>;
  getSteps(runId: string): Promise<Step[]>;
  removeSteps(runId: string): Promise<void>;

  // Utility
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}
```

### SerializableAdapter Interface

```ts
interface AdapterManifest {
  name: string;
  options: Record<string, unknown>;
  moduleUrl?: string;
}

interface SerializableAdapter extends SignalQueueAdapter {
  toManifest(): AdapterManifest;
}

function isSerializableAdapter(adapter: SignalQueueAdapter): adapter is SerializableAdapter;
```

### MemoryAdapter

```ts
class MemoryAdapter implements SignalQueueAdapter {
  constructor(options?: { maxRuns?: number }); // default: 10000
}
```

Does NOT implement `SerializableAdapter`. Cannot share state across processes.

### Adapter Registry

```ts
function registerAdapter(name: string, factory: (options: Record<string, unknown>) => SignalQueueAdapter): void;
function createAdapter(name: string, options?: Record<string, unknown>): SignalQueueAdapter;
function hasAdapter(name: string): boolean;
```

### SignalSubscriber Interface

All methods are optional. Implement only what you need.

```ts
interface SignalSubscriber {
  onSignalDiscovered?(event: { signalName: string; filePath: string }): void;
  onRunDispatched?(event: { run: Run }): void;
  onRunStarted?(event: { run: Run }): void;
  onRunCompleted?(event: { run: Run; output?: string }): void;
  onRunTimeout?(event: { run: Run }): void;
  onRunRetry?(event: { run: Run; attempt: number; maxAttempts: number }): void;
  onRunFailed?(event: { run: Run; error?: string }): void;
  onRunCancelled?(event: { run: Run }): void;
  onRunSkipped?(event: { run: Run; reason: string }): void;
  onRunRescheduled?(event: { run: Run; nextRunAt: Date }): void;
  onStepStarted?(event: { run: Run; step: Pick<Step, "id" | "runId" | "name"> }): void;
  onStepCompleted?(event: { run: Run; step: Step }): void;
  onStepFailed?(event: { run: Run; step: Step }): void;
  onCompleteError?(event: { run: Run; error: string }): void;
  onLogOutput?(event: { run: Run; level: "stdout" | "stderr"; message: string }): void;
}
```

### ConsoleSubscriber

```ts
class ConsoleSubscriber implements SignalSubscriber {
  // Logs all events to console with "[station-signal]" prefix.
  // Implements every method on SignalSubscriber.
}
```

### TriggerAdapter Interface

```ts
interface TriggerAdapter {
  trigger(signalName: string, input: unknown): Promise<string>;
  triggerBroadcast?(broadcastName: string, input: unknown): Promise<string>;
  ping?(): Promise<boolean>;
}
```

### HttpTriggerAdapter

```ts
interface HttpTriggerOptions {
  endpoint: string;
  apiKey?: string;
  timeout?: number;       // default: 10000
  fetch?: typeof globalThis.fetch;
}

class HttpTriggerAdapter implements TriggerAdapter {
  constructor(options: HttpTriggerOptions);
  trigger(signalName: string, input: unknown): Promise<string>;
  triggerBroadcast(broadcastName: string, input: unknown): Promise<string>;
  ping(): Promise<boolean>;
}
```

### IPCMessage

```ts
interface IPCMessage {
  type: "run:started" | "run:completed" | "run:failed" | "step:completed" | "onComplete:error";
  runId: string;
  signalName: string;
  timestamp: string;
  data?: Record<string, unknown>;
}
```

### Error Classes

```ts
class SignalValidationError extends Error {
  readonly code = "SIGNAL_VALIDATION_ERROR";
  readonly signalName: string;
  constructor(signalName: string, zodMessage: string);
}

class SignalTimeoutError extends Error {
  readonly code = "SIGNAL_TIMEOUT";
  readonly signalName: string;
  readonly timeoutMs: number;
  constructor(signalName: string, timeoutMs: number);
}

class SignalNotFoundError extends Error {
  readonly code = "SIGNAL_NOT_FOUND";
  readonly signalName: string;
  readonly filePath: string;
  constructor(signalName: string, filePath: string);
}

class StationRemoteError extends Error {
  readonly code = "STATION_REMOTE_ERROR";
  readonly statusCode: number;
  readonly remoteError?: string;
  constructor(statusCode: number, remoteError?: string, remoteMessage?: string);
}
```

### Utility

```ts
function parseInterval(interval: string): number;
// Parses "5m", "30s", "1h", "2d", or "every 5m" format. Returns milliseconds.
// Valid units: s (1000), m (60000), h (3600000), d (86400000)

function isSignal(value: unknown): value is AnySignal;
const SIGNAL_BRAND: unique symbol; // Symbol.for("station-signal")
```

---

## 2. station-broadcast

### Exports

```ts
import {
  // Builder
  broadcast, BroadcastBuilder, BroadcastChain,
  // Runner
  BroadcastRunner,
  // Configuration
  configureBroadcast, getBroadcastAdapter, isBroadcastConfigured,
  // Adapters
  BroadcastMemoryAdapter,
  // Subscribers
  ConsoleBroadcastSubscriber,
  // Type guards
  isBroadcast, BROADCAST_BRAND,
  // Types
  type BroadcastDefinition, type BroadcastNode, type ThenOptions,
  type BroadcastRunnerOptions,
  type BroadcastRun, type BroadcastRunStatus, type BroadcastRunPatch,
  type BroadcastNodeRun, type BroadcastNodeStatus, type BroadcastNodeRunPatch,
  type BroadcastNodeSkipReason,
  type BroadcastQueueAdapter,
  type BroadcastSubscriber, type FailurePolicy,
  // Errors
  BroadcastValidationError, BroadcastCycleError,
} from "station-broadcast";
```

### broadcast() Builder

```ts
function broadcast(name: string): BroadcastBuilder;
```

Name must match `/^[a-zA-Z][a-zA-Z0-9_-]*$/`.

#### BroadcastBuilder

```ts
class BroadcastBuilder {
  constructor(name: string);

  /** Set the root signal (entry point of the DAG). Infers input type. */
  input<T>(rootSignal: Signal<T, any>): BroadcastChain<T>;
}
```

#### BroadcastChain

```ts
class BroadcastChain<TInput> {
  /**
   * Add signal(s) to the DAG.
   *
   * Single signal:
   *   .then(signal)
   *   .then(signal, { as, after, map, when })
   *
   * Fan-out (parallel):
   *   .then(signalA, signalB, signalC)
   *   (No options allowed with fan-out)
   */
  then(...args: (AnySignal | ThenOptions)[]): BroadcastChain<TInput>;

  /** Set broadcast-level timeout in ms. Auto-fails if exceeded. */
  timeout(ms: number): BroadcastChain<TInput>;

  /** Set recurring interval. Format: "<number><s|m|h|d>". */
  every(interval: string): BroadcastChain<TInput>;

  /** Set default input for recurring broadcasts. */
  withInput(input: TInput): BroadcastChain<TInput>;

  /** Set failure policy. Default: "fail-fast". */
  onFailure(policy: FailurePolicy): BroadcastChain<TInput>;

  /** Finalize and return the BroadcastDefinition. Validates DAG (duplicates, missing deps, cycles). */
  build(): BroadcastDefinition;
}
```

#### ThenOptions

```ts
interface ThenOptions {
  /** Node label (defaults to signal name). */
  as?: string;
  /** Explicit upstream dependencies (defaults to all nodes in the previous tier). */
  after?: string[];
  /** Transform upstream outputs into this node's input. */
  map?: (upstream: Record<string, unknown>) => unknown;
  /** Conditional guard -- skip this node if returns false. */
  when?: (upstream: Record<string, unknown>) => boolean;
}
```

#### Usage patterns

```ts
// Linear pipeline
const pipeline = broadcast("my-pipeline")
  .input(fetchSignal)
  .then(parseSignal)
  .then(saveSignal)
  .build();

// Fan-out (parallel)
const fanOut = broadcast("fan-out")
  .input(fetchSignal)
  .then(emailSignal, slackSignal, smsSignal) // all run in parallel
  .then(summarySignal)                        // runs after all three complete
  .build();

// With options
const withOpts = broadcast("with-options")
  .input(fetchSignal)
  .then(processSignal, {
    as: "custom-name",
    map: (upstream) => ({ data: upstream["fetch-data"]?.result }),
    when: (upstream) => upstream["fetch-data"]?.status === "ok",
  })
  .onFailure("skip-downstream")
  .timeout(60_000)
  .build();

// Custom dependency wiring
const diamond = broadcast("diamond")
  .input(startSignal)
  .then(leftSignal, rightSignal)           // parallel after start
  .then(mergeSignal, {
    after: ["leftSignal", "rightSignal"],  // explicit deps
    map: (upstream) => ({
      left: upstream["leftSignal"],
      right: upstream["rightSignal"],
    }),
  })
  .build();
```

### BroadcastDefinition

```ts
interface BroadcastDefinition {
  readonly [BROADCAST_BRAND]: true;
  readonly name: string;
  readonly nodes: readonly BroadcastNode[];
  readonly failurePolicy: FailurePolicy;
  readonly timeout?: number;
  readonly interval?: string;
  readonly recurringInput?: unknown;
  trigger(input: unknown): Promise<string>;
}
```

### BroadcastNode

```ts
interface BroadcastNode {
  readonly name: string;
  readonly signalName: string;
  readonly signal: AnySignal;
  readonly dependsOn: readonly string[];
  readonly timeout: number;
  readonly maxAttempts: number;
  readonly map?: (upstream: Record<string, unknown>) => unknown;
  readonly when?: (upstream: Record<string, unknown>) => boolean;
}
```

### FailurePolicy

```ts
type FailurePolicy = "fail-fast" | "skip-downstream" | "continue";
```

- `"fail-fast"` -- Cancel all running nodes and fail the broadcast immediately when any node fails.
- `"skip-downstream"` -- Skip nodes whose upstream dependencies failed, but let other branches continue.
- `"continue"` -- Run all possible nodes regardless of failures. Broadcast completes even if some nodes failed.

### BroadcastRunner

```ts
interface BroadcastRunnerOptions {
  signalRunner: SignalRunner;           // required
  broadcastsDir?: string;
  adapter?: BroadcastQueueAdapter;
  pollIntervalMs?: number;              // default: 1000
  subscribers?: BroadcastSubscriber[];
}

class BroadcastRunner {
  constructor(options: BroadcastRunnerOptions);

  /** List all registered broadcast definitions with metadata. */
  listRegistered(): Array<{
    name: string;
    nodeCount: number;
    failurePolicy: FailurePolicy;
    timeout?: number;
    interval?: string;
  }>;

  /** Check whether a broadcast is registered by name. */
  hasBroadcast(name: string): boolean;

  /** Register a broadcast definition explicitly. */
  register(definition: BroadcastDefinition): this;

  /** Add a subscriber. */
  subscribe(subscriber: BroadcastSubscriber): this;

  /** Get a broadcast run by ID. */
  getBroadcastRun(id: string): Promise<BroadcastRun | null>;

  /** Get node runs for a broadcast run. */
  getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]>;

  /**
   * Wait for a broadcast run to reach a terminal status.
   * Returns the run, or null if not found.
   */
  waitForBroadcastRun(id: string, opts?: {
    pollMs?: number;     // default: 200
    timeoutMs?: number;  // default: 60000
  }): Promise<BroadcastRun | null>;

  /** Cancel a broadcast run. Cancels all running/pending nodes. */
  cancel(broadcastRunId: string): Promise<boolean>;

  /**
   * Trigger a broadcast by name. Writes directly to this runner's adapter.
   * Prefer this over definition.trigger() for local usage.
   */
  trigger(broadcastName: string, input: unknown): Promise<string>;

  /** Start the runner loop. Blocks until stop() is called. */
  start(): Promise<void>;

  /** Stop the runner. */
  stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;
}
```

### BroadcastRun Type

```ts
type BroadcastRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface BroadcastRun {
  id: string;
  broadcastName: string;
  input: string;                    // JSON-serialized
  status: BroadcastRunStatus;
  failurePolicy: FailurePolicy;
  timeout?: number;                 // ms
  interval?: string;
  nextRunAt?: Date;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

type BroadcastRunPatch = Partial<Omit<BroadcastRun, "id" | "broadcastName" | "createdAt">>;
```

### BroadcastNodeRun Type

```ts
type BroadcastNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";
type BroadcastNodeSkipReason = "guard" | "upstream-failed" | "cancelled";

interface BroadcastNodeRun {
  id: string;
  broadcastRunId: string;
  nodeName: string;
  signalName: string;
  signalRunId?: string;             // links to signal Run record
  status: BroadcastNodeStatus;
  skipReason?: BroadcastNodeSkipReason;
  input?: string;                   // JSON-serialized
  output?: string;                  // JSON-serialized
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

type BroadcastNodeRunPatch = Partial<Omit<BroadcastNodeRun, "id" | "broadcastRunId" | "nodeName" | "signalName">>;
```

### BroadcastQueueAdapter Interface

```ts
interface BroadcastQueueAdapter {
  // Broadcast runs
  addBroadcastRun(run: BroadcastRun): Promise<void>;
  getBroadcastRun(id: string): Promise<BroadcastRun | null>;
  updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void>;
  getBroadcastRunsDue(): Promise<BroadcastRun[]>;
  getBroadcastRunsRunning(): Promise<BroadcastRun[]>;
  listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]>;
  hasBroadcastRunWithStatus(broadcastName: string, statuses: BroadcastRunStatus[]): Promise<boolean>;
  purgeBroadcastRuns(olderThan: Date, statuses: BroadcastRunStatus[]): Promise<number>;

  // Node runs
  addNodeRun(nodeRun: BroadcastNodeRun): Promise<void>;
  getNodeRun(id: string): Promise<BroadcastNodeRun | null>;
  updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void>;
  getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]>;

  // Utility
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}
```

### BroadcastMemoryAdapter

```ts
class BroadcastMemoryAdapter implements BroadcastQueueAdapter {
  constructor(); // no options
}
```

### BroadcastSubscriber Interface

All methods are optional.

```ts
interface BroadcastSubscriber {
  onBroadcastDiscovered?(event: { broadcastName: string; filePath: string }): void;
  onBroadcastQueued?(event: { broadcastRun: BroadcastRun }): void;
  onBroadcastStarted?(event: { broadcastRun: BroadcastRun }): void;
  onBroadcastCompleted?(event: { broadcastRun: BroadcastRun }): void;
  onBroadcastFailed?(event: { broadcastRun: BroadcastRun; error: string }): void;
  onBroadcastCancelled?(event: { broadcastRun: BroadcastRun }): void;
  onNodeTriggered?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void;
  onNodeCompleted?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void;
  onNodeFailed?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; error: string }): void;
  onNodeSkipped?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; reason: string }): void;
}
```

### ConsoleBroadcastSubscriber

```ts
class ConsoleBroadcastSubscriber implements BroadcastSubscriber {
  // Logs all events to console with "[station-broadcast]" prefix.
  // Implements every method on BroadcastSubscriber.
}
```

### Broadcast Configuration

```ts
function configureBroadcast(options: { adapter: BroadcastQueueAdapter }): void;
function getBroadcastAdapter(): BroadcastQueueAdapter;
function isBroadcastConfigured(): boolean;
```

### Error Classes

```ts
class BroadcastValidationError extends Error {
  readonly code: string; // "BROADCAST_VALIDATION_ERROR"
  constructor(message: string);
}

class BroadcastCycleError extends BroadcastValidationError {
  readonly code: string; // "BROADCAST_CYCLE_ERROR"
  readonly cycle: string[];
  constructor(broadcastName: string, cycle: string[]);
}
```

### Utility

```ts
function isBroadcast(value: unknown): value is BroadcastDefinition;
const BROADCAST_BRAND: unique symbol; // Symbol.for("station-broadcast")
```

---

## 3. station-adapter-sqlite

npm: `station-adapter-sqlite`
Dependency: `better-sqlite3` (synchronous)

### Signal Adapter

```ts
import { SqliteAdapter, type SqliteAdapterOptions } from "station-adapter-sqlite";
```

```ts
interface SqliteAdapterOptions {
  /** Path to the SQLite database file. Defaults to "station.db". */
  dbPath?: string;
  /** Table name (alphanumeric and underscores only). Defaults to "runs". */
  tableName?: string;
}

class SqliteAdapter implements SerializableAdapter {
  constructor(options?: SqliteAdapterOptions);
  toManifest(): AdapterManifest;
  // ... all SignalQueueAdapter methods
}
```

Registers as `"sqlite"` in the adapter factory. WAL mode and foreign keys enabled. Schema auto-created on construction.

### Broadcast Adapter

```ts
import { BroadcastSqliteAdapter, type BroadcastSqliteAdapterOptions } from "station-adapter-sqlite/broadcast";
```

```ts
interface BroadcastSqliteAdapterOptions {
  dbPath?: string;       // default: "station.db"
  tableName?: string;    // default: "broadcast_runs"
}

class BroadcastSqliteAdapter implements BroadcastQueueAdapter {
  constructor(options?: BroadcastSqliteAdapterOptions);
  // ... all BroadcastQueueAdapter methods
}
```

Node runs table: `${tableName}_nodes` with foreign key cascade.

### Shared database pattern

```ts
// Share the same station.db file
const signalAdapter = new SqliteAdapter({ dbPath: "station.db" });
const broadcastAdapter = new BroadcastSqliteAdapter({ dbPath: "station.db" });
```

---

## 4. station-adapter-postgres

npm: `station-adapter-postgres`
Dependency: `pg` (async)

### Signal Adapter

```ts
import { PostgresAdapter, type PostgresAdapterOptions } from "station-adapter-postgres";
```

```ts
interface PostgresAdapterOptions {
  /** PostgreSQL connection string. Ignored if pool is provided. */
  connectionString?: string;
  /** Existing pg.Pool instance to reuse. */
  pool?: pg.Pool;
  /** Table name. Defaults to "runs". */
  tableName?: string;
}

class PostgresAdapter implements SerializableAdapter {
  constructor(options?: PostgresAdapterOptions);
  toManifest(): AdapterManifest;
  // ... all SignalQueueAdapter methods
}
```

Constructor is synchronous. Schema initialization is deferred -- first adapter method call awaits the internal `ready()` promise. Registers as `"postgres"`.

### Broadcast Adapter

```ts
import { BroadcastPostgresAdapter, type BroadcastPostgresAdapterOptions } from "station-adapter-postgres/broadcast";
```

```ts
interface BroadcastPostgresAdapterOptions {
  connectionString?: string;
  pool?: pg.Pool;
  tableName?: string;    // default: "broadcast_runs"
}

class BroadcastPostgresAdapter implements BroadcastQueueAdapter {
  constructor(options?: BroadcastPostgresAdapterOptions);
  // ... all BroadcastQueueAdapter methods
}
```

### Pool sharing

```ts
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://..." });
const signalAdapter = new PostgresAdapter({ pool });
const broadcastAdapter = new BroadcastPostgresAdapter({ pool });
// Both share the same connection pool. Only close the pool once.
```

---

## 5. station-adapter-mysql

npm: `station-adapter-mysql`
Dependency: `mysql2/promise` (async)

### Signal Adapter

```ts
import { MysqlAdapter, type MysqlAdapterOptions } from "station-adapter-mysql";
```

```ts
interface MysqlAdapterOptions {
  /** MySQL connection string (e.g. "mysql://user:pass@host:3306/db"). */
  connectionString?: string;
  /** Existing mysql2 connection pool. Takes precedence over connectionString. */
  pool?: Pool;
  /** Table name. Defaults to "runs". */
  tableName?: string;
}

class MysqlAdapter implements SerializableAdapter {
  // Private constructor -- NEVER use `new MysqlAdapter()`
  private constructor(pool: Pool, tableName: string, ownsPool: boolean, options: MysqlAdapterOptions);

  /** The ONLY way to create a MysqlAdapter. Async because table creation requires await. */
  static async create(options?: MysqlAdapterOptions): Promise<MysqlAdapter>;

  toManifest(): AdapterManifest;
  // ... all SignalQueueAdapter methods
}
```

Registers as `"mysql"`. Requires either `connectionString` or `pool`.

### Broadcast Adapter

```ts
import { BroadcastMysqlAdapter, type BroadcastMysqlAdapterOptions } from "station-adapter-mysql/broadcast";
```

```ts
interface BroadcastMysqlAdapterOptions {
  connectionString?: string;
  pool?: Pool;
  tableName?: string;    // default: "broadcast_runs"
}

class BroadcastMysqlAdapter implements BroadcastQueueAdapter {
  // Private constructor -- NEVER use `new BroadcastMysqlAdapter()`
  private constructor(pool: Pool, runsTable: string, nodesTable: string, ownsPool: boolean);

  /** The ONLY way to create a BroadcastMysqlAdapter. */
  static async create(options?: BroadcastMysqlAdapterOptions): Promise<BroadcastMysqlAdapter>;

  // ... all BroadcastQueueAdapter methods
}
```

### Pool sharing

```ts
import mysql from "mysql2/promise";

const pool = mysql.createPool("mysql://user:pass@host:3306/db");
const signalAdapter = await MysqlAdapter.create({ pool });
const broadcastAdapter = await BroadcastMysqlAdapter.create({ pool });
```

---

## 6. station-adapter-redis

npm: `station-adapter-redis`
Dependency: `ioredis`

### Signal Adapter

```ts
import { RedisAdapter, type RedisAdapterOptions } from "station-adapter-redis";
```

```ts
interface RedisAdapterOptions {
  /** Redis connection URL. Defaults to "redis://localhost:6379". */
  url?: string;
  /** Existing ioredis instance. Takes precedence over url. */
  redis?: Redis;
  /** Key prefix for all Redis keys. Defaults to "station". */
  prefix?: string;
}

class RedisAdapter implements SerializableAdapter {
  constructor(options?: RedisAdapterOptions);
  toManifest(): AdapterManifest;
  // ... all SignalQueueAdapter methods
}
```

Registers as `"redis"`. Uses Redis hashes for data, sorted sets for indexes, `MULTI/EXEC` for atomicity.

Key schema (prefix default `"station"`):
- `station:run:{id}` -- hash per run
- `station:runs:pending` -- sorted set (score = nextRunAt or 0)
- `station:runs:running` -- sorted set (score = startedAt)
- `station:runs:signal:{signalName}` -- sorted set (score = createdAt)
- `station:runs:status:{signalName}:{status}` -- set of run IDs
- `station:runs:completed-at` -- sorted set (score = completedAt)
- `station:step:{id}` -- hash per step
- `station:run-steps:{runId}` -- set of step IDs

### Broadcast Adapter

```ts
import { BroadcastRedisAdapter, type BroadcastRedisAdapterOptions } from "station-adapter-redis/broadcast";
```

```ts
interface BroadcastRedisAdapterOptions {
  url?: string;
  redis?: Redis;
  prefix?: string;       // default: "station"
}

class BroadcastRedisAdapter implements BroadcastQueueAdapter {
  constructor(options?: BroadcastRedisAdapterOptions);
  // ... all BroadcastQueueAdapter methods
}
```

Key schema:
- `station:broadcast-run:{id}` -- hash per broadcast run
- `station:broadcast-runs:pending` -- sorted set
- `station:broadcast-runs:running` -- sorted set
- `station:broadcast-runs:name:{broadcastName}` -- sorted set
- `station:broadcast-runs:status:{broadcastName}:{status}` -- set
- `station:broadcast-runs:completed-at` -- sorted set
- `station:node-run:{id}` -- hash per node run
- `station:broadcast-run-nodes:{broadcastRunId}` -- set of node IDs

### Redis instance sharing

```ts
import Redis from "ioredis";

const redis = new Redis("redis://localhost:6379");
const signalAdapter = new RedisAdapter({ redis, prefix: "myapp" });
const broadcastAdapter = new BroadcastRedisAdapter({ redis, prefix: "myapp" });
```

---

## 7. station-kit

npm: `station-kit`

Dashboard with Hono API server + Next.js frontend.

### Exports

```ts
import { defineConfig, type StationUserConfig, type StationConfig, type AuthConfig } from "station-kit";
```

### defineConfig()

```ts
function defineConfig(config: StationUserConfig): StationUserConfig;
```

Used in `station.config.ts` at the project root.

### StationUserConfig

```ts
interface AuthConfig {
  username: string;
  password: string;
  sessionTtlMs?: number;   // default: 86400000 (24h)
}

interface RunnerConfig {
  pollIntervalMs: number;   // default: 1000
  maxConcurrent: number;    // default: 5
  maxAttempts: number;      // default: 1
  retryBackoffMs: number;   // default: 1000
}

interface BroadcastRunnerConfig {
  pollIntervalMs: number;   // default: 1000
}

interface StationConfig {
  port: number;                          // default: 4400
  host: string;                          // default: "localhost"
  adapter?: SignalQueueAdapter;
  broadcastAdapter?: BroadcastQueueAdapter;
  signalsDir?: string;                   // auto-detects "./signals" if exists
  broadcastsDir?: string;                // auto-detects "./broadcasts" if exists
  runner: RunnerConfig;
  broadcastRunner: BroadcastRunnerConfig;
  runRunners: boolean;                   // default: true
  open: boolean;                         // default: true (opens browser)
  logLevel: "debug" | "info" | "warn" | "error"; // default: "info"
  auth?: AuthConfig;
}

type StationUserConfig = Partial<Omit<StationConfig, "runner" | "broadcastRunner">> & {
  runner?: Partial<RunnerConfig>;
  broadcastRunner?: Partial<BroadcastRunnerConfig>;
};
```

### Config file example

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "station.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "station.db" }),
  runner: {
    maxConcurrent: 10,
    maxAttempts: 3,
  },
  auth: {
    username: "admin",
    password: "secret",
  },
});
```

### CLI

```
npx station
```

Launches:
- Hono API server on `port` (default 4400)
- Next.js dashboard on `port + 1` (default 4401)
- Signal and broadcast runners (unless `runRunners: false`)

The CLI uses a launcher pattern: re-execs with `node --import tsx` to enable TypeScript resolution for user signal/broadcast files.

---

## 8. Station v1 API Endpoints

Base path: `/api/v1`

Authentication: `Authorization: Bearer sk_live_...` header or session cookie.

API key scopes: `trigger`, `read`, `cancel`, `admin`.

### Health (no auth required)

```
GET /api/v1/health
```

Response:
```json
{ "data": { "ok": true, "signal": true, "broadcast": true } }
```

### Auth (rate-limited, no auth required)

```
POST /api/v1/auth/login
```

Body: `{ "username": "...", "password": "..." }`
Response: `{ "data": { "ok": true } }` + `Set-Cookie` header.

```
POST /api/v1/auth/logout
```

Response: `{ "data": { "ok": true } }` + clears cookie.

### Trigger (scope: `trigger`)

```
POST /api/v1/trigger
```

Body: `{ "signalName": "my-signal", "input": { ... } }`
Response (201):
```json
{ "data": { "id": "uuid", "signalName": "my-signal", "status": "pending", "createdAt": "..." } }
```

```
POST /api/v1/trigger-broadcast
```

Body: `{ "broadcastName": "my-broadcast", "input": { ... } }`
Response (201):
```json
{ "data": { "id": "uuid", "broadcastName": "my-broadcast", "status": "pending", "createdAt": "..." } }
```

### Read (scope: `read`)

```
GET /api/v1/signals
```

Response: `{ "data": [{ "name": "...", "filePath": "...", ... }] }`

```
GET /api/v1/signals/:name
```

Response: `{ "data": { "name": "...", "filePath": "...", ... } }`

```
GET /api/v1/runs
```

Query params: `?signalName=...&status=...&limit=50` (max 200)
Response: `{ "data": [...], "meta": { "total": N } }`

```
GET /api/v1/runs/:id
```

Response: `{ "data": { "id": "...", "signalName": "...", "status": "...", ... } }`

```
GET /api/v1/runs/:id/steps
```

Response: `{ "data": [{ "id": "...", "runId": "...", "name": "...", "status": "...", ... }] }`

```
GET /api/v1/runs/:id/logs
```

Response: `{ "data": [...] }` (array of log entries)

```
GET /api/v1/broadcasts
```

Response: `{ "data": [{ "name": "...", "nodeCount": N, "failurePolicy": "...", ... }] }`

```
GET /api/v1/broadcasts/:name
```

Response: `{ "data": { "name": "...", "nodeCount": N, "failurePolicy": "...", ... } }`

```
GET /api/v1/broadcast-runs/:id
```

Response: `{ "data": { "id": "...", "broadcastName": "...", "status": "...", ... } }`

```
GET /api/v1/broadcast-runs/:id/nodes
```

Response: `{ "data": [{ "id": "...", "nodeName": "...", "signalName": "...", "status": "...", ... }] }`

### SSE Events (scope: `read`)

```
GET /api/v1/events
```

Query params (all optional, comma-separated):
- `?signals=signal1,signal2` -- filter events by signal name
- `?broadcasts=broadcast1` -- filter events by broadcast name
- `?events=run:completed,run:failed` -- filter by event type

Returns Server-Sent Events stream. Event format:
```
event: <event-type>
data: <JSON payload>
id: evt_<counter>
```

Heartbeat every 30 seconds:
```
event: heartbeat
data:
```

### Cancel (scope: `cancel`)

```
POST /api/v1/runs/:id/cancel
```

Response: `{ "data": { "cancelled": true } }`
Error: `{ "error": "cannot_cancel", "message": "Run cannot be cancelled." }` (400)

```
POST /api/v1/broadcast-runs/:id/cancel
```

Response: `{ "data": { "cancelled": true } }`
Error: `{ "error": "cannot_cancel", "message": "Broadcast run cannot be cancelled." }` (400)

### API Keys (scope: `admin`)

```
POST /api/v1/keys
```

Body: `{ "name": "My Key", "scopes": ["trigger", "read"] }`
Response (201):
```json
{
  "data": {
    "id": "uuid",
    "name": "My Key",
    "key": "sk_live_...",
    "keyPrefix": "sk_live_abc...",
    "scopes": ["trigger", "read"],
    "createdAt": "..."
  }
}
```

The `key` field is only returned at creation time.

```
GET /api/v1/keys
```

Response: `{ "data": [{ "id": "...", "name": "...", "keyPrefix": "...", "scopes": [...], ... }] }`

```
DELETE /api/v1/keys/:id
```

Response: `{ "data": { "revoked": true } }`

### Error Responses

All errors follow this format:

```json
{ "error": "error_code", "message": "Human-readable description." }
```

Common error codes:
- `bad_request` (400) -- missing or invalid body
- `unauthorized` (401) -- no auth or invalid credentials/key
- `forbidden` (403) -- missing required scope
- `not_found` (404) -- resource not found
- `cannot_cancel` (400) -- run already in terminal state
- `unavailable` (503) -- runner not configured or read-only mode
- `trigger_failed` (400) -- broadcast trigger threw an error

---

## Quick Reference: Import Patterns

### Adapter subpath imports

All adapter packages use subpath exports for their broadcast adapters:

```ts
// Signal adapters (main entry)
import { SqliteAdapter } from "station-adapter-sqlite";
import { PostgresAdapter } from "station-adapter-postgres";
import { MysqlAdapter } from "station-adapter-mysql";
import { RedisAdapter } from "station-adapter-redis";

// Broadcast adapters (subpath)
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { BroadcastPostgresAdapter } from "station-adapter-postgres/broadcast";
import { BroadcastMysqlAdapter } from "station-adapter-mysql/broadcast";
import { BroadcastRedisAdapter } from "station-adapter-redis/broadcast";
```

Exception: MySQL broadcast adapter is also re-exported from the main entry:

```ts
import { MysqlAdapter, BroadcastMysqlAdapter } from "station-adapter-mysql";
```

Same for Redis:

```ts
import { RedisAdapter, BroadcastRedisAdapter } from "station-adapter-redis";
```

### Zod re-export

```ts
import { z } from "station-signal";
// Equivalent to: import { z } from "zod";
```

### Full setup pattern

```ts
import { signal, SignalRunner, z } from "station-signal";
import { broadcast, BroadcastRunner } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

// Define signals
const mySignal = signal("my-signal")
  .input(z.object({ name: z.string() }))
  .run(async (input) => {
    return { greeting: `Hello, ${input.name}` };
  });

// Define broadcasts
const myBroadcast = broadcast("my-broadcast")
  .input(mySignal)
  .build();

// Create runners
const signalAdapter = new SqliteAdapter({ dbPath: "station.db" });
const broadcastAdapter = new BroadcastSqliteAdapter({ dbPath: "station.db" });

const signalRunner = new SignalRunner({
  adapter: signalAdapter,
  subscribers: [],
  maxConcurrent: 10,
});
signalRunner.register("my-signal", "./signals/my-signal.ts");

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  adapter: broadcastAdapter,
});
broadcastRunner.register(myBroadcast);

// Start (non-blocking)
signalRunner.start();
broadcastRunner.start();

// Trigger
const runId = await mySignal.trigger({ name: "World" });
const broadcastRunId = await broadcastRunner.trigger("my-broadcast", { name: "World" });
```

### Remote trigger pattern

```ts
import { signal, configure, z } from "station-signal";

// Configure remote endpoint
configure({
  endpoint: "https://station.example.com",
  apiKey: "sk_live_...",
});

// Or via environment variables:
// STATION_ENDPOINT=https://station.example.com
// STATION_API_KEY=sk_live_...

const mySignal = signal("my-signal")
  .input(z.object({ name: z.string() }))
  .run(async () => {}); // Handler not used remotely

// trigger() sends HTTP POST to remote Station server
const runId = await mySignal.trigger({ name: "World" });
```
