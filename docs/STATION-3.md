# Station 3.0: daemon, clients and compiled images

Station 3.0 replaces the combined StationKit process with a headless daemon and independently operated clients. `station-kit` is removed from the maintained workspace and release inventory. There is no compatibility facade, forwarding executable or transition release. Previously published 2.x packages remain available; they are not part of the new runtime architecture.

This document describes implemented behavior. The broader [Station Images design](plans/station-images.md) also contains unimplemented acceptance targets; the [image operations guide](STATION-IMAGES.md) identifies the current boundaries.

## Package boundaries

| Package | Owns | Executable |
| --- | --- | --- |
| `station-daemon` | Configuration, runners, storage integration, authentication, network coordination, registry and HTTP/event APIs | `stationd` |
| `station-runtime-cli` | Saved connections, API operations, read-only terminal UI and optional local process management | `station` |
| `station-dashboard` | Standalone web interface and its fixed-target API/event proxy | `station-dashboard` |
| `station-client` | Typed connection/protocol contracts and authenticated HTTP/SSE transport | — |
| `station-images` | Immutable manifests/blobs, process protocol, target validation and execution backends | — |

The daemon has no Next.js or React dependency. It starts neither the dashboard nor a browser. The dashboard has no daemon dependency and owns no scheduler or execution worker. Closing the CLI/TUI or stopping the dashboard leaves the daemon and its workloads running. Stopping the daemon makes an independently running dashboard unavailable until the daemon returns.

Use Node 22 or later for the complete CLI/dashboard toolchain. Runtime selection for application jobs—Node or Bun—is separate from the CLI and from the container/host execution backend.

## Run a local application

Install the daemon and the primitives your application uses. Install clients only when needed:

```sh
pnpm add station-daemon station-signal station-adapter-sqlite
pnpm add -D station-runtime-cli station-dashboard
```

```ts
// station.config.ts
import { defineConfig } from "station-daemon";
import { SqliteAdapter } from "station-adapter-sqlite";

export default defineConfig({
  signalsDir: "./signals",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  host: "127.0.0.1",
  port: 4400,
  auth: {
    username: "operator",
    password: process.env.STATION_AUTH_PASSWORD!,
  },
});
```

Set `STATION_AUTH_PASSWORD` through your normal local credential mechanism before starting this example. Do not commit its value. Foreground daemon startup is intended for terminals, containers and service managers:

```sh
pnpm exec stationd --config ./station.config.ts
```

Start the dashboard separately in another terminal:

```sh
STATION_DAEMON_URL=http://127.0.0.1:4400 PORT=4401 HOSTNAME=127.0.0.1 pnpm exec station-dashboard
```

Open `http://127.0.0.1:4401` and log in with the daemon credentials. Port 4400 is the API; it no longer serves the dashboard. The API returns an explanatory 404 for web-page requests.

For programmatic embedding:

```ts
import { resolveConfig } from "station-daemon";
import { createStation } from "station-daemon/server";

const daemon = await createStation(resolveConfig({ host: "127.0.0.1", port: 4400 }), process.cwd());
await daemon.start();
// During application shutdown:
await daemon.stop();
```

The embedding example uses the default in-memory runtime and loopback binding. Supply durable adapters and authentication for deployed applications.

## Connect the CLI to a daemon

The CLI uses scoped API keys. Create a key through an authenticated daemon session using `POST /api/v1/keys`, with the scopes the operator needs. Registry endpoints require `admin`; read-only views generally require `read`. Tenant execution credentials use their separate restricted gateway.

```sh
# This command reads the key from stdin; do not put it in a command argument.
station context add production --url https://hq.example.com --token-stdin
station context use production
station context ls
station status
station ps
station signals
station signal run summarize --input @request.json
station tui
```

Contexts are private local files under `~/.station/cli`, with mode 0700 for the directory and 0600 for the credential file. `STATION_CLI_HOME` selects another location. Context listing reports whether a credential exists without returning it. Use `--identity STATION_ID` when adding a context to require that server identity. Use `--tenant` only for the restricted tenant execution gateway; the daemon derives the tenant from the key.

