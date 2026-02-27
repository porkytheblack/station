# RFC: Broadcasts — Workflow Orchestration for simple-signal

## Status: Draft

## Summary

Broadcasts are **workflow DAGs** built on top of existing signals. A broadcast connects multiple signals into a directed acyclic graph where data flows from one signal's output to the next signal's input. The broadcast runner watches for signal completions and triggers downstream signals automatically.

This RFC proposes a new `packages/simple-signal-broadcast` package (exported as `simple-signal/broadcast` or `@simple-signal/broadcast`) that reuses the existing signal infrastructure and adapter interface.

---

## 1. Dream API — Consumer's Code First

### Defining a broadcast (the simple case)

```ts
import { broadcast } from "@simple-signal/broadcast";
import { validateOrder, chargePayment, sendReceipt, notifyWarehouse } from "./signals/index.js";

// Linear chain: validate -> charge -> [sendReceipt, notifyWarehouse] (fan-out)
export const orderWorkflow = broadcast("order-workflow")
  .input(validateOrder)
  .then(chargePayment)
  .then(sendReceipt, notifyWarehouse)   // fan-out: both run in parallel
  .build();
```

**5 lines. Zero to workflow.**

### Defining a broadcast (advanced — explicit DAG with data mapping)

```ts
export const onboardUser = broadcast("onboard-user")
  .input(validateUser)
  .then(createAccount, { as: "account" })
  .then(provisionStorage, {
    as: "storage",
    map: (prev) => ({ userId: prev.account.userId, plan: prev.account.plan }),
  })
  .then(sendWelcomeEmail, {
    after: ["account", "storage"],   // explicit dependency
    map: (prev) => ({
      to: prev.account.email,
      storageMb: prev.storage.quotaMb,
    }),
  })
  .build();
```

### Triggering a broadcast

```ts
import { orderWorkflow } from "./broadcasts/order-workflow.js";

// Programmatic trigger — returns a broadcastRunId
const broadcastRunId = await orderWorkflow.trigger({ orderId: "ORD-123", amount: 49.99 });
```

### Scheduling a recurring broadcast

```ts
export const dailyReport = broadcast("daily-report")
  .input(gatherMetrics)
  .then(generateReport)
  .then(emailReport)
  .every("1d")
  .withInput({ reportType: "daily" })
  .build();
```

### Running broadcasts (BroadcastRunner)

```ts
import { SignalRunner } from "simple-signal";
import { BroadcastRunner } from "@simple-signal/broadcast";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";

const adapter = new SqliteAdapter({ dbPath: "app.db" });

// SignalRunner handles the actual signal execution
const signalRunner = new SignalRunner({
  signalsDir: "./signals",
  adapter,
  subscribers: [new ConsoleSubscriber()],
});

// BroadcastRunner orchestrates the DAG on top of signals
const broadcastRunner = new BroadcastRunner({
  signalRunner,
  broadcastsDir: "./broadcasts",          // auto-discover broadcast definitions
  adapter: new BroadcastMemoryAdapter(),   // or BroadcastSqliteAdapter for persistence
});

// Start both — order doesn't matter, they coordinate via the adapter
await Promise.all([
  signalRunner.start(),
  broadcastRunner.start(),
]);
```

---

## 2. Core Types

### BroadcastDefinition

The static, immutable description of a workflow's shape. Created by the builder, never mutated at runtime.

```ts
/** A named node in the broadcast DAG. */
interface BroadcastNode {
  /** Unique label within this broadcast (defaults to signal name). */
  readonly name: string;
  /** The signal this node triggers. */
  readonly signalName: string;
  /** File path to the signal module (resolved at discovery time). */
  readonly signalFilePath?: string;
  /** Names of upstream nodes this node depends on. Empty = root node. */
  readonly dependsOn: readonly string[];
  /**
   * Optional data mapper: receives an object keyed by upstream node names
   * (each value is that node's signal output), returns the input for this
   * node's signal.
   *
   * If omitted, the output of the single upstream node is passed through
   * directly. If multiple upstreams exist and no map is provided, the
   * framework passes an object keyed by upstream node names.
   */
  readonly map?: (upstream: Record<string, unknown>) => unknown;
  /**
   * Optional guard: if provided, the node is only triggered when this
   * predicate returns true.  When it returns false the node (and its
   * entire downstream sub-graph, unless those nodes have other satisfied
   * paths) is marked `"skipped"`.
   *
   * Receives the same upstream object as `map`.
   */
  readonly when?: (upstream: Record<string, unknown>) => boolean;
}

interface BroadcastDefinition {
  readonly [BROADCAST_BRAND]: true;
  readonly name: string;
  readonly nodes: readonly BroadcastNode[];
  /** If set, this broadcast runs on a schedule. */
  readonly interval?: string;
  readonly recurringInput?: unknown;
  /** Trigger this broadcast programmatically. */
  trigger(input: unknown): Promise<string>;
}
```

### BroadcastRun

