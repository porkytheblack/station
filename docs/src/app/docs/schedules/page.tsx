import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Schedules — Station",
};

export default function SchedulesPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Schedules</h2>
      <p>
        Schedules let you fire signals or broadcasts at runtime-defined
        intervals without redeploying. They&apos;re stored in the same
        adapter as your runs and reconciled on every poll tick. Operators can
        add, edit, pause and remove them through the dashboard or the v1 API.
      </p>
      <p>
        File-defined <code>.every()</code> schedules in{" "}
        <Link href="/docs/signals">signal</Link> and{" "}
        <Link href="/docs/broadcasts">broadcast</Link> definitions are
        unchanged. Runtime schedules live alongside them in the same store; the
        two systems are additive, not exclusive.
      </p>

      <hr className="divider" />

      {/* ── The three kinds ── */}

      <h3>The three kinds</h3>
      <p>
        A schedule&apos;s <code>kind</code> says what it fires:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Target</th>
            <th>Triggers</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>signal</code></td>
            <td>Signal name</td>
            <td>The signal runner picks it up and dispatches a normal run.</td>
          </tr>
          <tr>
            <td><code>broadcast-static</code></td>
            <td>File-defined broadcast name</td>
            <td>The broadcast runner triggers the registered DAG.</td>
          </tr>
          <tr>
            <td><code>broadcast-dynamic</code></td>
            <td><Link href="/docs/dynamic-broadcasts">Dynamic broadcast</Link> name</td>
            <td>
              The broadcast runner snapshots the current spec and triggers it,
              same as a manual trigger.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Each schedule carries an optional <code>input</code> that&apos;s passed
        to the target on every fire. For signals it&apos;s the signal&apos;s
        input; for broadcasts it&apos;s the trigger input handed to the entry
        node.
      </p>

      <hr className="divider" />

      {/* ── Schedule shape ── */}

      <h3>The Schedule record</h3>
      <Code>{`interface Schedule {
  id: string;
  kind: "signal" | "broadcast-static" | "broadcast-dynamic";
  /** Signal or broadcast name. */
  target: string;
  /** Interval string, e.g. "5m", "1h", "100ms". */
  interval: string;
  /** JSON-serialisable payload sent to the target on each fire. */
  input?: unknown;
  enabled: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastRunStatus?: string;
  lastRunId?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;
}`}</Code>

      <hr className="divider" />

      {/* ── Interval grammar ── */}

      <h3>Interval grammar</h3>
      <p>
        Intervals are the same human-readable strings used by signal{" "}
        <code>.every()</code>: a positive integer plus a unit suffix. Both the
        client-side preview helper and the server-side <code>parseInterval</code>{" "}
        accept all of these:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Suffix</th>
            <th>Unit</th>
            <th>Example</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>ms</code></td><td>milliseconds</td><td><code>&quot;100ms&quot;</code></td></tr>
          <tr><td><code>s</code></td><td>seconds</td><td><code>&quot;30s&quot;</code></td></tr>
          <tr><td><code>m</code></td><td>minutes</td><td><code>&quot;5m&quot;</code></td></tr>
          <tr><td><code>h</code></td><td>hours</td><td><code>&quot;1h&quot;</code></td></tr>
          <tr><td><code>d</code></td><td>days</td><td><code>&quot;1d&quot;</code></td></tr>
          <tr><td><code>w</code></td><td>weeks</td><td><code>&quot;1w&quot;</code></td></tr>
        </tbody>
      </table>
      <p>
        Intervals are absolute durations from the previous fire — there is no
        cron expression support. If you need calendar-aware scheduling (&quot;the
        first business day of the month&quot;), implement it as a signal that
        runs frequently and short-circuits when the calendar isn&apos;t right.
      </p>

      <hr className="divider" />

      {/* ── HTTP API ── */}

      <h3>HTTP API</h3>
      <p>
        Schedules live under <code>/api/v1/schedules</code>. Auth is the same
        API key flow used elsewhere on the v1 surface.
      </p>

      <h4>Create</h4>
      <Code>{`curl -X POST http://localhost:4400/api/v1/schedules \\
  -H "Authorization: Bearer $STATION_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "kind": "signal",
    "target": "syncInventory",
    "interval": "15m",
    "input": { "warehouseId": "WH-1" },
    "enabled": true
  }'`}</Code>

      <h4>List, edit, delete</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>GET /api/v1/schedules</code></td>
            <td>
              List schedules. Query params: <code>?kind=...</code>,{" "}
              <code>?enabled=true|false</code>, <code>?due=true</code>.
            </td>
          </tr>
          <tr>
            <td><code>GET /api/v1/schedules/:id</code></td>
            <td>Single schedule by ID.</td>
          </tr>
          <tr>
            <td><code>PATCH /api/v1/schedules/:id</code></td>
            <td>
              Partial update. Fields you can change: <code>interval</code>,{" "}
              <code>input</code>, <code>enabled</code>, <code>nextRunAt</code>.
              Identity fields (<code>kind</code>, <code>target</code>,{" "}
              <code>createdAt</code>) are immutable.
            </td>
          </tr>
          <tr>
            <td><code>DELETE /api/v1/schedules/:id</code></td>
            <td>Remove a schedule. Hard delete; runs already triggered are unaffected.</td>
          </tr>
        </tbody>
      </table>

      <h4>Preview the next fires</h4>
      <Code>{`curl -X POST http://localhost:4400/api/v1/schedules/sched_abc/preview \\
  -H "Authorization: Bearer $STATION_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "n": 5 }'

// → { "fires": ["2026-05-02T15:00:00.000Z", "2026-05-02T15:15:00.000Z", ...] }`}</Code>
      <p>
        Useful for the dashboard&apos;s &quot;next runs&quot; list and for
        testing interval changes without waiting for the reconciler to fire.
      </p>

      <hr className="divider" />

      {/* ── Adapter and reconciler ── */}

      <h3>Adapter requirements</h3>
      <p>
        Schedule storage is a separate{" "}
        <code>ScheduleAdapter</code>, not the broadcast or signal queue
        adapter. It ships per backend in a sub-path of the corresponding
        adapter package:
      </p>
      <ul>
        <li><code>station-adapter-sqlite/schedules</code></li>
        <li><code>station-adapter-postgres/schedules</code></li>
        <li><code>station-adapter-mysql/schedules</code></li>
        <li><code>station-adapter-redis/schedules</code></li>
      </ul>
      <p>
        For tests, <code>ScheduleMemoryAdapter</code> ships in{" "}
        <code>station-schedules</code> itself.
      </p>

      <h4>The interface</h4>
      <Code>{`interface ScheduleAdapter {
  add(schedule: Schedule): Promise<void>;
  get(id: string): Promise<Schedule | null>;
  list(filter?: { kind?: ScheduleKind; enabled?: boolean; due?: boolean }): Promise<Schedule[]>;
  update(id: string, patch: SchedulePatch): Promise<void>;
  delete(id: string): Promise<boolean>;

  /**
   * Atomically advance nextRunAt only if the stored value still matches
   * expectedNextRunAt. Required for multi-instance correctness.
   */
  claimDue?(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean>;

  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}`}</Code>

      <div className="warn-box">
        <code>claimDue</code> is technically optional, but adapters that
        don&apos;t implement it fall back to a non-atomic advance and emit a
        warning. That&apos;s fine for single-process development; in any
        multi-runner deployment you can end up firing the same schedule twice.
        All four built-in backends implement it.
      </div>

      <h4>How each backend makes the claim atomic</h4>
      <ul>
        <li>
          <strong>SQLite</strong> —{" "}
          <code>UPDATE ... WHERE next_run_at = ?</code>; the single-writer DB
          serialises.
        </li>
        <li>
          <strong>Postgres</strong> — <code>UPDATE ... RETURNING id</code> in a
          single statement, atomic across connections.
        </li>
        <li>
          <strong>MySQL</strong> — <code>UPDATE ... WHERE ...</code> with{" "}
          <code>affectedRows &gt; 0</code> deciding the winner.
        </li>
        <li>
          <strong>Redis</strong> — Lua <code>EVAL</code> script that compares{" "}
          <code>ZSCORE</code> against the expected value before updating.
        </li>
      </ul>

      <hr className="divider" />

      {/* ── ScheduleReconciler ── */}

      <h3>The reconciler</h3>
      <p>
        The signal runner and broadcast runner each own a{" "}
        <code>ScheduleReconciler</code> tied to the kinds they handle. On every
        tick it:
      </p>
      <ol>
        <li>
          Lists schedules with <code>enabled = true</code> and{" "}
          <code>nextRunAt &lt;= now</code>.
        </li>
        <li>
          Calls <code>claimDue(id, currentNextRunAt, newNextRunAt)</code>. If
          another runner already claimed, it bails — at-most-once.
        </li>
        <li>
          Optionally checks for an in-flight run for the same target and
          records <code>lastRunStatus = &quot;skipped:overlap&quot;</code> rather
          than firing.
        </li>
        <li>Triggers the target.</li>
        <li>
          Records <code>lastRunAt</code>, <code>lastRunId</code>, and{" "}
          <code>lastRunStatus</code> (<code>&quot;triggered&quot;</code> or{" "}
          <code>&quot;errored&quot;</code>).
        </li>
      </ol>
      <p>
        If the trigger throws, the schedule&apos;s <code>nextRunAt</code> still
        advances (the claim already moved it forward) and the error is recorded
        on the row. A schedule can never busy-loop on a recurring failure.
      </p>

      <hr className="divider" />

      {/* ── File schedules vs runtime ── */}

      <h3>File schedules vs runtime schedules</h3>
      <p>
        A signal&apos;s <code>.every(&quot;5m&quot;)</code> and a broadcast&apos;s{" "}
        <code>.every(&quot;1h&quot;)</code> are still the right tool when the
        cadence is part of your code: it lives in version control, it&apos;s
        reviewed in PRs, and it deploys with the application. They&apos;re
        managed by the runner&apos;s own scheduling fields on the run record;
        they don&apos;t use the schedule adapter at all.
      </p>
      <p>
        Reach for a runtime schedule when the cadence belongs to operations:
        you want it pause-able, edit-able and visible in the dashboard without
        a redeploy. The two are designed to coexist on the same target — you
        can have a file-defined hourly broadcast and a runtime schedule that
        also fires it ad-hoc; both go through the runner&apos;s overlap
        protection so you won&apos;t end up with two concurrent runs.
      </p>
    </>
  );
}
