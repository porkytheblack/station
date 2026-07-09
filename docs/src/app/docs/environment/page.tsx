import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Environment Variables — Station",
};

export default function EnvironmentPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Environment Variables</h2>
      <p>
        Environment variables let you feed configuration and secrets into your{" "}
        <Link href="/docs/signals">signals</Link> and{" "}
        <Link href="/docs/beacons">beacons</Link> without exporting everything
        into the Station process. Define a variable once — globally or scoped to
        specific targets — require it for a run, and change it from the dashboard
        while Station is running. It&apos;s the same mental model as Vercel&apos;s
        environments.
      </p>
      <p>
        Variables live in a pluggable store and are injected into each run&apos;s{" "}
        <code>process.env</code> over the private IPC channel — never the spawn
        environment — so secret values are not exposed via{" "}
        <code>/proc/&lt;pid&gt;/environ</code> to other processes on the host.
      </p>

      <hr className="divider" />

      {/* ── Requiring a variable ── */}

      <h3>Requiring a variable</h3>
      <p>
        Declare what a signal or beacon needs with <code>.env()</code>. Before a
        run is dispatched, the runner checks each key against the env store{" "}
        <em>and</em> the host <code>process.env</code>. If a key is missing, a
        signal run <strong>fails fast</strong> with a clear error and a beacon is
        marked <code>errored</code> instead of being spawned — no wasted child
        process, no half-configured run.
      </p>
      <Code>{`import { signal, z } from "station-signal";

export const charge = signal("charge")
  .input(z.object({ amount: z.number() }))
  .env("STRIPE_API_KEY")            // required — the run fails fast if unset
  .run(async (input) => {
    const stripe = new Stripe(process.env.STRIPE_API_KEY!);
    await stripe.charges.create({ amount: input.amount });
  });`}</Code>
      <p>
        Beacons take the same method. A missing required variable keeps the
        beacon down (<code>errored</code>) rather than crash-looping; defining
        the variable and restarting it clears the error.
      </p>
      <Code>{`import { beacon } from "station-beacon";

export const priceFeed = beacon("price-feed")
  .env("EXCHANGE_API_KEY")
  .restart("always")
  .run(async (ctx) => { /* ... */ });`}</Code>

      <div className="warn-box">
        A run failed for a missing variable is terminal — it is not retried,
        because retrying without the value can&apos;t succeed. Define the
        variable, then trigger again. If the env store is briefly{" "}
        <em>unreachable</em> (a database blip), the run is left pending and
        retried instead of being failed with a misleading &quot;not
        defined&quot; error.
      </div>

      <hr className="divider" />

      {/* ── Scoping ── */}

      <h3>Global vs. scoped</h3>
      <p>
        A variable with no targets is <strong>global</strong> — injected into
        every signal and beacon run. A variable scoped to specific targets is
        injected only into those, and <strong>overrides</strong> a global
        variable of the same key. This is how you keep one default and specialise
        it for a single job:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Definition</th>
            <th>Applies to</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>DB_URL</code> (no targets)</td>
            <td>Every signal and beacon.</td>
          </tr>
          <tr>
            <td><code>DB_URL</code> scoped to signal <code>reports</code></td>
            <td>Only <code>reports</code> — and it wins over the global <code>DB_URL</code> there.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Two variables may share a key only if their scopes can never both apply
        to one target, so resolution is always deterministic. The store rejects a
        definition that would make a key ambiguous.
      </p>

      <hr className="divider" />

      {/* ── Secrets ── */}

      <h3>Secrets</h3>
      <p>
        Mark a variable <code>secret</code> and its value becomes write-only: the
        API and dashboard return <code>value: null</code>, and the real value is
        still injected at run time. A secret can&apos;t be downgraded to
        non-secret — once hidden, it stays hidden. Rotating a secret is a normal
        value edit; the stored scope and secret flag are preserved.
      </p>

      <div className="warn-box">
        A handful of keys are reserved and rejected: <code>PATH</code>,{" "}
        <code>NODE_OPTIONS</code>, <code>NODE_PATH</code>,{" "}
        <code>LD_PRELOAD</code>, <code>LD_LIBRARY_PATH</code>, the{" "}
        <code>DYLD_*</code> loader variables, and any <code>STATION_*</code> /{" "}
        <code>__STATION</code> internal. They change how the child process
        executes rather than what your handler reads, so managing them through
        the store is disallowed — and the runner re-checks them at the child
        boundary as defense-in-depth.
      </div>

      <hr className="divider" />

      {/* ── Storage ── */}

      <h3>Storage</h3>
      <p>
        Variables live behind an <code>EnvStorageAdapter</code>. The default is a
        JSON file at <code>&lt;dataDir&gt;/station-env.json</code> (fsync&apos;d,{" "}
        <code>0o600</code>, no native dependencies) — fine for a single-process
        deployment. For multi-process or multi-replica setups, pass a durable
        adapter via <code>envStorage</code>. Each ships in the <code>/env</code>{" "}
        sub-path of the corresponding adapter package:
      </p>
      <ul>
        <li><code>station-adapter-sqlite/env</code></li>
        <li><code>station-adapter-postgres/env</code></li>
        <li><code>station-adapter-mysql/env</code></li>
        <li><code>station-adapter-redis/env</code></li>
      </ul>
      <Code>{`// station.config.ts
import { defineConfig } from "station-kit";
import { EnvPostgresAdapter } from "station-adapter-postgres/env";

export default defineConfig({
  signalsDir: "./signals",
  envStorage: new EnvPostgresAdapter({ connectionString: process.env.DATABASE_URL }),
});`}</Code>
      <p>
        For tests, <code>MemoryEnvStorage</code> ships in{" "}
        <code>station-env</code> itself, alongside the <code>EnvStore</code> that
        wraps any adapter with validation, secret masking, and resolution.
      </p>

      <hr className="divider" />

      {/* ── HTTP API ── */}

      <h3>HTTP API</h3>
      <p>
        Variables live under <code>/api/v1/env</code>. Reads require the{" "}
        <code>read</code> scope and redact secret values; mutations require{" "}
        <code>admin</code>.
      </p>

      <h4>Create</h4>
      <Code>{`# Global secret — injected into every signal and beacon.
curl -X POST http://localhost:4400/api/v1/env \\
  -H "Authorization: Bearer $STATION_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "key": "STRIPE_API_KEY", "value": "sk_live_...", "secret": true }'

# Scoped to a single signal — overrides a global of the same key there.
curl -X POST http://localhost:4400/api/v1/env \\
  -H "Authorization: Bearer $STATION_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "key": "DB_URL",
    "value": "postgres://...",
    "targets": [{ "kind": "signal", "name": "charge" }]
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
            <td><code>GET /api/v1/env</code></td>
            <td>List variables. Secret values come back as <code>null</code>.</td>
          </tr>
          <tr>
            <td><code>GET /api/v1/env/:id</code></td>
            <td>Single variable by ID (secret redacted).</td>
          </tr>
          <tr>
            <td><code>POST /api/v1/env</code></td>
            <td>
              Create. Body: <code>key</code>, <code>value</code>,{" "}
              <code>secret?</code>, <code>targets?</code>. Rejects invalid or
              reserved keys and conflicting scopes with a <code>400</code>.
            </td>
          </tr>
          <tr>
            <td><code>PATCH /api/v1/env/:id</code></td>
            <td>
              Partial update: <code>value</code>, <code>secret</code>,{" "}
              <code>targets</code>. The <code>key</code> is immutable. Omitted
              fields are left unchanged.
            </td>
          </tr>
          <tr>
            <td><code>DELETE /api/v1/env/:id</code></td>
            <td>Remove a variable. Runs already dispatched are unaffected.</td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Dashboard ── */}

      <h3>Dashboard</h3>
      <p>
        The <strong>Environment</strong> page lists every variable, lets you add
        one (choosing <em>Global</em> or specific targets and toggling{" "}
        <em>Secret</em>), edit a value in place, and delete. It also flags any
        variable a signal or beacon requires via <code>.env()</code> that
        isn&apos;t defined in the store — so you can see a missing configuration
        before a run fails. A value set in the Station host environment also
        satisfies a requirement; the dashboard can only see the store, so it says
        so.
      </p>
      <p>
        Changes take effect on the next run — there is no need to restart the
        Station process.
      </p>
    </>
  );
}