A single execution of a broadcast. Tracks which nodes have completed and the overall status.

```ts
type BroadcastRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface BroadcastRun {
  id: string;
  broadcastName: string;
  /** The input provided when the broadcast was triggered. */
  input: string;                  // JSON-serialized
  status: BroadcastRunStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

type BroadcastRunPatch = Partial<Omit<BroadcastRun, "id" | "broadcastName" | "createdAt">>;
```

### BroadcastNodeRun

Tracks each node within a broadcast run. This is the join between broadcast runs and signal runs.

```ts
type BroadcastNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

interface BroadcastNodeRun {
  id: string;
  broadcastRunId: string;
  nodeName: string;               // matches BroadcastNode.name
  signalName: string;
  /** The signal run ID (from SignalQueueAdapter). Links to the actual Run record. */
  signalRunId?: string;
  status: BroadcastNodeStatus;
  /** JSON-serialized input that was (or will be) passed to the signal. */
  input?: string;
  /** JSON-serialized output from the completed signal run. */
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

type BroadcastNodeRunPatch = Partial<Omit<BroadcastNodeRun, "id" | "broadcastRunId" | "nodeName" | "signalName">>;
```

---

## 3. Builder API

The builder mirrors the conventions of `SignalBuilder` — immutable cloning, progressive type narrowing, terminal `.build()`.

### Core Builder

```ts
class BroadcastBuilder<TInput = unknown> {
  // Identity
  private _name: string;
  private _nodes: BroadcastNode[] = [];
  private _interval?: string;
  private _recurringInput?: TInput;

  constructor(name: string) { ... }

  /**
   * Set the root signal — the entry point of the broadcast.
   * Its input schema defines the broadcast's input type.
   */
  input<T>(rootSignal: Signal<T, any>): BroadcastChain<T, Record<string, never>> {
    // Creates the first node with dependsOn: []
  }

  every(interval: string): BroadcastBuilder<TInput> { ... }
  withInput(input: TInput): BroadcastBuilder<TInput> { ... }
}
```

### Chain Builder (the fluent DAG construction)

```ts
/**
 * TInput: the broadcast's root input type.
 * TOutputs: accumulated Record of { nodeName: outputType } for type-safe mapping.
 */
class BroadcastChain<TInput, TOutputs extends Record<string, unknown>> {

  /**
   * Add one or more signals to run after the previous tier completes.
   *
   * Simple form (no options): signal runs after all prior nodes,
   * receives the single upstream output directly.
   *
   * With options: control naming, dependencies, and data mapping.
   */
  then<TOut>(
    signal: Signal<any, TOut>,
    options?: {
      as?: string;                              // node name (default: signal.name)
      after?: (keyof TOutputs)[];               // explicit deps (default: all prior)
      map?: (upstream: TOutputs) => unknown;    // data transform
      when?: (upstream: TOutputs) => boolean;   // conditional guard — skip node if false
    },
  ): BroadcastChain<TInput, TOutputs & Record<string, TOut>>;

  // Overload for fan-out: multiple signals in parallel
  then<T1, T2>(
    s1: Signal<any, T1>,
    s2: Signal<any, T2>,
  ): BroadcastChain<TInput, TOutputs & Record<string, T1 | T2>>;

  // Terminal
  build(): BroadcastDefinition;
}
```

### The `broadcast()` entry point

```ts
function broadcast(name: string): BroadcastBuilder {
  return new BroadcastBuilder(name);
}
```

### Why this shape?

**Linear chains are trivial:**
```ts
broadcast("pipeline")
  .input(signalA)
  .then(signalB)
  .then(signalC)
  .build()
```

**Fan-out is natural (variadic `.then()`):**
```ts
broadcast("fan-out")
  .input(signalA)
  .then(signalB, signalC)  // B and C run in parallel after A
  .then(signalD)            // D runs after both B and C
  .build()
```

**Fan-in uses `after` to select specific upstream nodes:**
```ts
broadcast("fan-in")
  .input(signalA)
  .then(signalB, { as: "b" })
  .then(signalC, { as: "c" })
  .then(signalD, { after: ["b", "c"], map: (prev) => ({ ...prev.b, ...prev.c }) })
  .build()
```

**Progressive disclosure:** The simple case needs zero options. The complex case (explicit DAG wiring) is possible through the same `.then()` method with options.

---

## 4. Adapter Interface

