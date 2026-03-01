import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Adapters — Station",
};

export default function AdaptersPage() {
  return (
    <>
      <div className="eyebrow">API Reference</div>
      <h2 style={{ marginTop: 0 }}>Adapters</h2>
      <p>
        Adapters are pluggable storage backends. They determine how signal runs
        are persisted and retrieved. The runner polls the adapter for due
        entries on every tick, and signal handlers write their results back
        through it.
      </p>
      <p>
        Two built-in adapters ship with Station. You can write custom adapters
        by implementing the <code>SignalQueueAdapter</code> interface (for
        signals) or <code>BroadcastQueueAdapter</code> interface (for
        broadcasts).
      </p>

      <hr className="divider" />

      {/* ── MemoryAdapter ── */}

      <h3>MemoryAdapter</h3>
      <p>
        The default adapter when none is specified. Stores all runs in a
        JavaScript <code>Map</code> inside the process. No data survives a
        restart. Good for development, testing, and single-run scripts where
        persistence is irrelevant.
      </p>
      <ul>
        <li>No external dependencies</li>
        <li>No configuration required</li>
        <li>Cannot share state across processes — each process gets its own isolated store</li>
        <li>
          Does not implement <code>SerializableAdapter</code>, so child
          processes spawned by the runner cannot access the parent&rsquo;s
          in-memory data
        </li>
      </ul>
      <Code>{`import { SignalRunner } from "station-signal";

// MemoryAdapter is the default — no configuration needed
const runner = new SignalRunner({
  signalsDir: "./signals",
});`}</Code>
      <p>
        To explicitly construct one (for example, to pass to Station):
      </p>
      <Code>{`import { MemoryAdapter } from "station-signal";

const adapter = new MemoryAdapter();`}</Code>

      <hr className="divider" />

      {/* ── SqliteAdapter ── */}

      <h3>SqliteAdapter</h3>
      <p>
        Production-ready persistent storage backed
        by <a href="https://github.com/WiseLibs/better-sqlite3">better-sqlite3</a> —
        synchronous C++ bindings that are significantly faster than async
        alternatives for single-node workloads.
      </p>
      <p>
        WAL (Write-Ahead Logging) mode is enabled on connection, allowing
        concurrent reads and writes without blocking. Tables, indexes, and
        columns are created automatically on first use. Date fields are stored
        as ISO-8601 text strings.
      </p>
      <p>
        The adapter interface is async (all methods return Promises) even
        though better-sqlite3 is synchronous. This preserves compatibility
        with the adapter contract so that truly async backends (Postgres,
        DynamoDB, etc.) can implement the same interface without friction.
      </p>

      <h4>Install</h4>
      <Code>{`pnpm add station-adapter-sqlite`}</Code>

      <div className="info-box">
        <strong>pnpm 10+:</strong> better-sqlite3 is a native addon that compiles
        C++ during installation. pnpm 10 blocks dependency build scripts by
        default. Add this to your project&rsquo;s <code>package.json</code> and
        re-run <code>pnpm install</code>:
        <Code>{`{
  "pnpm": {
    "onlyBuiltDependencies": ["better-sqlite3"]
  }
}`}</Code>
      </div>

      <h4>Usage</h4>
      <Code>{`import { SqliteAdapter } from "station-adapter-sqlite";

const adapter = new SqliteAdapter({
  dbPath: "./jobs.db",
});`}</Code>

      <h4>Options</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Option</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>dbPath</code></td>
            <td><code>string</code></td>
            <td><code>{`"station.db"`}</code></td>
            <td>
              Path to the SQLite database file. Created automatically if it
              does not exist.
            </td>
          </tr>
          <tr>
            <td><code>tableName</code></td>
            <td><code>string</code></td>
            <td><code>{`"runs"`}</code></td>
            <td>
              Table name for signal run entries. Must be alphanumeric and
              underscores only. A companion <code>{`{tableName}_steps`}</code> table
              is created for step data.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Methods</h4>
      <p>
        Implements every method from <code>SignalQueueAdapter</code> (see below),
        plus:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>close()</code></td>
            <td>
              Close the database connection. Call during graceful shutdown to
              flush the WAL and release the file lock.
            </td>
          </tr>
          <tr>
            <td><code>toManifest()</code></td>
            <td>
              Returns a serializable descriptor so child processes can
              reconstruct this adapter automatically. Part of
              the <code>SerializableAdapter</code> interface.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Database schema</h4>
      <p>
        The adapter creates a <code>runs</code> table (or whatever you set
        in <code>tableName</code>) with these columns:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>id</code></td>
            <td>TEXT PK</td>
            <td>UUID generated by the adapter</td>
          </tr>
          <tr>
            <td><code>signal_name</code></td>
            <td>TEXT</td>
            <td>Name of the signal that owns this run</td>
          </tr>
          <tr>
            <td><code>kind</code></td>
            <td>TEXT</td>
            <td><code>trigger</code> or <code>recurring</code></td>
          </tr>
          <tr>
            <td><code>input</code></td>
            <td>TEXT</td>
            <td>JSON-serialized input payload</td>
          </tr>
          <tr>
            <td><code>output</code></td>
            <td>TEXT</td>
            <td>JSON-serialized output on completion</td>
          </tr>
          <tr>
            <td><code>error</code></td>
            <td>TEXT</td>
            <td>Error message on failure</td>
          </tr>
          <tr>
            <td><code>status</code></td>
            <td>TEXT</td>
            <td><code>pending</code> | <code>running</code> | <code>completed</code> | <code>failed</code> | <code>cancelled</code></td>
          </tr>
          <tr>
            <td><code>attempts</code></td>
            <td>INTEGER</td>
            <td>How many times this run has been attempted</td>
          </tr>
          <tr>
            <td><code>max_attempts</code></td>
            <td>INTEGER</td>
            <td>Maximum retry count before marking failed</td>
          </tr>
          <tr>
            <td><code>timeout</code></td>
            <td>INTEGER</td>
            <td>Timeout in milliseconds</td>
          </tr>
          <tr>
            <td><code>interval</code></td>
            <td>TEXT</td>
            <td>Recurring interval string (e.g. <code>"every 5m"</code>). Null for triggered runs.</td>
          </tr>
          <tr>
            <td><code>next_run_at</code></td>
            <td>TEXT</td>
            <td>ISO-8601 timestamp of when this run becomes due</td>
          </tr>
          <tr>
            <td><code>last_run_at</code></td>
            <td>TEXT</td>
            <td>ISO-8601 timestamp of last execution start</td>
          </tr>
          <tr>
            <td><code>started_at</code></td>
            <td>TEXT</td>
            <td>ISO-8601 timestamp when execution began</td>
          </tr>
          <tr>
            <td><code>completed_at</code></td>
            <td>TEXT</td>
            <td>ISO-8601 timestamp when execution finished</td>
          </tr>
          <tr>
            <td><code>created_at</code></td>
            <td>TEXT</td>
            <td>ISO-8601 timestamp when the run was queued</td>
          </tr>
        </tbody>
      </table>
      <p>
        Three indexes are created automatically: a composite index
        on <code>(status, next_run_at)</code> for the <code>getRunsDue()</code> query,
        a partial index on <code>status</code> where <code>status = &apos;running&apos;</code> for
        the <code>getRunsRunning()</code> query, and an index
        on <code>signal_name</code> for <code>listRuns()</code> queries.
      </p>
      <p>
        A companion <code>{`{tableName}_steps`}</code> table stores step execution
        records, linked by a foreign key with <code>ON DELETE CASCADE</code>.
      </p>

      <hr className="divider" />

      {/* ── BroadcastSqliteAdapter ── */}

      <h3>BroadcastSqliteAdapter</h3>
      <p>
        Persistent storage for broadcast runs and their individual node runs.
        Ships in the same package as <code>SqliteAdapter</code> — import it
        from the <code>/broadcast</code> subpath.
      </p>

      <h4>Install</h4>
      <Code>{`pnpm add station-adapter-sqlite`}</Code>

      <h4>Usage</h4>
      <Code>{`import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

const broadcastAdapter = new BroadcastSqliteAdapter({
  dbPath: "./jobs.db",
});`}</Code>

      <div className="info-box">
        You can (and should) point both adapters at the same database file.
        They use separate tables: <code>runs</code> for signals
        and <code>broadcast_runs</code> / <code>broadcast_runs_nodes</code> for
        broadcasts. Sharing a file avoids managing multiple SQLite databases.
      </div>

      <h4>Options</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Option</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>dbPath</code></td>
            <td><code>string</code></td>
            <td><code>{`"station.db"`}</code></td>
            <td>Path to the SQLite database file.</td>
          </tr>
          <tr>
            <td><code>tableName</code></td>
            <td><code>string</code></td>
            <td><code>{`"broadcast_runs"`}</code></td>
            <td>
              Table name for broadcast run entries. A
              companion <code>{`{tableName}_nodes`}</code> table is created for
              node runs.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Methods</h4>
      <p>
        Implements every method from <code>BroadcastQueueAdapter</code> (see
        below), plus <code>close()</code> for graceful shutdown.
      </p>

      <hr className="divider" />

      {/* ── configModule pattern ── */}

      <h3>Sharing adapters across processes</h3>
      <p>
        When the runner spawns a child process to execute a signal handler,
        that child process needs to know which adapter to use. If the handler
        calls <code>.trigger()</code> on another signal, the trigger must write
        to the same database. There are two ways to solve this.
      </p>

      <h4>Automatic: SerializableAdapter</h4>
      <p>
        <code>SqliteAdapter</code> implements the <code>SerializableAdapter</code> interface.
        When the runner detects a serializable adapter, it passes a compact
        manifest (adapter name + constructor options) to the child process,
        which reconstructs an identical adapter instance automatically. No extra
        configuration is needed.
      </p>
      <Code>{`import path from "node:path";
import { SignalRunner } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

// SqliteAdapter is serializable — child processes
// reconstruct it from the manifest automatically.
const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
});`}</Code>

      <h4>Manual: configModule</h4>
      <p>
        For adapters that are not serializable, or when you need to run
        additional setup code in the child process, use
        the <code>configModule</code> option. Create a module that
        calls <code>configure()</code>, and point the runner at it:
      </p>
      <Code>{`// config.ts
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

configure({
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
});`}</Code>
      <Code>{`// runner.ts
import path from "node:path";
import { SignalRunner } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  configModule: path.join(import.meta.dirname, "config.ts"),
});`}</Code>
      <p>
        The runner imports the <code>configModule</code> before executing each
        signal handler in the child process. This sets the global adapter so
        that <code>.trigger()</code> calls inside handlers write to the correct
        database.
      </p>

      <div className="info-box">
        If your triggers always happen in the runner process (e.g. recurring
        signals, or signals triggered from an API route in the same process),
        you do not need <code>configModule</code>. The runner&rsquo;s adapter is
        already available.
      </div>

      <hr className="divider" />

      {/* ── Writing a custom adapter ── */}

      <h3>Writing a custom adapter</h3>

      <h4>SignalQueueAdapter</h4>
      <p>
        Implement this interface to create a custom storage backend for
        signals. Every method is async to support both synchronous and
        network-based backends.
      </p>
      <Code>{`interface SignalQueueAdapter {
  addRun(run: Run): Promise<void>;
  removeRun(id: string): Promise<void>;
  getRun(id: string): Promise<Run | null>;
  getRunsDue(): Promise<Run[]>;
  getRunsRunning(): Promise<Run[]>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  listRuns(signalName: string): Promise<Run[]>;
  hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean>;
  purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number>;

  addStep(step: Step): Promise<void>;
  updateStep(id: string, patch: StepPatch): Promise<void>;
  getSteps(runId: string): Promise<Step[]>;
  removeSteps(runId: string): Promise<void>;

  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Contract</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>addRun(run)</code></td>
            <td>
              Store a new run. The run arrives with <code>status: &quot;pending&quot;</code> and
              a <code>nextRunAt</code> timestamp indicating when it becomes due.
            </td>
          </tr>
          <tr>
            <td><code>removeRun(id)</code></td>
            <td>
              Delete a run and its associated steps. Called for completed
              non-recurring runs during cleanup.
            </td>
          </tr>
          <tr>
            <td><code>getRun(id)</code></td>
            <td>
              Retrieve a single run by ID. Return <code>null</code> if it does
              not exist.
            </td>
          </tr>
          <tr>
            <td><code>getRunsDue()</code></td>
            <td>
              Return all runs where <code>status === &quot;pending&quot;</code> and <code>nextRunAt &lt;= now</code> (or <code>nextRunAt</code> is
              null). The runner calls this on every poll tick. Order
              by <code>createdAt</code> ascending.
            </td>
          </tr>
          <tr>
            <td><code>getRunsRunning()</code></td>
            <td>
              Return all runs with <code>status === &quot;running&quot;</code>. Used by
              the runner for timeout detection.
            </td>
          </tr>
          <tr>
            <td><code>updateRun(id, patch)</code></td>
            <td>
              Partially update a run&rsquo;s fields. Used to change status,
              increment attempts, set timestamps, and store output or error
              messages.
            </td>
          </tr>
          <tr>
            <td><code>listRuns(signalName)</code></td>
            <td>
              Return all runs for a given signal name. Used by Station and
              for concurrency checks.
            </td>
          </tr>
          <tr>
            <td><code>hasRunWithStatus(signalName, statuses)</code></td>
            <td>
              Return <code>true</code> if any run for the given signal has one
              of the specified statuses. Used for concurrency gating (e.g.
              preventing duplicate recurring runs).
            </td>
          </tr>
          <tr>
            <td><code>purgeRuns(olderThan, statuses)</code></td>
            <td>
              Delete runs in terminal statuses whose <code>completedAt</code> is
              older than the given date. Return the count deleted.
            </td>
          </tr>
          <tr>
            <td><code>addStep(step)</code></td>
            <td>
              Store a new step record. Steps belong to a run and track
              individual step execution within multi-step signals.
            </td>
          </tr>
          <tr>
            <td><code>updateStep(id, patch)</code></td>
            <td>
              Partially update a step&rsquo;s fields — status, output, error,
              timestamps.
            </td>
          </tr>
          <tr>
            <td><code>getSteps(runId)</code></td>
            <td>Return all steps for a given run.</td>
          </tr>
          <tr>
            <td><code>removeSteps(runId)</code></td>
            <td>Delete all steps for a given run.</td>
          </tr>
          <tr>
            <td><code>generateId()</code></td>
            <td>
              Return a unique ID string for new runs and steps. UUID, nanoid,
              ULID, or any scheme that produces unique strings.
            </td>
          </tr>
          <tr>
            <td><code>ping()</code></td>
            <td>
              Health check. Return <code>true</code> if the adapter is
              operational. Called during runner startup and by Station&rsquo;s health
              endpoint.
            </td>
          </tr>
          <tr>
            <td><code>close()</code></td>
            <td>
              Optional. Clean up resources (close database connections, flush
              buffers). Called during graceful shutdown.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>BroadcastQueueAdapter</h4>
      <p>
        Implement this interface for custom broadcast storage. Broadcast
        adapters track two entity types: broadcast runs (the overall
        execution) and node runs (one per DAG node per execution).
      </p>
      <Code>{`interface BroadcastQueueAdapter {
  addBroadcastRun(run: BroadcastRun): Promise<void>;
  getBroadcastRun(id: string): Promise<BroadcastRun | null>;
  updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void>;
  getBroadcastRunsDue(): Promise<BroadcastRun[]>;
  getBroadcastRunsRunning(): Promise<BroadcastRun[]>;
  listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]>;
  hasBroadcastRunWithStatus(
    broadcastName: string,
    statuses: BroadcastRunStatus[],
  ): Promise<boolean>;
  purgeBroadcastRuns(
    olderThan: Date,
    statuses: BroadcastRunStatus[],
  ): Promise<number>;

  addNodeRun(nodeRun: BroadcastNodeRun): Promise<void>;
  getNodeRun(id: string): Promise<BroadcastNodeRun | null>;
  updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void>;
  getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]>;

  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Contract</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>addBroadcastRun(run)</code></td>
            <td>
              Store a new broadcast run with <code>status: &quot;pending&quot;</code>.
              Includes the broadcast name, serialized input, failure policy,
              and scheduling fields.
            </td>
          </tr>
          <tr>
            <td><code>getBroadcastRun(id)</code></td>
            <td>
              Retrieve a broadcast run by ID. Return <code>null</code> if not
              found.
            </td>
          </tr>
          <tr>
            <td><code>updateBroadcastRun(id, patch)</code></td>
            <td>
              Partially update broadcast run fields — status, timestamps,
              error.
            </td>
          </tr>
          <tr>
            <td><code>getBroadcastRunsDue()</code></td>
            <td>
              Return pending broadcast runs where <code>nextRunAt &lt;= now</code>.
              Polled on each broadcast runner tick.
            </td>
          </tr>
          <tr>
            <td><code>getBroadcastRunsRunning()</code></td>
            <td>
              Return all broadcast runs with <code>status === &quot;running&quot;</code>.
              Used for timeout detection.
            </td>
          </tr>
          <tr>
            <td><code>listBroadcastRuns(broadcastName)</code></td>
            <td>Return all runs for a given broadcast name.</td>
          </tr>
          <tr>
            <td><code>hasBroadcastRunWithStatus(name, statuses)</code></td>
            <td>
              Return <code>true</code> if any run for the broadcast has one of
              the specified statuses.
            </td>
          </tr>
          <tr>
            <td><code>purgeBroadcastRuns(olderThan, statuses)</code></td>
            <td>
              Delete broadcast runs (and their node runs via cascade) older
              than the given date. Return count deleted.
            </td>
          </tr>
          <tr>
            <td><code>addNodeRun(nodeRun)</code></td>
            <td>
              Store a node run. Each node in the DAG gets one record per
              broadcast execution. Includes the node name, linked signal name,
              and initial status.
            </td>
          </tr>
          <tr>
            <td><code>getNodeRun(id)</code></td>
            <td>
              Retrieve a single node run by ID. Return <code>null</code> if not
              found.
            </td>
          </tr>
          <tr>
            <td><code>updateNodeRun(id, patch)</code></td>
            <td>
              Partially update a node run — status, signal run ID, output,
              error, skip reason, timestamps.
            </td>
          </tr>
          <tr>
            <td><code>getNodeRuns(broadcastRunId)</code></td>
            <td>Return all node runs for a given broadcast run.</td>
          </tr>
          <tr>
            <td><code>generateId()</code></td>
            <td>Return a unique ID string for new broadcast and node runs.</td>
          </tr>
          <tr>
            <td><code>ping()</code></td>
            <td>Health check. Return <code>true</code> if operational.</td>
          </tr>
          <tr>
            <td><code>close()</code></td>
            <td>Optional. Clean up resources during graceful shutdown.</td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── SerializableAdapter ── */}

      <h3>SerializableAdapter</h3>
      <p>
        If you write a custom adapter that needs to work across processes
        (child process execution of signal handlers), implement
        the <code>SerializableAdapter</code> interface in addition
        to <code>SignalQueueAdapter</code>:
      </p>
      <Code>{`interface SerializableAdapter extends SignalQueueAdapter {
  toManifest(): AdapterManifest;
}

interface AdapterManifest {
  name: string;                       // Registry key (e.g. "sqlite")
  options: Record<string, unknown>;   // Constructor options (must be JSON-serializable)
  moduleUrl?: string;                 // Absolute URL to the module that registers this adapter
}`}</Code>
      <p>
        Register your adapter with a factory function so the child process
        can reconstruct it from the manifest:
      </p>
      <Code>{`import { registerAdapter } from "station-signal";

registerAdapter("my-adapter", (options) => {
  return new MyAdapter(options as MyAdapterOptions);
});`}</Code>
      <p>
        When the runner detects a <code>SerializableAdapter</code>, it skips
        the <code>configModule</code> path entirely — the manifest is passed
        to the child process as a lightweight JSON payload, and the adapter is
        reconstructed from the registered factory.
      </p>
    </>
  );
}
