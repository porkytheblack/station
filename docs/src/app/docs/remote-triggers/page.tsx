import { Code } from "../../components/Code";

export const metadata = { title: "Remote Triggers — Station" };

export default function RemoteTriggersPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Remote triggers</h2>
      <p>
        Remote triggers let you dispatch signals and broadcasts from any
        application to a Station server over HTTP. Your application code calls{" "}
        <code>.trigger()</code> as usual, but execution happens on the Station
        server instead of locally.
      </p>

      <hr className="divider" />

      {/* ── How it works ── */}

      <h3>How it works</h3>
      <p>
        When you call <code>configure()</code> with a remote endpoint, Station
        creates an <code>HttpTriggerAdapter</code> internally. Every subsequent{" "}
        <code>.trigger()</code> call sends an HTTP POST to the Station server's
        v1 API instead of writing to a local adapter.
      </p>
      <ol>
        <li>
          Client validates input against the signal's Zod schema locally
        </li>
        <li>
          Client sends <code>POST /api/v1/trigger</code> with the signal name
          and input
        </li>
        <li>
          Server authenticates the request via API key, creates a pending run,
          and returns the run ID
        </li>
        <li>
          The signal runner on the server picks up the pending run and executes
          it
        </li>
      </ol>

      <hr className="divider" />

      {/* ── Server setup ── */}

      <h3>1. Set up the Station server</h3>
      <p>
        Your Station server needs an adapter for persistence, auth for API key
        management, and <code>host: "0.0.0.0"</code> to accept remote
        connections.
      </p>
      <Code>{`// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";

export default defineConfig({
  port: 4400,
  host: "0.0.0.0",
  signalsDir: "./signals",
  adapter: new SqliteAdapter({ dbPath: "./.station/data/jobs.db" }),
  auth: {
    username: "admin",
    password: "changeme",
  },
});`}</Code>
      <p>
        Start the server with <code>npx station</code>. The dashboard will be
        available at <code>http://localhost:4400</code>.
      </p>

      <hr className="divider" />

      {/* ── API keys ── */}

      <h3>2. Create an API key</h3>
      <p>
        API keys authenticate remote trigger requests. Create one from the
        dashboard Settings page, or via the v1 API:
      </p>
      <Code>{`curl -X POST http://localhost:4400/api/v1/keys \\
  -H "Authorization: Bearer <session-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "my-app", "scopes": ["trigger", "read"]}'`}</Code>
      <p>
        The response includes the full key (prefixed <code>sk_live_</code>).
        Store it securely — the key is only shown once.
      </p>
      <div className="info-box">
        <p>
          API keys support scoped access: <code>trigger</code> (dispatch
          jobs), <code>read</code> (view runs and status), <code>cancel</code>{" "}
          (cancel running jobs), and <code>admin</code> (manage keys).
        </p>
      </div>

      <hr className="divider" />

      {/* ── Client setup ── */}

      <h3>3. Configure the client</h3>
      <p>
        In your application, call <code>configure()</code> once at startup. All
        subsequent <code>.trigger()</code> calls will go to the remote server.
      </p>

      <h4>Option A: Explicit configuration</h4>
      <Code>{`import { configure } from "station-signal";

configure({
  endpoint: "https://station.example.com",
  apiKey: "sk_live_abc123...",
});`}</Code>

      <h4>Option B: Environment variables</h4>
      <p>
        Station auto-detects these environment variables. No code changes needed.
      </p>
      <Code>{`STATION_ENDPOINT=https://station.example.com
STATION_API_KEY=sk_live_abc123...`}</Code>

      <hr className="divider" />

      {/* ── Triggering ── */}

      <h3>4. Trigger signals remotely</h3>
      <p>
        Once configured, <code>.trigger()</code> works the same as local
        triggering. The call returns a run ID immediately.
      </p>
      <Code>{`import { sendEmail } from "./signals/send-email.js";

// This sends an HTTP POST to your Station server
const runId = await sendEmail.trigger({
  to: "user@example.com",
  subject: "Welcome",
  body: "Thanks for signing up.",
});

console.log("Dispatched run:", runId);`}</Code>
      <p>
        Broadcasts work the same way:
      </p>
      <Code>{`import { orderPipeline } from "./broadcasts/order-pipeline.js";

const runId = await orderPipeline.trigger({
  orderId: "ord_123",
  amount: 99.99,
});`}</Code>

      <hr className="divider" />

      {/* ── Deployment ── */}

      <h3>Deployment</h3>
      <p>
        Station includes a <code>deploy</code> command that generates
        deployment files for your server:
      </p>
      <Code>{`npx station deploy`}</Code>
      <p>
        This writes a <code>Dockerfile</code> and <code>nixpacks.toml</code>{" "}
        to <code>.station/out/</code>. Copy the appropriate file to your
        project root and deploy to any container platform (Railway, Render,
        Fly.io, AWS ECS, etc.).
      </p>

      <hr className="divider" />

      {/* ── CLI reference ── */}

      <h3>CLI reference</h3>
      <table className="api-table">
        <thead>
          <tr>
            <th>Flag</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>--port &lt;n&gt;</code></td>
            <td>Override server port (default: 4400)</td>
          </tr>
          <tr>
            <td><code>--host &lt;s&gt;</code></td>
            <td>Override server host (default: localhost)</td>
          </tr>
          <tr>
            <td><code>--dir &lt;path&gt;</code></td>
            <td>Set station directory for generated files (default: .station)</td>
          </tr>
          <tr>
            <td><code>--config &lt;path&gt;</code></td>
            <td>Path to config file (default: station.config.ts)</td>
          </tr>
          <tr>
            <td><code>--no-open</code></td>
            <td>Don't open browser on start</td>
          </tr>
          <tr>
            <td><code>--no-runners</code></td>
            <td>Read-only mode — don't execute signals or broadcasts</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