Broadcasts need their own storage, separate from the signal run storage. This keeps concerns clean and avoids polluting `SignalQueueAdapter` with broadcast-specific methods.

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

  // Node runs (per-node tracking within a broadcast run)
  addNodeRun(nodeRun: BroadcastNodeRun): Promise<void>;
  getNodeRun(id: string): Promise<BroadcastNodeRun | null>;
  updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void>;
  getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]>;
  getNodeRunBySignalRunId(signalRunId: string): Promise<BroadcastNodeRun | null>;

  // Utility
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}
```

### Design notes

- **Separate adapter, not an extension of `SignalQueueAdapter`.** Broadcasts are an optional, higher-level feature. Users who don't use broadcasts shouldn't pay for the extra tables/storage. This also means a broadcast adapter can be a different storage backend than the signal adapter if desired.
- **`getNodeRunBySignalRunId`** is the key query for the runner: when a signal run completes, the broadcast runner needs to find which broadcast node it belongs to and decide what to trigger next.
- The adapter follows the same patterns as `SignalQueueAdapter`: `add/get/update/list/purge`, `Patch` types for safe partial updates, `generateId()` for ID generation.

### Shipped adapters

- `BroadcastMemoryAdapter` — in-process, batteries-included default.
- `BroadcastSqliteAdapter` (in `@simple-signal/adapter-sqlite`) — adds `broadcast_runs` and `broadcast_node_runs` tables alongside the existing `runs` table. Implements `SerializableAdapter`-like pattern for the broadcast side.

---

## 5. BroadcastRunner — Orchestration Engine

The `BroadcastRunner` is the orchestrator. It does **not** execute signals itself; it delegates to the existing `SignalRunner` / `SignalQueueAdapter` infrastructure. Its job is:

1. Poll for due broadcast runs.
2. For each broadcast run, determine which nodes are ready (all upstream dependencies completed).
3. Trigger the ready nodes' signals via the `SignalQueueAdapter` (creating signal `Run` records).
4. Watch for signal run completions and advance the DAG.
5. Mark the broadcast run as completed when all nodes are done, or failed if any required node fails.

### Lifecycle

```
trigger("order-workflow", input)
  |
  v
[BroadcastRun created: status=pending]
  |
  v
BroadcastRunner.tick()
  |-- marks BroadcastRun as "running"
  |-- creates BroadcastNodeRun records for all nodes (status=pending)
  |-- finds ready nodes (dependsOn all satisfied): root node(s)
  |-- for each ready node:
  |     |-- compute input via map function (or pass-through)
  |     |-- trigger the signal via adapter (creates Run record)
  |     |-- store signalRunId on BroadcastNodeRun
  |     |-- mark node as "running"
  |
  v
[Signal runs execute via normal SignalRunner]
  |
  v
BroadcastRunner.tick() (on next poll)
  |-- for each running broadcast:
  |     |-- check signal run statuses for running nodes
  |     |-- for each completed signal run:
  |     |     |-- store output on BroadcastNodeRun
  |     |     |-- mark node as "completed"
  |     |     |-- find newly-ready downstream nodes
  |     |     |-- trigger them (same as above)
  |     |-- for each failed signal run:
  |     |     |-- mark node as "failed"
  |     |     |-- depending on policy: fail broadcast or skip downstreams
  |     |-- if all nodes completed → mark broadcast "completed"
  |     |-- if any required node failed and no retry possible → mark broadcast "failed"
```

### Class shape

```ts
interface BroadcastRunnerOptions {
  signalRunner: SignalRunner;
  broadcastsDir?: string;
  adapter?: BroadcastQueueAdapter;      // default: BroadcastMemoryAdapter
  pollIntervalMs?: number;              // default: 1000
  subscribers?: BroadcastSubscriber[];
  /** How to handle node failure. @default "fail-fast" */
  failurePolicy?: "fail-fast" | "skip-downstream" | "continue";
}

class BroadcastRunner {
  constructor(options: BroadcastRunnerOptions);

  /** Register a broadcast definition explicitly (alternative to auto-discovery). */
  register(definition: BroadcastDefinition): this;

  /** Start the orchestration loop. */
  async start(): Promise<void>;

  /** Stop the orchestration loop. */
  async stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;

  /** Get a broadcast run by ID. */
  async getBroadcastRun(id: string): Promise<BroadcastRun | null>;

  /** Get all node runs for a broadcast run. */
  async getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]>;

  /** Wait for a broadcast run to reach a terminal status. */
  async waitForBroadcastRun(id: string, opts?: { pollMs?: number; timeoutMs?: number }): Promise<BroadcastRun | null>;

  /** Cancel a broadcast run. Cancels all running signal runs. */
  async cancel(broadcastRunId: string): Promise<boolean>;
}
```

### Tick algorithm (pseudocode)

```ts
private async tick(): Promise<void> {
  await this.tickRecurring();  // schedule recurring broadcasts

  // 1. Check running broadcasts for progress
  const runningBroadcasts = await this.adapter.getBroadcastRunsRunning();
  for (const bRun of runningBroadcasts) {
    await this.advanceBroadcast(bRun);
  }

  // 2. Pick up new (pending) broadcasts
  const dueBroadcasts = await this.adapter.getBroadcastRunsDue();
  for (const bRun of dueBroadcasts) {
    await this.initBroadcast(bRun);
  }
}

