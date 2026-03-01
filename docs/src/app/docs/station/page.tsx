import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Station Dashboard — Station",
};

export default function StationPage() {
  return (
    <>
      <div className="eyebrow">API Reference</div>
      <h2 style={{ marginTop: 0 }}>Station</h2>
      <p>
        Station is a monitoring dashboard for Station. It connects to your
        signal and broadcast adapters and provides a web interface for
        inspecting registered signals, browsing run history, and watching
        broadcast DAG execution in real time.
      </p>
      <p>
        Station is a combined:
      </p>
      <ul>
        <li>
          <strong>Hono API server</strong> — REST endpoints for signals, runs,
          broadcasts, and health checks, plus a WebSocket endpoint for
          real-time event streaming
        </li>
        <li>
          <strong>Next.js frontend</strong> — Dashboard UI that renders signal
          metadata, run history, broadcast DAG visualization, and live log
          output
        </li>
      </ul>
      <p>
        The API server runs on the configured port (default 4400). The Next.js
        frontend runs on port + 1 (default 4401). Both start automatically
        when you launch Station.
      </p>

      <hr className="divider" />

      {/* ── Install ── */}

      <h3>Install</h3>
      <Code>{`pnpm add station-kit`}</Code>

      <hr className="divider" />

      {/* ── Configuration ── */}

      <h3>Configuration</h3>
      <p>
        Create a <code>station.config.ts</code> (or <code>.js</code> / <code>.mjs</code>)
        in your project root:
      </p>
      <Code>{`import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
});`}</Code>
      <p>
        The <code>defineConfig</code> helper provides type checking and
        autocompletion. It is a pass-through function — it returns the object
        unchanged.
      </p>

      <h4>Config options</h4>
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
            <td><code>port</code></td>
            <td><code>number</code></td>
            <td><code>4400</code></td>
            <td>
              HTTP port for the API server. The Next.js UI runs
              on <code>port + 1</code>.
            </td>
          </tr>
          <tr>
            <td><code>host</code></td>
            <td><code>string</code></td>
            <td><code>{`"localhost"`}</code></td>
            <td>
              Hostname to bind both servers to. Set
              to <code>&quot;0.0.0.0&quot;</code> to listen on all interfaces.
            </td>
          </tr>
          <tr>
            <td><code>signalsDir</code></td>
            <td><code>string</code></td>
            <td>&mdash;</td>
            <td>
              Directory containing signal definition files. Station imports
              these to display signal metadata: input/output schemas, timeouts,
              retry counts, intervals, and concurrency settings. Falls back to
              a <code>signals/</code> directory in the working directory if one
              exists.
            </td>
          </tr>
          <tr>
            <td><code>broadcastsDir</code></td>
            <td><code>string</code></td>
            <td>&mdash;</td>
            <td>
              Directory containing broadcast definition files. Station imports
              these to display DAG structure, failure policies, and node
              dependencies. Falls back to a <code>broadcasts/</code> directory
              in the working directory if one exists.
            </td>
          </tr>
          <tr>
            <td><code>adapter</code></td>
            <td><code>SignalQueueAdapter</code></td>
            <td><code>MemoryAdapter</code></td>
            <td>
              Signal storage adapter. Must point to the same database as your
              runner to see its data. See{" "}
              <Link href="/docs/adapters">Adapters</Link>.
            </td>
          </tr>
          <tr>
            <td><code>broadcastAdapter</code></td>
            <td><code>BroadcastQueueAdapter</code></td>
            <td>&mdash;</td>
            <td>
              Broadcast storage adapter. Required for broadcast monitoring
              features. If omitted and <code>broadcastsDir</code> is set, a
              memory adapter is used.
            </td>
          </tr>
          <tr>
            <td><code>runRunners</code></td>
            <td><code>boolean</code></td>
            <td><code>true</code></td>
            <td>
              When <code>true</code>, Station runs its own
              SignalRunner and BroadcastRunner internally. Set
              to <code>false</code> for read-only monitoring of an existing
              runner&rsquo;s database.
            </td>
          </tr>
          <tr>
            <td><code>open</code></td>
            <td><code>boolean</code></td>
            <td><code>true</code></td>
            <td>
              Automatically open the dashboard in the default browser on
              startup.
            </td>
          </tr>
          <tr>
            <td><code>logLevel</code></td>
            <td><code>{`"debug" | "info" | "warn" | "error"`}</code></td>
            <td><code>{`"info"`}</code></td>
            <td>Controls Station&rsquo;s own console output verbosity.</td>
          </tr>
          <tr>
            <td><code>runner</code></td>
            <td><code>{`Partial<RunnerConfig>`}</code></td>
            <td>&mdash;</td>
            <td>
              Override signal runner settings. Only applies
              when <code>runRunners: true</code>. Fields:
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Runner config (nested under <code>runner</code>)</h4>
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
            <td><code>pollIntervalMs</code></td>
            <td><code>number</code></td>
            <td><code>1000</code></td>
            <td>Milliseconds between poll ticks for due runs.</td>
          </tr>
          <tr>
            <td><code>maxConcurrent</code></td>
            <td><code>number</code></td>
            <td><code>5</code></td>
            <td>Maximum number of signal runs executing simultaneously.</td>
          </tr>
          <tr>
            <td><code>maxAttempts</code></td>
            <td><code>number</code></td>
            <td><code>1</code></td>
            <td>
              Default maximum retry attempts for signals that do not specify
              their own.
            </td>
          </tr>
          <tr>
            <td><code>retryBackoffMs</code></td>
            <td><code>number</code></td>
            <td><code>1000</code></td>
            <td>Base delay in milliseconds between retry attempts.</td>
          </tr>
        </tbody>
      </table>

      <h4>Broadcast runner config (nested under <code>broadcastRunner</code>)</h4>
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
            <td><code>pollIntervalMs</code></td>
            <td><code>number</code></td>
            <td><code>1000</code></td>
            <td>Milliseconds between poll ticks for due broadcast runs.</td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Running Station ── */}

      <h3>Running Station</h3>
      <Code>{`npx station-kit`}</Code>
      <p>
        Station looks for <code>station.config.ts</code> (or <code>.js</code> / <code>.mjs</code>)
        in the current working directory. If no config file is found, it starts
        with default settings (MemoryAdapter, no signal directory).
      </p>

      <h4>Active mode vs. read-only mode</h4>
      <p>
        Station operates in one of two modes depending on
        the <code>runRunners</code> setting.
      </p>

      <p><strong>Active mode</strong> (<code>runRunners: true</code>, default)</p>
      <p>
        Station creates its own SignalRunner and BroadcastRunner. It discovers
        signals from <code>signalsDir</code>, polls the adapter for due runs,
        and executes them. Use this when you want Station to be your only
        runner process. The dashboard provides full functionality: monitoring,
        triggering signals, and cancelling runs.
      </p>

      <p><strong>Read-only mode</strong> (<code>runRunners: false</code>)</p>
      <p>
        Station only reads from the adapter. It does not create runners, does
        not execute signals, and does not poll for due runs. Use this when you
        have a separate runner process and want Station purely for monitoring.
        Trigger and cancel endpoints return <code>403</code> in this mode.
      </p>

      <div className="warn-box">
        In read-only mode, Station still needs <code>signalsDir</code> and <code>broadcastsDir</code> to
        import signal/broadcast definitions for metadata display (schemas,
        intervals, DAG structure). Without these directories, the dashboard
        shows run data but not signal configuration details.
      </div>

      <hr className="divider" />

      {/* ── Dashboard features ── */}

      <h3>Dashboard features</h3>

      <h4>Signals list</h4>
      <p>
        View all registered signals with their name, input/output schemas
        (rendered from Zod definitions), timeout, retry count, recurring
        interval, concurrency settings, step names, and source file path.
      </p>

      <h4>Scheduled signals</h4>
      <p>
        Recurring signals get a dedicated view showing the interval, next
        scheduled run time, last execution time, and last execution status.
      </p>

      <h4>Run history</h4>
      <p>
        Browse all past and current signal runs. Filter by status
        (pending, running, completed, failed, cancelled) or by signal name.
        Each run shows the full detail: input data, output data, error
        messages, timing (created, started, completed), attempt count, and
        step execution records.
      </p>

      <h4>Run logs</h4>
      <p>
        View stdout and stderr output captured from signal handler execution.
        Logs are stored in an in-memory buffer and persisted to a separate
        SQLite database (<code>station-logs.db</code>) for survival across
        restarts.
      </p>

      <h4>Broadcast visualization</h4>
      <p>
        See the DAG structure of registered broadcasts — which nodes exist,
        their signal mappings, and dependency edges. During execution, node
        statuses (pending, running, completed, failed, skipped) update in real
        time. Includes skip reasons when nodes are bypassed due to guard
        conditions, upstream failures, or cancellation.
      </p>

      <h4>Real-time updates</h4>
      <p>
        A WebSocket connection on <code>/api/events</code> pushes lifecycle
        events as they happen. The frontend subscribes automatically — no
        polling required. Events cover the full signal and broadcast lifecycle
        (see WebSocket events table below).
      </p>

      <h4>Actions</h4>
      <p>
        In active mode, the dashboard allows triggering signals with custom
        input and cancelling in-progress runs or broadcast runs.
      </p>

      <hr className="divider" />

      {/* ── API endpoints ── */}

      <h3>API endpoints</h3>
      <p>
        Station exposes a REST API on the configured port. All responses use
        the shape <code>{`{ data: ... }`}</code> on success
        or <code>{`{ error: string, message: string }`}</code> on failure.
      </p>

      <h4>Health</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Method</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/api/health</code></td>
            <td>GET</td>
            <td>
              Health check. Calls <code>ping()</code> on the signal adapter and
              broadcast adapter (if configured). Returns <code>{`{ ok, signal, broadcast }`}</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Signals</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Method</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/api/signals</code></td>
            <td>GET</td>
            <td>
              List all registered signals with metadata — name, file path,
              input/output schemas, interval, timeout, max attempts, max
              concurrency, step names.
            </td>
          </tr>
          <tr>
            <td><code>/api/signals/scheduled</code></td>
            <td>GET</td>
            <td>
              List recurring signals with their interval, next scheduled run,
              last run time, and last run status.
            </td>
          </tr>
          <tr>
            <td><code>/api/signals/:name</code></td>
            <td>GET</td>
            <td>
              Get details for a specific signal. Returns 404 if not found.
            </td>
          </tr>
          <tr>
            <td><code>/api/signals/:name/trigger</code></td>
            <td>POST</td>
            <td>
              Trigger a signal with optional input. Body: <code>{`{ "input": { ... } }`}</code>.
              Returns the new run ID. Returns 403 in read-only mode, 404 if
              signal not found.
            </td>
          </tr>
          <tr>
            <td><code>/api/signals/:name/runs</code></td>
            <td>GET</td>
            <td>
              List all runs for a specific signal.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Runs</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Method</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/api/runs</code></td>
            <td>GET</td>
            <td>
              List runs. Query
              params: <code>?status=pending|running|completed|failed|cancelled</code>, <code>?signalName=name</code>.
              Sorted by <code>createdAt</code> descending.
            </td>
          </tr>
          <tr>
            <td><code>/api/runs/stats</code></td>
            <td>GET</td>
            <td>
              Aggregate run counts by status. Returns <code>{`{ pending, running, completed, failed, cancelled }`}</code>.
            </td>
          </tr>
          <tr>
            <td><code>/api/runs/:id</code></td>
            <td>GET</td>
            <td>
              Get a single run&rsquo;s full details including input, output, error,
              timing, and attempts. Returns 404 if not found.
            </td>
          </tr>
          <tr>
            <td><code>/api/runs/:id/steps</code></td>
            <td>GET</td>
            <td>
              Get step execution records for a run. Each step includes name,
              status, input, output, error, and timestamps.
            </td>
          </tr>
          <tr>
            <td><code>/api/runs/:id/logs</code></td>
            <td>GET</td>
            <td>
              Get captured stdout/stderr log lines for a run.
            </td>
          </tr>
          <tr>
            <td><code>/api/runs/:id/cancel</code></td>
            <td>POST</td>
            <td>
              Cancel a run. Returns 403 in read-only mode, 400 if the run
              cannot be cancelled.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Broadcasts</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Method</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>/api/broadcasts</code></td>
            <td>GET</td>
            <td>
              List all registered broadcasts with DAG structure — node names,
              signal mappings, dependency edges, failure policy.
            </td>
          </tr>
          <tr>
            <td><code>/api/broadcasts/:name</code></td>
            <td>GET</td>
            <td>
              Get a single broadcast&rsquo;s metadata and DAG structure. Returns
              404 if not found.
            </td>
          </tr>
          <tr>
            <td><code>/api/broadcasts/:name/trigger</code></td>
            <td>POST</td>
            <td>
              Trigger a broadcast with optional input. Body: <code>{`{ "input": { ... } }`}</code>.
              Returns the new broadcast run ID. Returns 403 in read-only mode.
            </td>
          </tr>
          <tr>
            <td><code>/api/broadcasts/:name/runs</code></td>
            <td>GET</td>
            <td>
              List all runs for a specific broadcast.
            </td>
          </tr>
          <tr>
            <td><code>/api/broadcast-runs/:id</code></td>
            <td>GET</td>
            <td>
              Get a broadcast run&rsquo;s full details. Returns 404 if not found.
            </td>
          </tr>
          <tr>
            <td><code>/api/broadcast-runs/:id/nodes</code></td>
            <td>GET</td>
            <td>
              Get all node runs for a broadcast execution. Each node includes
              name, signal name, signal run ID, status, skip reason, input,
              output, error, and timestamps.
            </td>
          </tr>
          <tr>
            <td><code>/api/broadcast-runs/:id/logs</code></td>
            <td>GET</td>
            <td>
              Get aggregated logs from all node signal runs in a broadcast
              execution. Sorted by timestamp.
            </td>
          </tr>
          <tr>
            <td><code>/api/broadcast-runs/:id/cancel</code></td>
            <td>POST</td>
            <td>
              Cancel a broadcast run. Returns 403 in read-only mode, 400 if it
              cannot be cancelled.
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── WebSocket events ── */}

      <h3>WebSocket events</h3>
      <p>
        Connect to <code>/api/events</code> on the API server port. Each
        message is a JSON object with <code>type</code>, <code>timestamp</code>,
        and <code>data</code> fields.
      </p>

      <h4>Signal events</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Event type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>signal:discovered</code></td>
            <td>A signal file was found during directory scanning.</td>
          </tr>
          <tr>
            <td><code>run:dispatched</code></td>
            <td>A run was picked up from the queue and dispatched for execution.</td>
          </tr>
          <tr>
            <td><code>run:started</code></td>
            <td>A run&rsquo;s handler began executing in the child process.</td>
          </tr>
          <tr>
            <td><code>run:completed</code></td>
            <td>A run finished successfully. Includes output data.</td>
          </tr>
          <tr>
            <td><code>run:failed</code></td>
            <td>A run failed after exhausting all retry attempts. Includes error message.</td>
          </tr>
          <tr>
            <td><code>run:timeout</code></td>
            <td>A run exceeded its timeout and was killed.</td>
          </tr>
          <tr>
            <td><code>run:retry</code></td>
            <td>A run failed but has remaining attempts. Includes current attempt and max attempts.</td>
          </tr>
          <tr>
            <td><code>run:cancelled</code></td>
            <td>A run was cancelled via the API or programmatically.</td>
          </tr>
          <tr>
            <td><code>run:skipped</code></td>
            <td>A recurring run was skipped (e.g. previous run still active).</td>
          </tr>
          <tr>
            <td><code>run:rescheduled</code></td>
            <td>A recurring run was rescheduled. Includes the next run time.</td>
          </tr>
          <tr>
            <td><code>step:started</code></td>
            <td>A step within a multi-step signal began executing.</td>
          </tr>
          <tr>
            <td><code>step:completed</code></td>
            <td>A step finished successfully.</td>
          </tr>
          <tr>
            <td><code>step:failed</code></td>
            <td>A step failed.</td>
          </tr>
          <tr>
            <td><code>log:output</code></td>
            <td>
              A line of stdout or stderr was captured from a running signal
              handler. Includes run ID, signal name, level, and message.
            </td>
          </tr>
          <tr>
            <td><code>run:completeError</code></td>
            <td>An error occurred while trying to mark a run as complete (e.g. adapter failure during finalization).</td>
          </tr>
        </tbody>
      </table>

      <h4>Broadcast events</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Event type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>broadcast:discovered</code></td>
            <td>A broadcast file was found during directory scanning.</td>
          </tr>
          <tr>
            <td><code>broadcast:queued</code></td>
            <td>A broadcast run was added to the queue.</td>
          </tr>
          <tr>
            <td><code>broadcast:started</code></td>
            <td>A broadcast began executing its DAG.</td>
          </tr>
          <tr>
            <td><code>broadcast:completed</code></td>
            <td>All nodes in the broadcast finished successfully.</td>
          </tr>
          <tr>
            <td><code>broadcast:failed</code></td>
            <td>The broadcast failed. Includes error message.</td>
          </tr>
          <tr>
            <td><code>broadcast:cancelled</code></td>
            <td>The broadcast was cancelled.</td>
          </tr>
          <tr>
            <td><code>node:triggered</code></td>
            <td>A DAG node&rsquo;s signal was triggered for execution.</td>
          </tr>
          <tr>
            <td><code>node:completed</code></td>
            <td>A DAG node&rsquo;s signal completed successfully.</td>
          </tr>
          <tr>
            <td><code>node:failed</code></td>
            <td>A DAG node&rsquo;s signal failed. Includes error message.</td>
          </tr>
          <tr>
            <td><code>node:skipped</code></td>
            <td>
              A DAG node was skipped. Includes the reason: <code>guard</code> (guard
              function returned false), <code>upstream-failed</code> (a
              dependency failed), or <code>cancelled</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Using Station with an existing runner ── */}

      <h3>Using Station with an existing runner</h3>
      <p>
        A common setup: one process runs signals, another runs Station for
        monitoring. Both point at the same SQLite database.
      </p>

      <Code>{`// runner.ts — executes signals
import path from "node:path";
import { SignalRunner } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
});

runner.start();`}</Code>

      <Code>{`// station.config.ts — read-only monitoring
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
  runRunners: false, // Don't execute signals — just monitor
});`}</Code>

      <div className="info-box">
        SQLite with WAL mode supports concurrent readers and a single writer.
        The runner process writes; Station reads. Both can open the same
        database file simultaneously without conflict.
      </div>

      <hr className="divider" />

      {/* ── Graceful shutdown ── */}

      <h3>Graceful shutdown</h3>
      <p>
        Station listens for <code>SIGINT</code> and <code>SIGTERM</code>. On
        shutdown, it stops the broadcast runner first (it may query the
        database during cleanup), then the signal runner, then closes the
        WebSocket server, log store, and HTTP server. Both runners are given a
        5-second grace period to finish in-flight work.
      </p>
    </>
  );
}