Remote client connections and dashboard daemon targets require HTTPS, including private network addresses; HTTP is allowed only for `localhost`, `127.0.0.1` and `[::1]`. The client checks `station.api/v1`, the 3.x major version and the optional expected identity. It does not retry state-changing requests automatically. A request timeout can occur after acceptance: inspect the resource before retrying.

The TUI provides nested resources and details, paging/filtering, confirmed actions, resize handling and a reconnecting read-only event feed. It preserves bounded replay cursors and never retries mutations. Tenant contexts poll authorized views rather than the global feed. The TUI now nests workspace files, terminals, services and command receipts, plus browser pages, profiles, recordings, diagnostics, recovery checkpoints and artifact receipts. Registry exports and deployment generations/history/rollouts have detail views. Commands and artifact history are limited to receipts observed by this TUI because the APIs expose no global history list. Frame metadata is available in the terminal; visual playback remains in the dashboard. Binary transfers use the explicit CLI helpers. Common credential fields and embedded base64 are redacted, but arbitrary text is not guaranteed secret-free. Explicit CLI commands and the generic JSON API remain available:

```sh
station sandbox stations
station sandbox create --station coding-worker
station sandbox exec WORKSPACE_ID --station coding-worker --command 'git status'
station browser open --station browser-worker
station browser execute SESSION_ID --station browser-worker --json '{"command":{"op":"pages"}}'
station api GET /runs
station api POST /schedules --json @schedule.json
station events
```

Sandbox and Browser Use wrappers expose the daemon's complete method-based JSON surface, including file, service, terminal, profile and recording operations. They preserve the resource's owning worker. Use `sandbox shell` or `sandbox attach` for interactive PTYs with resize and Ctrl-C forwarding; Ctrl-] detaches without closing the remote terminal. Explicit sandbox/browser upload, download and screenshot commands handle binary local files without overwriting existing output. These use the same owner and tenant routing as JSON methods. No VM backend is implemented.

For scripts, `station sandbox exec ID --station OWNER --command "git status" --wait --wait-timeout-ms 300000 --json-errors` waits for the accepted command and prints the final JSON result. Ordinary remote exit codes are preserved; remote timeout maps to 124, cancellation to 130 and interrupted/lost execution to 125. A failed result with no usable exit code maps to 1. Default exec remains asynchronous. The local wait deadline is 300000 ms by default (1–86400000 allowed), starts after the execution receipt, and stops polling without cancelling the remote command; Ctrl-C likewise detaches the waiter. Local timeout/interrupt returns the latest known JSON snapshot, exits 124/130 and reports `wait_timeout`/`wait_interrupted`. Set a remote execution timeout separately using `--json '{"timeoutMs":10000}'`. Global `--json-errors` emits a sanitized `{error:{code,status,message}}` on stderr; transport failures exit 1 and are distinct from the returned remote result. Neither polling failure nor disconnect replays exec or sends cancel.

## Optional detached local management

The same CLI can start separately installed local services:

```sh
station daemon start --instance local --config ./station.config.ts --port 4400
station daemon status --instance local
station daemon logs --instance local

station context add local --url http://127.0.0.1:4400 --token-stdin
station dashboard start --instance local --context local --port 4401
station dashboard status --instance local
station dashboard stop --instance local
station daemon stop --instance local
```

These commands are local lifecycle operations even when the active context points to a remote server. They do not provision remote machines. Ordinary API commands never start a daemon implicitly.

A detached supervisor owns the actual child process and a private authenticated loopback control endpoint. The CLI never kills a PID merely because it appears in a state file. Starts lock the instance and reject conflicting launch settings or occupied ports. Stale/unreachable ownership state fails closed. Logs and status remain available independently of the terminal.

Managed starts explicitly bind loopback. `daemon start --port` defaults to 4400 and overrides the corresponding daemon config value. Run `stationd` directly when a service manager should own process restart or public binding. Local CLI supervision currently requires Unix; Windows can use direct daemon startup. `logs --follow` streams managed-process output. Log rotation, machine provisioning and automatic crash resurrection are not implemented. Authenticated network enrollment is separate from saved contexts. `network invite|join|members|revoke|leave` uses one-use invitations and private worker credentials; fresh daemon admission gates claims/renewals and revocation fences active work. Shared adapters and database credentials remain operator-provisioned. See the Station Images guide for configuration.