private async advanceBroadcast(bRun: BroadcastRun): Promise<void> {
  const definition = this.registry.get(bRun.broadcastName);
  if (!definition) { /* mark failed */ return; }

  const nodeRuns = await this.adapter.getNodeRuns(bRun.id);
  const nodeRunsByName = new Map(nodeRuns.map(n => [n.nodeName, n]));

  // Check running nodes for completion
  for (const nodeRun of nodeRuns) {
    if (nodeRun.status !== "running" || !nodeRun.signalRunId) continue;

    const signalRun = await this.signalAdapter.getRun(nodeRun.signalRunId);
    if (!signalRun) continue;

    if (signalRun.status === "completed") {
      await this.adapter.updateNodeRun(nodeRun.id, {
        status: "completed",
        output: signalRun.output,
        completedAt: new Date(),
      });
      nodeRun.status = "completed";
      nodeRun.output = signalRun.output;
      this.emit("onNodeCompleted", { broadcastRun: bRun, nodeRun, signalRun });
    } else if (signalRun.status === "failed" || signalRun.status === "cancelled") {
      await this.adapter.updateNodeRun(nodeRun.id, {
        status: "failed",
        error: signalRun.error,
        completedAt: new Date(),
      });
      nodeRun.status = "failed";
      this.emit("onNodeFailed", { broadcastRun: bRun, nodeRun, signalRun });
    }
  }

  // Handle failure policy
  const failedNodes = nodeRuns.filter(n => n.status === "failed");
  if (failedNodes.length > 0 && this.failurePolicy === "fail-fast") {
    await this.failBroadcast(bRun, `Node "${failedNodes[0].nodeName}" failed`);
    return;
  }

  // Find newly ready nodes
  for (const node of definition.nodes) {
    const nodeRun = nodeRunsByName.get(node.name);
    if (!nodeRun || nodeRun.status !== "pending") continue;

    const depsReady = node.dependsOn.every(dep => {
      const depRun = nodeRunsByName.get(dep);
      return depRun?.status === "completed";
    });

    if (!depsReady) continue;

    // Compute upstream outputs (shared by both `when` and `map`)
    const upstreamOutputs: Record<string, unknown> = {};
    for (const dep of node.dependsOn) {
      const depRun = nodeRunsByName.get(dep)!;
      upstreamOutputs[dep] = depRun.output ? JSON.parse(depRun.output) : undefined;
    }

    // Conditional guard — skip this node (and downstream) if `when` returns false
    if (node.when && !node.when(upstreamOutputs)) {
      await this.adapter.updateNodeRun(nodeRun.id, {
        status: "skipped",
        completedAt: new Date(),
      });
      nodeRun.status = "skipped";
      this.emit("onNodeSkipped", {
        broadcastRun: bRun,
        nodeRun,
        reason: `Guard "when" returned false`,
      });
      continue;
    }

    // Compute input for this node
    let nodeInput: unknown;
    if (node.map) {
      nodeInput = node.map(upstreamOutputs);
    } else if (node.dependsOn.length === 1) {
      nodeInput = upstreamOutputs[node.dependsOn[0]];
    } else {
      nodeInput = upstreamOutputs;
    }

    // Trigger the signal
    const signalRunId = this.signalAdapter.generateId();
    const signalRun: Run = {
      id: signalRunId,
      signalName: node.signalName,
      kind: "trigger",
      input: JSON.stringify(nodeInput),
      status: "pending",
      attempts: 0,
      maxAttempts: /* from signal definition */ 1,
      timeout: /* from signal definition */ DEFAULT_TIMEOUT_MS,
      createdAt: new Date(),
    };
    await this.signalAdapter.addRun(signalRun);

    await this.adapter.updateNodeRun(nodeRun.id, {
      signalRunId,
      input: JSON.stringify(nodeInput),
      status: "running",
      startedAt: new Date(),
    });

    this.emit("onNodeTriggered", { broadcastRun: bRun, nodeRun, signalRun });
  }

  // Check if broadcast is complete
  const allDone = nodeRuns.every(n => n.status === "completed" || n.status === "skipped");
  if (allDone) {
    await this.adapter.updateBroadcastRun(bRun.id, {
      status: "completed",
      completedAt: new Date(),
    });
    this.emit("onBroadcastCompleted", { broadcastRun: bRun });
  }
}
```

---

## 6. Integration with SignalRunner

The key integration point is **how the BroadcastRunner knows when signal runs complete.**

### Option A: Polling (recommended for v1)

The `BroadcastRunner` polls `SignalQueueAdapter` for the status of signal runs it has triggered. This is simple, reliable, and requires no changes to `SignalRunner`.

```
BroadcastRunner.tick()
  → for each "running" BroadcastNodeRun
  → reads signalAdapter.getRun(signalRunId)
  → checks status
