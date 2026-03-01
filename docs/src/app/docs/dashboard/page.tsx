import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Dashboard Guide — Station",
};

export default function DashboardPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Dashboard</h2>
      <p>
        Station ships with a real-time monitoring dashboard. It connects to your
        signal and broadcast adapters and gives you a web interface for
        inspecting runs, browsing history, triggering signals, and watching
        broadcast DAG execution as it happens. It is included in
        the <code>station-kit</code> package.
      </p>

      <hr className="divider" />

      {/* ── Quick start ── */}

      <h3>Quick start</h3>
      <p>Install <code>station-kit</code> and an adapter.</p>
      <Code>{`pnpm add station-kit station-adapter-sqlite`}</Code>
      <p>
        Create a <code>station.config.ts</code> in your project root.
      </p>
      <Code>{`// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
  auth: {
    username: "admin",
    password: "changeme",
  },
});`}</Code>
      <p>Start the dashboard.</p>
      <Code>{`npx station`}</Code>
      <p>
        The API server runs on port 4400. The dashboard UI opens
        on port 4401. Both start automatically.
      </p>

      <div className="warn-box">
        <p>
          The <code>auth</code> block is optional but strongly recommended for
          any non-local deployment. Without it, the dashboard has no login gate.
        </p>
      </div>

      <hr className="divider" />

      {/* ── Login ── */}

      <h3>Login</h3>
      <img
        src="/screenshots/login.png"
        alt="Login screen with Station logo, username and password fields, and a green Sign in button"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        When <code>auth</code> is configured in <code>station.config.ts</code>,
        the dashboard presents a login screen. Credentials are the
        plain <code>username</code> and <code>password</code> values from your
        config file. After sign-in, a session cookie is set. Sessions persist
        across browser refreshes until the cookie expires or the server restarts.
      </p>

      <hr className="divider" />

      {/* ── Overview ── */}

      <h3>Overview</h3>
      <img
        src="/screenshots/overview.png"
        alt="Overview page showing stat cards for Pending, Running, Completed, Failed, and Cancelled runs, a Recent Failures table, and a Live Activity feed"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        The overview is the landing page after login. It has three sections.
      </p>
      <p>
        <strong>Stat cards</strong> at the top show aggregate run counts by
        status: Pending, Running, Completed, Failed, and Cancelled. These
        update in real time over the WebSocket connection.
      </p>
      <p>
        <strong>Recent Failures</strong> lists the most recent failed runs with
        status, signal name, error message, and timestamp. Click a row to
        navigate to the full run detail.
      </p>
      <p>
        <strong>Live Activity</strong> is a real-time event feed. Every lifecycle
        event flows through here as it happens:
        run dispatched, started, completed, failed, step completions, and log
        output. The green pulse dot in the header indicates an active WebSocket
        connection.
      </p>

      <hr className="divider" />

      {/* ── Signals ── */}

      <h3>Signals</h3>
      <img
        src="/screenshots/signals.png"
        alt="Signals list table showing Name, Kind, Schedule, Timeout, Retries, and Steps columns"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        The Signals page lists every registered signal. Columns:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Name</strong></td>
            <td>The signal identifier passed to <code>signal()</code>.</td>
          </tr>
          <tr>
            <td><strong>Kind</strong></td>
            <td>Whether the signal uses a single <code>.run()</code> handler or multi-step <code>.step()</code> pipeline.</td>
          </tr>
          <tr>
            <td><strong>Schedule</strong></td>
            <td>The recurring interval if set via <code>.every()</code>, otherwise blank.</td>
          </tr>
          <tr>
            <td><strong>Timeout</strong></td>
            <td>Maximum execution time before the run is killed.</td>
          </tr>
          <tr>
            <td><strong>Retries</strong></td>
            <td>Number of retry attempts after the initial failure.</td>
          </tr>
          <tr>
            <td><strong>Steps</strong></td>
            <td>Number of steps in a multi-step signal. Blank for single-handler signals.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Click any row to open the signal detail page.
      </p>

      <hr className="divider" />

      {/* ── Signal detail ── */}

      <h3>Signal detail</h3>
      <img
        src="/screenshots/inspect-signal.png"
        alt="Signal detail page for build-app showing configuration, schema, trigger form, and run history"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        The signal detail page has four sections.
      </p>
      <p>
        <strong>Configuration</strong> shows the signal&rsquo;s settings at a
        glance: schedule (or &ldquo;Manual trigger&rdquo; if no interval),
        timeout, max attempts, max concurrency, and the list of step names for
        multi-step signals.
      </p>
      <p>
        <strong>Schema</strong> displays the Zod input and output schemas
        rendered as field lists with types. This is generated directly from
        the <code>.input()</code> and <code>.output()</code> definitions in your
        signal file.
      </p>
      <p>
        <strong>Trigger</strong> lets you dispatch the signal manually. The
        form pre-populates fields from the input schema. You can also switch
        to a raw JSON editor for complex payloads. Press Dispatch to enqueue a
        new run.
      </p>
      <p>
        <strong>Run History</strong> at the bottom lists all runs for this
        signal. Use the filter tabs (All, Completed, Failed, Running, Pending)
        to narrow the view.
      </p>

      <hr className="divider" />

      {/* ── Run history ── */}

      <h3>Run history</h3>
      <img
        src="/screenshots/signal-run-history.png"
        alt="Run history table showing status badges, signal name, run ID, duration, created time, and error columns"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        The run history table shows every execution for the current signal.
        Each row displays:
      </p>
      <ul>
        <li>
          <strong>Status</strong> — color-coded badge (green for completed, red
          for failed, yellow for running, gray for pending or cancelled)
        </li>
        <li><strong>Signal</strong> — the signal name</li>
        <li><strong>Run ID</strong> — unique identifier for this execution</li>
        <li><strong>Duration</strong> — wall-clock time from start to finish</li>
        <li><strong>Created</strong> — when the run was enqueued</li>
        <li><strong>Error</strong> — error message if the run failed</li>
      </ul>
      <p>
        Click any row to open the full run detail with input, output, logs,
        and step records.
      </p>

      <hr className="divider" />

      {/* ── Broadcasts ── */}

      <h3>Broadcasts</h3>
      <img
        src="/screenshots/broadcasts.png"
        alt="Broadcasts list table showing Name, Nodes, Failure Policy, Timeout, and Trigger button"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        The Broadcasts page lists every registered broadcast. Columns:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Name</strong></td>
            <td>The broadcast identifier passed to <code>broadcast()</code>.</td>
          </tr>
          <tr>
            <td><strong>Nodes</strong></td>
            <td>Total number of nodes in the DAG.</td>
          </tr>
          <tr>
            <td><strong>Failure Policy</strong></td>
            <td>How failures propagate: <code>fail-fast</code> (abort on first failure) or <code>continue</code> (run remaining nodes).</td>
          </tr>
          <tr>
            <td><strong>Timeout</strong></td>
            <td>Maximum wall-clock time for the entire broadcast execution.</td>
          </tr>
        </tbody>
      </table>
      <p>
        The green Trigger button dispatches a broadcast run directly from the
        list. Click the row to open the broadcast detail.
      </p>

      <hr className="divider" />

      {/* ── Broadcast detail ── */}

      <h3>Broadcast detail</h3>
      <img
        src="/screenshots/inspect-broadcast.png"
        alt="Broadcast detail for ci-pipeline showing configuration and an interactive DAG visualization with nodes for checkout, lint, test-unit, test-integration, build-app, deploy-staging, deploy-prod, and notify"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        The broadcast detail page shows the full DAG structure.
      </p>
      <p>
        <strong>Configuration</strong> displays the failure policy, timeout, and
        schedule at a glance.
      </p>
      <p>
        <strong>Workflow</strong> renders the DAG as an interactive graph. Each
        node maps to a signal. Arrows represent dependency edges &mdash; a node
        only executes after all its upstream dependencies complete. In the
        example above, <code>checkout</code> must finish
        before <code>lint</code>, <code>test-unit</code>,
        and <code>test-integration</code> can start in parallel.
        Then <code>build-app</code> waits for all three before continuing
        the pipeline through deployment and notification.
      </p>

      <hr className="divider" />

      {/* ── Broadcast run ── */}

      <h3>Broadcast run</h3>
      <img
        src="/screenshots/broadcast-history.png"
        alt="Broadcast run detail showing a live DAG with colored nodes and durations, a nodes sidebar, and a detail panel with logs for the checkout node"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        When a broadcast executes, the run detail page provides a live view of
        the DAG.
      </p>
      <p>
        <strong>Live DAG</strong> at the top colors each node by status: green
        for completed, red for failed, yellow for running, gray for pending or
        skipped. Duration labels appear on finished nodes.
      </p>
      <p>
        <strong>Nodes sidebar</strong> on the left lists every node with a
        status dot and duration. Click a node to inspect it.
      </p>
      <p>
        <strong>Detail panel</strong> on the right shows the selected
        node&rsquo;s status, duration, and captured logs with timestamps and log
        levels. Collapsible Input and Output sections display the data passed
        into and returned from the node&rsquo;s signal handler. The &ldquo;View
        signal run &rarr;&rdquo; link at the bottom navigates to the
        underlying signal run for full run-level detail.
      </p>

      <hr className="divider" />

      {/* ── Debugging errors ── */}

      <h3>Debugging errors</h3>
      <img
        src="/screenshots/view-error-logs.png"
        alt="Error inspection showing a DAG with a failed node highlighted, and a detail panel displaying the full error JSON with validation errors"
        style={{ width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" }}
      />
      <p>
        Failed nodes are highlighted in the DAG. Click one to open its detail
        panel.
      </p>
      <p>
        The panel shows the full error output, including structured error
        objects. In the example above, a Zod validation error shows exactly
        which fields failed and why &mdash; &ldquo;expected string, received
        undefined&rdquo; for each missing input field. This makes it
        straightforward to trace the root cause without leaving the dashboard.
      </p>
      <p>
        From any failed node, use the &ldquo;View signal run &rarr;&rdquo; link
        to jump to the signal run detail page for step-level records, full
        input/output, and retry history.
      </p>

      <hr className="divider" />

      {/* ── Configuration reference ── */}

      <h3>Configuration reference</h3>
      <p>
        Key options for <code>station.config.ts</code>:
      </p>
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
            <td>API server port. Dashboard UI runs on <code>port + 1</code>.</td>
          </tr>
          <tr>
            <td><code>signalsDir</code></td>
            <td><code>string</code></td>
            <td>&mdash;</td>
            <td>Path to signal definition files.</td>
          </tr>
          <tr>
            <td><code>broadcastsDir</code></td>
            <td><code>string</code></td>
            <td>&mdash;</td>
            <td>Path to broadcast definition files.</td>
          </tr>
          <tr>
            <td><code>adapter</code></td>
            <td><code>SignalQueueAdapter</code></td>
            <td><code>MemoryAdapter</code></td>
            <td>Signal storage adapter. Must match your runner&rsquo;s adapter.</td>
          </tr>
          <tr>
            <td><code>broadcastAdapter</code></td>
            <td><code>BroadcastQueueAdapter</code></td>
            <td>&mdash;</td>
            <td>Broadcast storage adapter.</td>
          </tr>
          <tr>
            <td><code>auth</code></td>
            <td><code>{`{ username, password }`}</code></td>
            <td>&mdash;</td>
            <td>Dashboard login credentials. Omit to disable auth.</td>
          </tr>
          <tr>
            <td><code>runRunners</code></td>
            <td><code>boolean</code></td>
            <td><code>true</code></td>
            <td>
              Run signal and broadcast runners internally. Set
              to <code>false</code> for read-only monitoring.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        See the{" "}
        <Link href="/docs/station">Station Kit API reference</Link> for the
        complete list of options, API endpoints, and WebSocket events.
      </p>
    </>
  );
}