Dashboard start checks its selected daemon connection and pins that target URL. It does not copy the CLI key into frontend assets: the dashboard performs its own daemon login. Hosted dashboards require deliberate TLS and access configuration; their proxy target is an operator setting, never a browser-supplied URL.

## Registries and compiled programs

Signals, broadcast planners and beacons can now be published as native executable or bundled JavaScript artifacts, outside Station's TypeScript authoring API. The artifact implements `station.process/v1`; Station owns validation, invocation identity and supervision.

```sh
station images publish ./station-image.json --artifacts-dir ./build
station images inspect acme/tools@1.0.0
station images install acme/tools@1.0.0
station images run acme/tools@1.0.0 resize --input @request.json
```

Registry publication, import and execution are distinct operations. Enable `registry` for storage/API access and `registry.execution` for runtime registration. A worker with a configured Headquarters upstream periodically imports and installs compatible images, verifies blobs and advertises immutable definitions. Shared queues and membership still supply network execution; a registry by itself is not a scheduler.

Registry storage is pluggable through separate metadata and blob adapters. File and memory implementations are included; custom providers implement `RegistryMetadataAdapter` and `RegistryBlobAdapter`. Configure `registry.storage` and an optional private `registry.cacheDir`; image processes receive verified local artifacts rather than provider credentials. PostgreSQL/S3 registry drivers are not bundled.

Operator registry APIs require `admin`; separate tenant registries map registry-only keys to isolated namespaces and read/publish/activate/invoke grants. A fixed dedicated-worker gateway provides image execution and lifecycle routing. It does not provision tenant infrastructure or a general tenant scheduler. The trusted-local backend is explicitly unsafe for untrusted code. The Docker backend has passed five real-engine integration checks for JavaScript/native execution, enforced isolation settings, timeout cleanup and independent expiry reaping on Docker Desktop’s Linux arm64 engine. Other deployment configurations still require validation. This implementation is not a completed public multi-tenant platform.

See [Station Images: authoring and operation](STATION-IMAGES.md) for configuration, protocol, environment grants, Headquarters synchronization, API routes and limitations.

## Upgrade a 2.x application

- Replace `station-kit` imports with `station-daemon`; server APIs move from `station-kit/server` to `station-daemon/server`.
- Remove `open`, `--no-open` and the old third `nextPort` argument to `createStation`. Those coupled-startup options are not retained.
- Replace combined `station` startup with `stationd`. Deployment-file generation currently remains `stationd deploy`.
- Start `station-dashboard` separately. Daemon bind settings no longer configure the dashboard listener.
- Remove old global StationKit installations before installing `station-runtime-cli` globally; both old and new packages claim the `station` executable.
- Update scripts that locate old package paths or Next standalone assets. Prefer supported executables and package exports.
- Preserve configured data directories and durable adapters. Back them up before upgrade. Do not delete persistent state to resolve an interface change.
- Restore image activation state using the same registry/backend/environment-grant configuration. Changed activation configuration is rejected explicitly rather than silently rewriting existing image grants.

Image queue names contain immutable manifest/export identity. The new saved broadcast planner format is not readable by a 2.x runner. Rolling back the entire runtime while new-format work is active requires an explicit data/workflow recovery decision; there is no promise of mixed-major operation or automatic downgrade.

## Verification and remaining release gates

An isolated package-install smoke test has passed: local tarballs were installed outside the workspace, the daemon installation contained no Next/React, the dashboard installation contained no daemon, authenticated signal execution worked, and client/dashboard shutdown did not kill the daemon. Repeat after building with:

```sh
pnpm --filter station-runtime-cli test:packed
```

The image backend’s five real Docker tests passed, including compiled native and bundled JavaScript invocations and independent expiry cleanup. See the [image validation instructions](STATION-IMAGES.md#recovery-validation-and-remaining-work) for the exact scope and reproduction steps. Dashboard end-to-end checks also exercised real Bun/Playwright sessions and sandbox installs, restart, terminals and files.

The complete release must still pass the coordinated repository preflight. The user explicitly deferred intended-Linux-host checks because that target is unavailable; deployment isolation/adapter/network and failover guarantees remain unverified for that host. Do not infer public multi-tenant readiness from unit tests or from the major version number. Publishing to npm and deprecating old StationKit releases are explicit release operations; creating this code and documentation does neither.