```

**Pros:** Zero changes to existing code. BroadcastRunner is fully additive.
**Cons:** Latency = pollIntervalMs. Fine for most workflows.

### Option B: Subscriber-driven (optimization for later)

Register a `SignalSubscriber` on the `SignalRunner` that pushes completion events to the `BroadcastRunner`:

```ts
signalRunner.subscribe({
  onRunCompleted({ run }) {
    broadcastRunner.onSignalRunCompleted(run);
  },
  onRunFailed({ run, error }) {
    broadcastRunner.onSignalRunFailed(run, error);
  },
});
```

This would reduce latency to near-zero but requires the broadcast runner to handle the same event twice (subscriber callback + next poll). The subscriber can set a "dirty" flag that causes the next tick to run immediately.

**Recommendation:** Start with Option A (polling). Add Option B as an optimization later. The architecture supports both without breaking changes.

### Accessing the SignalQueueAdapter

The `BroadcastRunner` needs read access to the signal adapter to check run statuses and write access to create new runs (triggering signals). Two approaches:

**Approach 1: Through SignalRunner (encapsulated)**
```ts
class BroadcastRunner {
  constructor(options: { signalRunner: SignalRunner; ... }) {
    // BroadcastRunner calls signalRunner.getRun() and creates runs via the adapter
  }
}
```

**Approach 2: Direct adapter access**
```ts
class BroadcastRunner {
  constructor(options: { signalAdapter: SignalQueueAdapter; ... }) {
    // Direct access for triggering and querying
  }
}
```

**Recommendation:** Approach 1 is cleaner from a DX perspective. The user already has a `SignalRunner` instance. However, the `SignalRunner` currently doesn't expose its adapter directly. We would either:
- Add a `signalRunner.adapter` getter (simple, useful anyway), or
- Accept both: `signalRunner` (required) + `signalAdapter` (optional, defaults to signalRunner's adapter).

I recommend adding a read-only `.adapter` getter to `SignalRunner`. It is a useful escape hatch for advanced users regardless of broadcasts.

---

## 7. Data Flow Between Signals

### Default behavior: pass-through

When a node has a single upstream dependency and no `map` function, the upstream signal's output is passed directly as the downstream signal's input:

```
validateOrder (output: { orderId, amount, valid })
  → chargePayment (input: { orderId, amount, valid })
```

### Explicit mapping

When the types don't align or you need to transform data:

```ts
.then(chargePayment, {
  map: (prev) => ({ orderId: prev.validate.orderId, amount: prev.validate.amount }),
})
```

### Fan-in (multiple upstreams)

When a node depends on multiple upstreams and has no `map`, it receives an object keyed by upstream node names:

```ts
// sendConfirmation depends on both "charge" and "inventory"
// It receives: { charge: { chargeId: "..." }, inventory: { reserved: true } }
```

With an explicit `map`:
```ts
.then(sendConfirmation, {
  after: ["charge", "inventory"],
  map: (prev) => ({
    chargeId: prev.charge.chargeId,
    reserved: prev.inventory.reserved,
  }),
})
```

### Root node input

The first signal (`.input(signal)`) receives the broadcast's trigger input directly. No mapping needed.

### Type safety

The generic accumulator `TOutputs` in `BroadcastChain` tracks which node names exist and their output types. This enables type-safe `map` functions with full autocomplete:

```ts
broadcast("typed-flow")
  .input(validateOrder)                              // TOutputs = {}
  .then(chargePayment, { as: "charge" })             // TOutputs = { charge: ChargeOutput }
  .then(sendReceipt, {
    map: (prev) => ({                                // prev: { charge: ChargeOutput }
      chargeId: prev.charge.chargeId,                // ← full autocomplete here
    }),
  })
```

---

## 8. Conditional Logic (`when` guards)

Broadcasts support an optional `when` predicate on any node. This is the "if this then that" primitive — a node only runs when the guard returns `true`. When it returns `false`, the node is marked `"skipped"` and its downstream dependents are evaluated accordingly.

### Simple gate

```ts
export const orderFlow = broadcast("order-flow")
  .input(validateOrder)
  .then(chargePayment, {
    when: (prev) => prev["validate-order"].valid === true,
  })
  .then(sendReceipt)
  .build();
```

If `validateOrder` returns `{ valid: false }`, the `chargePayment` node is skipped, and `sendReceipt` (which depends on `chargePayment`) is also skipped because its upstream never completed.

### Branching (if/else pattern)

Use two nodes with complementary guards to model if/else:

```ts
export const paymentFlow = broadcast("payment-flow")
  .input(checkBalance)
  .then(chargeCard, {
    as: "card",
    when: (prev) => prev["check-balance"].balance < prev["check-balance"].amount,
  })
  .then(chargeWallet, {
    as: "wallet",
    when: (prev) => prev["check-balance"].balance >= prev["check-balance"].amount,
  })
  .then(sendReceipt, {
    after: ["card", "wallet"],
    map: (prev) => prev.card ?? prev.wallet,  // one will be undefined (skipped)
  })
  .build();
