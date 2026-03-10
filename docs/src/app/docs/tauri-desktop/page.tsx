import { Metadata } from "next";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Tauri Desktop — Station",
};

export default function TauriDesktopPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Tauri Desktop</h2>
      <p>
        The <code>station-tauri</code> package lets you run Station as a Tauri v2
        desktop app sidecar. Your Tauri app spawns Station as a background
        process, communicates over localhost HTTP, and shuts it down when the
        window closes. No server deployment needed — everything runs on the
        user&rsquo;s machine.
      </p>

      <hr className="divider" />

      {/* ── Install ── */}

      <h3>Install</h3>
      <Code>{`npm install station-tauri`}</Code>

      <hr className="divider" />

      {/* ── Programmatic API ── */}

      <h3>Programmatic API</h3>
      <p>
        Use <code>createTauriStation</code> to start Station from Node.js code
        (e.g. an Electron main process, a test harness, or a custom launcher).
      </p>
      <Code>{`import { createTauriStation } from "station-tauri";

const station = await createTauriStation({
  dataDir: "/path/to/app/data",  // absolute path — Tauri app data directory
  port: 4400,                     // optional, default 4400
  signalsDir: "./signals",        // path to signal definitions
  broadcastsDir: "./broadcasts",  // optional
  station: { /* overrides */ },   // optional partial StationUserConfig
});

await station.start();

console.log(station.port);    // 4400
console.log(station.apiKey);  // "sk_live_..."

await station.stop();`}</Code>

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
            <td><code>dataDir</code></td>
            <td><code>string</code></td>
            <td>&mdash;</td>
            <td>
              Absolute path to the application data directory. The SQLite
              database and API key file are stored here. In Tauri, use
              the <code>appDataDir</code> resolver.
            </td>
          </tr>
          <tr>
            <td><code>port</code></td>
            <td><code>number</code></td>
            <td><code>4400</code></td>
            <td>Port for the Station API server. Binds to 127.0.0.1 only.</td>
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
            <td><code>station</code></td>
            <td><code>Partial&lt;StationUserConfig&gt;</code></td>
            <td>&mdash;</td>
            <td>
              Optional overrides for the underlying Station configuration
              (adapters, auth, runner options, etc.).
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Return value</h4>
      <p>
        <code>createTauriStation</code> returns a station handle with
        these properties and methods:
      </p>
      <table className="api-table">
        <thead>
          <tr>
            <th>Property / Method</th>
            <th>Type</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>port</code></td>
            <td><code>number</code></td>
            <td>The port Station is listening on.</td>
          </tr>
          <tr>
            <td><code>apiKey</code></td>
            <td><code>string</code></td>
            <td>
              Auto-provisioned API key (<code>sk_live_...</code>) with all
              scopes.
            </td>
          </tr>
          <tr>
            <td><code>start()</code></td>
            <td><code>Promise&lt;void&gt;</code></td>
            <td>Start the Station server and runners.</td>
          </tr>
          <tr>
            <td><code>stop()</code></td>
            <td><code>Promise&lt;void&gt;</code></td>
            <td>Gracefully shut down the server and runners.</td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── Sidecar binary ── */}

      <h3>Sidecar binary</h3>
      <p>
        The package ships a <code>station-sidecar</code> binary designed for use
        as a Tauri v2 sidecar. Register it
        in <code>tauri.conf.json</code> and spawn it on app start. The binary
        communicates readiness and errors via structured JSON on stdout.
      </p>

      <h4>Environment variables</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Variable</th>
            <th>Required</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>STATION_DATA_DIR</code></td>
            <td>Yes</td>
            <td>&mdash;</td>
            <td>Absolute path to the data directory.</td>
          </tr>
          <tr>
            <td><code>STATION_PORT</code></td>
            <td>No</td>
            <td><code>4400</code></td>
            <td>API server port.</td>
          </tr>
          <tr>
            <td><code>STATION_SIGNALS_DIR</code></td>
            <td>No</td>
            <td><code>./signals</code></td>
            <td>Path to signal definitions.</td>
          </tr>
          <tr>
            <td><code>STATION_BROADCASTS_DIR</code></td>
            <td>No</td>
            <td>&mdash;</td>
            <td>Path to broadcast definitions.</td>
          </tr>
        </tbody>
      </table>

      <h4>Stdout protocol</h4>
      <p>
        On successful startup, the binary writes a single JSON line to stdout:
      </p>
      <Code>{`{"event":"ready","port":4400,"apiKey":"sk_live_..."}`}</Code>
      <p>On failure:</p>
      <Code>{`{"event":"error","message":"STATION_DATA_DIR is required"}`}</Code>
      <p>
        The binary handles <code>SIGTERM</code> and <code>SIGINT</code> for
        graceful shutdown — runners and adapters are stopped cleanly before the
        process exits.
      </p>

      <hr className="divider" />

      {/* ── Auth ── */}

      <h3>Authentication</h3>
      <p>
        The desktop integration auto-provisions a single API key with all
        scopes (<code>trigger</code>, <code>read</code>, <code>cancel</code>,{" "}
        <code>admin</code>) on first launch. The key is persisted
        to <code>{`{dataDir}/.station-key`}</code> and reused on subsequent
        launches.
      </p>
      <p>
        No login UI is needed. The Tauri frontend
        uses the API key directly in HTTP headers:
      </p>
      <Code>{`fetch("http://127.0.0.1:4400/api/v1/signals", {
  headers: {
    Authorization: "Bearer sk_live_...",
  },
});`}</Code>
      <p>
        The server binds to <code>127.0.0.1</code> only — it is not accessible
        from other machines on the network.
      </p>

      <hr className="divider" />

      {/* ── Tauri v2 integration ── */}

      <h3>Tauri v2 integration</h3>
      <p>
        The typical integration pattern involves three pieces: registering the
        sidecar in Tauri config, spawning it from Rust on app start, and
        calling the API from the frontend.
      </p>

      <h4>1. Register the sidecar</h4>
      <p>
        Add the <code>station-sidecar</code> binary to
        your <code>tauri.conf.json</code> external binaries list. Tauri
        resolves sidecar paths relative to your app bundle.
      </p>

      <h4>2. Spawn on app start</h4>
      <p>
        In your Rust setup, spawn the sidecar process, set the required
        environment variables, and read stdout for the ready event:
      </p>
      <Code>{`// Pseudocode — Rust side
// 1. Spawn the station-sidecar with STATION_DATA_DIR set to appDataDir
// 2. Read stdout line-by-line until {"event":"ready",...}
// 3. Extract port and apiKey from the JSON
// 4. Pass port + apiKey to the frontend via Tauri state or IPC`}</Code>

      <h4>3. Call the API from the frontend</h4>
      <p>
        The Tauri frontend talks to Station over localhost using the port and
        API key extracted from the ready event:
      </p>
      <Code>{`// Frontend (TypeScript)
const response = await fetch(\`http://127.0.0.1:\${port}/api/v1/signals\`, {
  headers: { Authorization: \`Bearer \${apiKey}\` },
});
const signals = await response.json();`}</Code>

      <h4>4. Shut down on app close</h4>
      <p>
        When the Tauri window closes, kill the sidecar process. The binary
        intercepts <code>SIGTERM</code> and shuts down gracefully — flushing
        the database WAL, stopping runners, and closing adapter connections
        before exiting.
      </p>
    </>
  );
}