```

Only one of `chargeCard` or `chargeWallet` fires. `sendReceipt` runs after whichever branch completes — it depends on both but only needs one to not be skipped.

### How skipping propagates

When a node is skipped:
1. The node is marked `"skipped"` immediately (no signal run created).
2. Downstream nodes that **only** depend on skipped nodes are also skipped transitively.
3. Downstream nodes that have **other non-skipped upstream paths** can still proceed — they receive `undefined` for skipped upstreams in the `map` function.
4. A broadcast with skipped nodes can still reach `"completed"` status — skipped nodes are treated as terminal (like completed).

### When guard receives the same context as `map`

The `when` function receives the upstream outputs object (keyed by node name), exactly like `map`. This means you can inspect any upstream node's output to make the decision:

```ts
.then(escalateToManager, {
  after: ["review", "score"],
  when: (prev) => prev.score.value < 0.5 && prev.review.flagged,
})
```

### Design note: why `when` and not `.if()`

A dedicated `.if()` method would require special syntax for the "else" branch and would break the linear `.then()` chain. The `when` option on `.then()` is simpler:
- It composes with `map`, `after`, and `as` naturally
- If/else is just two `.then()` calls with complementary `when` guards
- No new builder method to learn — it's just another option

---

## 9. Error Handling & Failure Policies (+ skipped nodes)

### Node-level failure

When a signal run fails (after exhausting its own retry policy), the corresponding `BroadcastNodeRun` is marked as `"failed"`. What happens next depends on the broadcast's `failurePolicy`:

| Policy | Behavior |
|--------|----------|
| `"fail-fast"` (default) | Cancel all running nodes. Mark broadcast as failed. |
| `"skip-downstream"` | Skip nodes that depend on the failed node. Other branches continue. Mark broadcast as completed if all non-skipped nodes succeed. |
| `"continue"` | Ignore the failure. Downstream nodes that depend on the failed node are skipped, but the broadcast continues and completes if possible. |

### Broadcast-level retries

Broadcasts themselves can be retried, but this is a higher-level concern. For v1, a failed broadcast stays failed. Users can re-trigger it. Future versions could add `.retries(n)` to the broadcast builder.

### Signal retries are independent

Each signal has its own `maxAttempts` and retry backoff. The broadcast runner does not interfere with signal-level retries. A node is only marked as failed after the signal run reaches a terminal `"failed"` status (all attempts exhausted).

### Partial completion

A broadcast run can be in a state where some nodes completed and others failed. The `BroadcastRun.status` reflects the overall outcome:
- `"completed"` — all nodes reached a terminal state (completed or intentionally skipped).
- `"failed"` — at least one required node failed and the failure policy terminated the broadcast.

Node-level statuses are always available via `getNodeRuns(broadcastRunId)` for observability.

### Cancellation

`broadcastRunner.cancel(broadcastRunId)` cancels all running signal runs (via `signalRunner.cancel()`) and marks all pending nodes as `"skipped"`.

---

## 10. Subscriber Events

Broadcasts have their own subscriber interface, following the same optional-method pattern as `SignalSubscriber`:

```ts
interface BroadcastSubscriber {
  /** Broadcast definition discovered during auto-discovery. */
  onBroadcastDiscovered?(event: { broadcastName: string; filePath: string }): void;

  /** Broadcast run created and queued. */
  onBroadcastQueued?(event: { broadcastRun: BroadcastRun }): void;

  /** Broadcast run started (first nodes being triggered). */
  onBroadcastStarted?(event: { broadcastRun: BroadcastRun }): void;

  /** All nodes completed successfully. */
  onBroadcastCompleted?(event: { broadcastRun: BroadcastRun }): void;

  /** Broadcast failed (at least one required node failed). */
  onBroadcastFailed?(event: { broadcastRun: BroadcastRun; error?: string }): void;

  /** Broadcast cancelled. */
  onBroadcastCancelled?(event: { broadcastRun: BroadcastRun }): void;

  /** A node's signal was triggered. */
  onNodeTriggered?(event: {
    broadcastRun: BroadcastRun;
    nodeRun: BroadcastNodeRun;
  }): void;

  /** A node's signal completed. */
  onNodeCompleted?(event: {
    broadcastRun: BroadcastRun;
    nodeRun: BroadcastNodeRun;
  }): void;

  /** A node's signal failed. */
  onNodeFailed?(event: {
    broadcastRun: BroadcastRun;
    nodeRun: BroadcastNodeRun;
    error?: string;
  }): void;

  /** A node was skipped (downstream of a failed node). */
  onNodeSkipped?(event: {
    broadcastRun: BroadcastRun;
    nodeRun: BroadcastNodeRun;
    reason: string;
  }): void;
}
```

A `ConsoleBroadcastSubscriber` ships as default, matching the pattern of `ConsoleSubscriber`.

---

## 11. DAG Validation

The builder validates the graph at build time (`.build()`), not at runtime. This catches mistakes early:

1. **Cycle detection:** Topological sort of nodes. If it fails, throw with a clear message: `"Broadcast "name" contains a cycle: A -> B -> C -> A"`.
2. **Missing dependencies:** If a node references `after: ["x"]` and no node named `"x"` exists, throw: `"Node "y" depends on "x", but no node named "x" exists in broadcast "name"."`.
3. **Duplicate node names:** If two nodes would have the same name (either explicit `as` or signal name collision), throw: `"Duplicate node name "x" in broadcast "name". Use the "as" option to disambiguate."`.
4. **Unreachable nodes:** Warn (not error) if a node has no path from any root node.

---

## 12. Package Structure

```
packages/simple-signal-broadcast/
  src/
    index.ts                    # barrel exports
    types.ts                    # BroadcastRun, BroadcastNodeRun, etc.
    broadcast.ts                # broadcast() builder + BroadcastChain
    broadcast-runner.ts         # BroadcastRunner orchestrator
    adapters/
      index.ts                  # BroadcastQueueAdapter interface
      memory.ts                 # BroadcastMemoryAdapter
    subscribers/
      index.ts                  # BroadcastSubscriber interface
      console.ts                # ConsoleBroadcastSubscriber
    errors.ts                   # BroadcastValidationError, BroadcastCycleError
    util.ts                     # BROADCAST_BRAND, isBroadcast, topological sort
  package.json                  # peer-depends on "simple-signal"
```

The SQLite broadcast adapter would be added to `packages/adapter-sqlite` alongside the existing `SqliteAdapter`:

```ts
// packages/adapter-sqlite/src/broadcast.ts
export class BroadcastSqliteAdapter implements BroadcastQueueAdapter { ... }
```

### Exports

```ts
// packages/simple-signal-broadcast/src/index.ts
export { broadcast, BroadcastBuilder, BroadcastChain } from "./broadcast.js";
export { BroadcastRunner, type BroadcastRunnerOptions } from "./broadcast-runner.js";
export type {
  BroadcastDefinition,
  BroadcastNode,
  BroadcastRun,
  BroadcastRunStatus,
  BroadcastRunPatch,
  BroadcastNodeRun,
  BroadcastNodeStatus,
  BroadcastNodeRunPatch,
} from "./types.js";
export {
  type BroadcastQueueAdapter,
  BroadcastMemoryAdapter,
} from "./adapters/index.js";
export {
  type BroadcastSubscriber,
  ConsoleBroadcastSubscriber,
} from "./subscribers/index.js";
export {
  BroadcastValidationError,
  BroadcastCycleError,
} from "./errors.js";
export { isBroadcast, BROADCAST_BRAND } from "./util.js";
```

---

## 13. Required Changes to `simple-signal` Core

The broadcast package is designed to be **fully additive** with minimal changes to core:

1. **Add `adapter` getter to `SignalRunner`:**
   ```ts
   class SignalRunner {
     /** The underlying adapter. Useful for advanced queries and broadcast orchestration. */
     get adapter(): SignalQueueAdapter { return this._adapter; }
   }
   ```
   (Rename the private field from `adapter` to `_adapter`, or add a public getter alias.)

2. **No other changes required.** The broadcast package depends on `simple-signal` as a peer dependency and uses only the public API surface:
   - `SignalQueueAdapter` (for creating/reading signal runs)
   - `Signal` type (for referencing signals in the builder)
   - `Run`, `RunStatus` types
   - `SignalRunner.cancel()` (for broadcast cancellation)
   - `parseInterval()` (for recurring broadcasts)
   - `SIGNAL_BRAND` / `isSignal()` (for discovery)

---

## 14. Full Example — E-Commerce Order Pipeline

### Signal definitions (unchanged)

```ts
// signals/validate-order.ts
export const validateOrder = signal("validate-order")
  .input(z.object({ orderId: z.string(), amount: z.number() }))
  .output(z.object({ orderId: z.string(), amount: z.number(), valid: z.boolean() }))
  .run(async (input) => {
    if (input.amount <= 0) throw new Error("Invalid amount");
    return { ...input, valid: true };
  });

// signals/charge-payment.ts
export const chargePayment = signal("charge-payment")
  .input(z.object({ orderId: z.string(), amount: z.number(), valid: z.boolean() }))
  .output(z.object({ orderId: z.string(), chargeId: z.string() }))
  .retries(2)
  .run(async (input) => {
    const chargeId = `ch_${Math.random().toString(36).slice(2)}`;
    return { orderId: input.orderId, chargeId };
  });

// signals/send-receipt.ts
export const sendReceipt = signal("send-receipt")
  .input(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    console.log(`Sending receipt for ${input.orderId} (charge: ${input.chargeId})`);
  });

// signals/notify-warehouse.ts
export const notifyWarehouse = signal("notify-warehouse")
  .input(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    console.log(`Notifying warehouse for ${input.orderId}`);
  });
```

### Broadcast definition

```ts
// broadcasts/order-pipeline.ts
import { broadcast } from "@simple-signal/broadcast";
import { validateOrder, chargePayment, sendReceipt, notifyWarehouse } from "../signals/index.js";

export const orderPipeline = broadcast("order-pipeline")
  .input(validateOrder)
  .then(chargePayment)
  .then(sendReceipt, notifyWarehouse)  // fan-out: both run after charge completes
  .build();
```

### Runner

```ts
// runner.ts
import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "@simple-signal/broadcast";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";
import { BroadcastSqliteAdapter } from "@simple-signal/adapter-sqlite/broadcast";

const adapter = new SqliteAdapter({ dbPath: "orders.db" });

const signalRunner = new SignalRunner({
  signalsDir: "./signals",
  adapter,
  subscribers: [new ConsoleSubscriber()],
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  broadcastsDir: "./broadcasts",
  adapter: new BroadcastSqliteAdapter({ dbPath: "orders.db" }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

await Promise.all([signalRunner.start(), broadcastRunner.start()]);
```

### Trigger

```ts
// trigger.ts
import { configure } from "simple-signal";
import { configureBroadcast } from "@simple-signal/broadcast";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";
import { BroadcastSqliteAdapter } from "@simple-signal/adapter-sqlite/broadcast";
import { orderPipeline } from "./broadcasts/order-pipeline.js";

const adapter = new SqliteAdapter({ dbPath: "orders.db" });
configure({ adapter });
configureBroadcast({ adapter: new BroadcastSqliteAdapter({ dbPath: "orders.db" }) });

const broadcastRunId = await orderPipeline.trigger({ orderId: "ORD-42", amount: 99.99 });
console.log(`Broadcast triggered: ${broadcastRunId}`);
```

---

## 15. DX Quality Checklist

| Check | Status |
|-------|--------|
| Can a developer get started in 5 lines or fewer? | Yes: `broadcast("name").input(A).then(B).then(C).build()` |
| All config options optional with sensible defaults? | Yes: MemoryAdapter, fail-fast, 1s poll, ConsoleSubscriber |
| Type inference working with autocomplete? | Yes: TOutputs accumulator gives typed `map` functions |
| Error messages actionable? | Yes: cycle detection, missing deps, duplicate names all explain the fix |
| Adapters swappable without changing app code? | Yes: BroadcastQueueAdapter interface with Memory + SQLite impls |
| Builder chain intuitive and discoverable? | Yes: `input -> then -> then -> build` mirrors `signal -> input -> run` |
| Conditional logic without new syntax? | Yes: `when` option on `.then()` — if/else via complementary guards |
| No unnecessary required parameters? | Yes: only `name` and at least one signal |
| Naming consistent and self-documenting? | Yes: follows existing patterns (node/run/patch/subscriber) |
| Tree-shakeable? | Yes: separate package, barrel exports |
| Public API surface minimal but sufficient? | Yes: `broadcast()`, `BroadcastRunner`, adapter + subscriber interfaces |

---

## 16. Open Questions

1. **Should broadcasts auto-discover signals or require them to be imported?** The current design requires importing signal references into the broadcast file. This is more explicit and type-safe but means the broadcast file has import-time dependencies on signal files. An alternative would be to reference signals by name (`"validate-order"` instead of `validateOrder`), losing type safety but gaining flexibility.

   **Recommendation:** Import references (type-safe) for v1. Add name-based references later as an escape hatch.

2. **Should `BroadcastRunner` share the same adapter as `SignalRunner`?** If both use SQLite, they could share the same database/adapter instance. This RFC keeps them separate for simplicity, but a `UnifiedSqliteAdapter` that implements both interfaces is a natural v2 optimization.

3. **Event-driven vs polling for signal completion.** The RFC recommends polling for v1. The subscriber-based optimization (Option B in section 6) can be added later without breaking changes.

4. **Should the `map` function be async?** Currently proposed as synchronous since it should be a pure data transformation. If users need async operations between nodes, they should create a separate signal for it.

5. **Broadcast-level timeout?** Should broadcasts have a global timeout (like signal timeout) that kills the entire workflow if it takes too long? Useful for SLA enforcement. Proposed for v2.

---

## 17. Implementation Phases

### Phase 1: Core (MVP)
- Types (`BroadcastRun`, `BroadcastNodeRun`, etc.)
- Builder (`broadcast()`, `.input()`, `.then()`, `.build()`)
- DAG validation (cycles, missing deps, duplicates)
- `BroadcastMemoryAdapter`
- `BroadcastRunner` with polling-based orchestration
- `ConsoleBroadcastSubscriber`
- Linear chain + fan-out support
- `when` conditional guards (skip nodes + transitive skip propagation)
- `fail-fast` failure policy

### Phase 2: Persistence + Fan-in
- `BroadcastSqliteAdapter`
- Fan-in with explicit `after` + `map`
- `skip-downstream` and `continue` failure policies
- Recurring broadcasts
- Auto-discovery (`broadcastsDir`)

### Phase 3: Optimizations
- Subscriber-driven advancement (Option B)
- Broadcast-level timeout
- Broadcast retries
- `UnifiedSqliteAdapter`
- Broadcast-level `onComplete` handler
