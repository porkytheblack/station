# Station Images: authoring, registry and execution

Station Images let independently authored programs participate in Station as **signals, broadcast planners and beacons**. Programs can be native executables or bundled JavaScript. They implement a versioned process protocol; they do not have to import Station's TypeScript builders.

This guide describes the implemented 3.0 integration. It is an operator-managed execution feature, not a finished public customer deployment service. Registry APIs require `admin`. Docker execution has passed real-engine tests on Docker Desktop’s Linux arm64 engine; deployment on other host configurations still requires validation. Trusted-local execution is only for code the host operator trusts.

## What an image contains

An image is an immutable JSON manifest plus content-addressed executable blobs. It is not a Docker/OCI filesystem image and does not create an isolation boundary by itself.

| Item | Meaning |
| --- | --- |
| `format: "station.image/v1"` | Manifest contract |
| `protocol: "station.process/v1"` | Program stdin/stdout contract |
| `name`, `version` | Human-readable immutable publication identity |
| `artifacts` | Executable bytes, SHA-256 digest, size, entrypoint basename, runtime and platform |
| `exports` | Named signals, broadcast planners or beacons with bounded schemas and options |
| `dependencies` | Aliases pinned to another image digest and signal/broadcast export |
| `env` | Optional non-secret application defaults; values still require operator grants |

An image digest covers its canonical manifest, including artifact/dependency digests. Published `name@version` is immutable. Tags can move; installing or running a tag resolves it to an immutable digest. An old queued run retains its digest-qualified definition when a later version is installed.

Reference forms are `acme/tools@1.0.0`, `acme/tools@stable`, `acme/tools@sha256:…` or a raw `sha256:…` digest. Colon-style Docker tags are not the current API syntax.

Artifacts declare `runtime: "native" | "node" | "bun"`. JavaScript artifacts require `runtimeMajor`, a minimum major supported by the selected execution target. Native artifacts declare the actual OS/architecture; Linux native artifacts also declare their ABI. Supported native headers are checked against ELF, Mach-O or PE declarations; a shell script labeled `native` is rejected. Matching a binary header does not prove that every dynamic library it needs exists in the runtime image.

The JSON Schema subset is intentionally bounded: primitive/object/array types, object properties/required/additionalProperties, items, enum, numeric bounds, string/array lengths and descriptions. Unsupported keywords are rejected. A schema is data, never code evaluated by the controller.

## Author a bundled JavaScript signal

This program uses only standard Node APIs. Parameters arrive in JSON; a separately granted environment variable supplies configuration.

```js
// build/echo.mjs
let requestText = "";
for await (const chunk of process.stdin) requestText += chunk;
const request = JSON.parse(requestText);

if (request.protocol !== "station.process/v1" || request.type !== "invoke") {
  throw new Error("Unsupported invocation");
}

process.stdout.write(JSON.stringify({
  protocol: "station.process/v1",
  type: "result",
  output: {
    message: request.input.message,
    prefix: process.env.APP_PREFIX ?? "",
  },
}) + "\n");
```

For an application with external dependencies, bundle them into the single JavaScript artifact before packaging. The registry does not run a compiler, install npm dependencies or copy the author's directory. Native programs follow the same JSON protocol after being compiled for the execution target. A Bun standalone build follows the native artifact path.

Generate a manifest with the actual artifact digest and byte count:

```js
// create-manifest.mjs
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const bytes = await readFile("./build/echo.mjs");
const manifest = {
  format: "station.image/v1",
  protocol: "station.process/v1",
  name: "acme/echo",
  version: "1.0.0",
  artifacts: [{
    platform: { os: "any", arch: "any" },
    runtime: "node",
    runtimeMajor: 22,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    size: bytes.length,
    entrypoint: "echo.mjs",
  }],
  exports: [{
    name: "echo",
    kind: "signal",
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string", maxLength: 4096 } },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    requiredEnv: ["APP_PREFIX"],
    timeoutMs: 5000,
  }],
};
await writeFile("./station-image.json", JSON.stringify(manifest, null, 2));
```

```sh
node create-manifest.mjs
```

Entrypoints are single basenames. There is no archive extraction, arbitrary URL fetch or implicit inclusion of `.env`. Dependencies must already be available when a manifest is published; dependency references pin digests rather than moving tags.

## Enable an operator registry

Add registry storage and authentication to a daemon configuration:

```ts
import { defineConfig } from "station-daemon";

export default defineConfig({
  host: "127.0.0.1",
  port: 4400,
  stationDir: "./station-data",
  auth: {
    username: "operator",
    password: process.env.STATION_AUTH_PASSWORD!,
  },
  registry: {
    rootDir: "registry",
    maxBlobBytes: 64 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
  },
});
```

The registry path is resolved under the daemon's data directory. A registry-only daemon can store/serve images without executing them. The API defaults cap individual blobs at 256 MiB and total stored blob bytes at 2 GiB; the example chooses smaller limits. Manifests have their own bounded size/schema checks.

Registry endpoints remain admin-only even when the rest of a loopback daemon runs without authentication. Configure auth and supply an operator key or authenticated operator session. There is no anonymous registry or tenant-customer publishing grant.

## Registry storage adapters

Registry storage has two independent adapters: metadata (manifests, immutable versions and tags) and executable blobs. The `ImageRegistry` service owns manifest/schema validation, digests, dependency checks and publication rules. Storage selection does not change the HTTP API, CLI or execution backend.

```ts
import { defineConfig } from "station-daemon";
import {
  FileRegistryMetadataAdapter, FileRegistryBlobAdapter,
} from "station-images";

export default defineConfig({
  registry: {
    storage: {
      id: "production-images-v1",
      metadata: new FileRegistryMetadataAdapter("/data/catalog"),
      blobs: new FileRegistryBlobAdapter("/data/artifacts"),
    },
    cacheDir: "image-cache",
    maxBlobBytes: 64 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
    // Add registry.execution and authentication as shown in the surrounding sections.
  },
});
```

Use either `rootDir` for the default filesystem registry or `storage` for explicit adapters. `cacheDir` is a local execution cache resolved under the daemon's data directory; it defaults to `images/cache` for custom storage. The standalone library equivalent is `new ImageRegistry({ storage, maxBlobBytes, maxTotalBytes })`. Existing `FileImageRegistry` callers and on-disk registries keep working.

| Interface | Built-ins | Required backend behavior |
| --- | --- | --- |
| `RegistryMetadataAdapter` | `FileRegistryMetadataAdapter`, `MemoryRegistryMetadataAdapter` | Bounded reads; atomic create-if-absent for manifests/versions; atomic tag replacement; complete bounded version listing |
| `RegistryBlobAdapter` | `FileRegistryBlobAdapter`, `MemoryRegistryBlobAdapter` | Bounded reads; immutable create-if-absent and atomic total-byte admission across all writers |

Memory adapters are for tests or explicitly ephemeral registries. Clients share memory only by sharing adapter instances. PostgreSQL metadata and S3-compatible blob providers can implement these interfaces, but no PostgreSQL/S3 registry drivers are bundled. The existing Station database queue adapters are separate contracts.

Custom metadata providers must support unique conditional writes and read-after-write consistency. Blob providers must enforce the namespace's byte limit across concurrent writers; an object-store conditional PUT by itself does not implement total quota accounting. Keep all writers' namespace limits consistent. Provider clients, credentials and connection cleanup are operator-owned, not image fields or customer API inputs. There is no implicit namespace migration or garbage collection.

Before execution, the daemon copies and verifies the image and dependency closure into its private local cache. Child processes receive the cache path, never registry adapter objects or backend credentials. Complete cached digest-pinned activations can restart while remote storage is unavailable; moving tags still require authoritative resolution. Corrupt cached content fails verification. `storage.id` is a stable non-secret namespace identity, not an authorization boundary; changing it invalidates saved activation configuration until the operator explicitly reconciles it. Registry endpoints remain operator-only.

## Choose an execution backend

Set `registry.execution` to register image exports into the runners. The backend configuration is operator-owned and never accepted from an uploaded manifest.

A Docker configuration shape is:

```ts
registry: {
  rootDir: "registry",
  execution: {
    backend: {
      kind: "docker",
      options: {
        image: process.env.STATION_IMAGE_RUNTIME!, // reviewed name@sha256:<digest>
        rootDir: "/var/lib/station/image-processes",
        target: {
          os: "linux",
          arch: "amd64",
          abi: "glibc",
          runtimes: { node: 22 },
        },
        nodeExecutable: "/usr/local/bin/node",
        memoryMb: 256,
        cpus: 1,
        pidsLimit: 64,
        maxRuntimeMs: 300000,
        // Optional reviewed profile when the engine default is unconfined:
        seccompProfile: "/etc/station/seccomp.json",
      },
    },
    allowedEnv: ["APP_PREFIX"],
  },
}
```

The selected Linux image must already be installed and pinned by digest. It must provide `/usr/bin/timeout` and each declared runtime executable. Its reviewed OS, architecture, ABI and runtime versions must match the declaration. Images declaring writable volumes are rejected. The Docker engine must support enforced CPU, memory/swap and PID limits with seccomp filtering. An engine whose default is unconfined is rejected unless `seccompProfile` supplies an operator-reviewed, deny-default profile. That profile must be an absolute, regular JSON file that is not group/world writable; Station stages a private content-addressed copy and applies it explicitly. This does not change the engine’s global configuration.

The backend uses a non-root UID/GID, read-only root filesystem, dropped capabilities, no-new-privileges, bounded tmpfs, no network and a read-only mount containing only the verified artifact. It does not mount the Docker socket into the workload. Private transient env files convey granted values; those values are not command-line arguments. Network access, arbitrary mounts, custom image flags and workload-selected Docker images are not exposed.

Container execution shares the host kernel. It is not a VM, and no VM backend is provided. The configured container lifetime ceiling also bounds beacons: a genuinely long-lived application must account for restart/supervision rather than assuming an immortal container. Validate cleanup and run an independent host reaper for failed/killed controllers. A runtime timeout alone is not a complete public-tenant isolation guarantee.

### Independent Docker cleanup

Run `station-image-reaper` from the `station-images` package as a separate host service. Keeping it outside the daemon and signal bootstrap is necessary: `SIGKILL` or a controller crash cannot execute normal cleanup. The runtime's GNU `timeout` process is useful supervision but is not a sufficient enforcement boundary against hostile code running as the same UID.

Create `/etc/station/image-reaper.json` with the same Docker backend options and absolute `rootDir` used by the worker. This file contains operator policy, not invocation secrets:

```json
{
  "image": "node@sha256:REPLACE_WITH_REVIEWED_DIGEST",
  "rootDir": "/var/lib/station/image-processes",
  "target": { "os": "linux", "arch": "amd64", "abi": "glibc", "runtimes": { "node": 22 } },
  "maxRuntimeMs": 300000,
  "seccompProfile": "/etc/station/seccomp.json"
}
```

Use a regular file that is not group/world writable. The service needs access to the same Docker engine and private staging directory, but no daemon API key or uploaded image code. Run one pass or supervise a continuous process:

```sh
station-image-reaper --config /etc/station/image-reaper.json --once
station-image-reaper --config /etc/station/image-reaper.json --interval-ms 5000
```

A minimal Linux service, with executable paths adjusted for the installation:

```ini
[Unit]
Description=Station image expiry reaper
After=docker.service
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/station-image-reaper --config /etc/station/image-reaper.json --interval-ms 5000
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Each invocation has an fsynced private journal and matching immutable container labels recording its owner and expiry. The reaper verifies the journal, container identity, image and labels before removing an expired container by ID. It leaves unexpired or unverifiable entries for the owning controller/operator. `reconcile()` only removes verified stopped containers; `reapExpired()` also removes running expired containers. Cleanup failures retain the journal rather than claiming success. Keep old policy reapers active until their invocations drain when changing the configured image. Polling interval, engine availability and host availability affect removal latency; monitor retained journals and supervise the reaper itself.

For **trusted development only**, the backend can instead be:

```ts
backend: {
  kind: "trusted-local",
  allowUnsafeHostExecution: true,
  target: {
    os: "darwin",
    arch: "arm64",
    abi: "none",
    runtimes: { node: 22 },
  },
}
```

That example targets an Apple Silicon development host; change the declarations to the actual POSIX host/runtime. Linux native targets require `glibc` or `musl` as appropriate. This backend has access to the host filesystem/network and does not enforce host CPU/memory quotas. Never use it for public uploaded code. It requires explicit opt-in; Docker failure does not fall back to it. Tenant-bound daemon execution rejects this backend.

## Grant and populate application environment

`allowedEnv` is a server-side allowlist. Every application key, including non-secret manifest defaults, must be granted. Declaring `requiredEnv` does not authorize access to a secret; it only adds a requirement. Reserved process-control/shell keys and `STATION_*` control variables are rejected.

The daemon resolves its existing environment store for the installed definition and forwards only allowed injected values. It does not copy the controller's entire process environment into an image. Native code can read ordinary OS variables; JavaScript can use `process.env` inside the execution boundary.

For the example, add `APP_PREFIX` to the existing environment store using an admin connection:

```sh
station api POST /env --json '{"key":"APP_PREFIX","value":"hello","secret":false}'
```

For a secret, read the JSON body from stdin rather than a command argument or shell history:

```sh
station api POST /env --json -
```

Supply the object with `secret: true` through your secure local input mechanism. Normal API responses redact secret values. Scope `targets` to the registered image definition names where appropriate; installation returns those names. Broadcast planners use broadcast environment scope, signals use signal scope and beacons use beacon scope. A worker needs its own authorized environment store values or an intentionally shared environment storage adapter: publishing at Headquarters does not distribute secrets.

The core execution library supports defaults → store → bindings → allowed overrides. The current daemon integration exposes the manifest defaults and environment-store allowlist path; `/registry/run` does **not** accept arbitrary environment overrides, env files or secret-reference bindings. Secret revision pinning and audited rotation policy remain deployment-level work. Changes affect later attempts or explicitly restarted beacon instances, not an already-running process's environment.

## Publish, inspect, install and run

Save an operator connection using the CLI:

```sh
station context add local --url http://127.0.0.1:4400 --token-stdin
station context use local
station images publish ./station-image.json --artifacts-dir ./build
station images list
station images inspect acme/echo@1.0.0
station images install acme/echo@1.0.0
station images run acme/echo@1.0.0 echo --input '{"message":"from an independent program"}'
```

Publish verifies every explicitly listed artifact's digest and byte count before uploading any blob, then publishes the manifest. The CLI cap is 128 MiB per file and 256 MiB total, subject to any smaller registry limit. A partial publication can leave verified unreferenced blobs; rerunning a matching immutable publication is safe. There is no upload-resume protocol or automatic garbage collection.

Install validates the dependency closure, compatibility and environment grants, writes trusted supervisor wrappers and persists activation identity. It imports from a configured upstream when the image is absent locally. Run installs/resolves the requested image first, then dispatches according to export kind:

| Export | Run result | Runtime behavior |
| --- | --- | --- |
| Signal | Signal run ID | Queued supervised invocation; input/output validated |
| Broadcast | Broadcast run ID | Planner itself runs as a queued signal; its saved DAG drives child runs |
| Beacon | Beacon instance ID | Creates a configured instance with start intent; ordinary beacon lifecycle APIs apply |

The result also includes the image digest and `registeredName`. Use `/runs/ID`, `/broadcast-runs/ID` or the beacon instance APIs for progress. No `--wait` is implied by the image run command.

Installed names encode the full manifest digest and export name. This lets existing schedules, broadcasts and beacon dependencies refer to stable definitions without changing the meaning of old queued work. Keep these identities when composing primitives; do not guess a name by concatenating a human version string.

Update by publishing a new version. Moving a tag selects a different digest for future install/run requests:

```sh
station images tag acme/echo --tag stable --digest sha256:FULL_MANIFEST_DIGEST
station images run acme/echo@stable echo --input @request.json
```

Tags do not replace the definitions of queued work or restart existing beacons. The current API has no deployment-generation rollback/GC controller or friendly mutable export aliases. Retaining old manifests, blobs and active state is necessary for recovery.

## Headquarters: publish once, synchronize workers

A network still requires shared durable signal/broadcast/beacon queue and membership adapters. Configure Headquarters and workers with those same stores and stable station identities. Image distribution augments that network; it does not replace it.

Headquarters needs `registry.execution` to register immutable definitions and enqueue planner work, even though the Headquarters role does not execute signal processes locally. Its declared target must describe the compatible artifacts it admits. Workers need an execution backend, matching required environment grants and an authenticated upstream:

```ts
// Excerpt from an execution Station's configuration.
role: "station",
// adapter, broadcastAdapter, beaconAdapter and network.adapter:
// configure shared durable instances for this fleet.
registry: {
  rootDir: "registry",
  execution: {
    backend: reviewedBackendConfig,
    allowedEnv: ["APP_PREFIX"],
  },
  upstream: {
    url: "https://hq.example.com",
    token: process.env.STATION_REGISTRY_UPSTREAM_TOKEN!,
    maxBlobBytes: 64 * 1024 * 1024,
    syncIntervalMs: 5000,
  },
  // Optional explicit startup references in addition to catalog synchronization.
  activate: ["acme/echo@1.0.0"],
}
```

`reviewedBackendConfig` is the operator's backend union shown above, not a value supplied by an image publisher. Upstream credentials currently require Headquarters admin access because the registry has no separate read-only registry scope. Treat them as control-plane secrets. Remote upstream URLs require HTTPS; loopback HTTP is allowed. Redirects and arbitrary caller-chosen fetch destinations are rejected.

On startup and periodically afterward, the worker reads the Headquarters catalog, selects compatible targets, imports and verifies their pinned dependency closure, installs them and advertises the registered definitions. Synchronization defaults to five seconds; configured intervals must be between one second and one hour. New workers with empty local caches use the same flow without republishing images.

Publish and run against the Headquarters context:

```sh
station images publish ./station-image.json --artifacts-dir ./build --context headquarters
station images run acme/echo@1.0.0 echo --input @request.json --context headquarters
```

Workers that have installed the immutable definitions can claim eligible shared-queue work under normal network leases/capacity. A worker without the required platform/runtime or environment grant cannot simply execute the artifact. Compatibility/policy/import failures are logged and synchronization retries; monitor those failures rather than assuming successful catalog visibility means execution readiness.

This is **periodic eager catalog synchronization**, not the complete proposed on-demand deployment scheduler. There are no explicit preparation reservations, download progress run states, per-image worker opt-in policies or per-tenant catalog scopes yet. Unsupported targets, including incompatible dependencies, are skipped so compatible catalog entries can still install. Corrupt records/blobs, invalid environment grants and other import failures stop that synchronization pass explicitly; they can delay later entries until repaired. The registry's ordinary metadata does not itself create a durable shared artifact store for application uploads/downloads.

A CLI context selects an API/registry endpoint. Add `--station WORKER_ID` to pin image execution to an eligible worker:

```sh
station images run acme/echo@1.0.0 echo --input @request.json --context headquarters --station coding-worker
```

For signals and planned broadcasts, Headquarters validates the selected worker's membership and installed definition; the durable pin constrains signal claims, the broadcast planner and every child run. An offline, incompatible or unprepared worker is rejected, and Headquarters itself is not an execution target. A pin remains immutable through retry/recovery; another worker does not silently take over. Omit `--station` for ordinary eligible-worker scheduling.

For a pinned beacon, connect to the selected worker's context and use its ID; remote targeted beacon creation through Headquarters fails explicitly. Its durable instance pin also prevents another worker from acquiring it. To publish into one worker's local registry, use that worker's context. This does not promote the image into Headquarters. No dedicated Headquarters-to-worker registry proxy command exists yet.

## Broadcast planners

A broadcast export declares `kind: "broadcast"` and `planner: "binary"`. It receives the finite invocation protocol and returns a declarative DAG:

```json
{
  "nodes": [
    {
      "name": "first",
      "signalName": "echo",
      "dependsOn": [],
      "input": { "kind": "ref", "path": ["input"] }
    }
  ],
  "failurePolicy": "fail-fast"
}
```

`signalName` is a sibling signal export or a declared signal dependency alias. The daemon resolves it to the immutable registered name. Plans are bounded, cycle-checked and validated against permitted dependencies and expression structures. Arbitrary JavaScript input/guard expressions are not accepted.

The planner is a separate queued signal. Broadcast state first records its pinned planner/dependency identity, then persists the validated resulting plan before dispatching child runs. Recovery uses the saved plan rather than re-evaluating the planner once the plan has been committed. A crash before that persistence may repeat planning, so planners must not perform business side effects. Normal BroadcastRunner behavior supplies dependency progression, cancellation and child run records.

Nested broadcast nodes are not supported. Declaring another broadcast as a manifest dependency makes it available to supported broker paths such as beacons; it does not turn a broadcast DAG node into a nested workflow primitive.

## Beacons and brokered dependencies

A beacon export declares `kind: "beacon"`, `mode: "run" | "poll"`, optional `configSchema`, `pollIntervalMs`, `requiredEnv` and `startMode`. A run receives an instance/incarnation identity rather than a signal run ID. Starting or restarting it creates a supervised execution process; it does not restore arbitrary in-memory state.

The program reads a stream of newline-delimited frames and keeps stdin open:

| Direction | Frames |
| --- | --- |
| Supervisor → program | `beacon:init`, `beacon:poll`, `beacon:stop`, dependency-trigger replies |
| Program → supervisor | `beacon:started`, `beacon:ready`, `beacon:heartbeat`, `beacon:poll-completed` / `beacon:poll-failed`, `beacon:stopped`, `trigger` |

Every frame includes `protocol: "station.process/v1"`. Poll requests/results correlate by invocation ID; only one poll is outstanding. Station owns polling cadence and health/start/stop deadlines. A program must acknowledge stop and exit cleanly. Restarts are supervised through the existing beacon lifecycle; long-running application code must tolerate process replacement.

A `trigger` request carries a declared dependency alias, input and a stable request ID. The daemon broker validates the dependency pinned in the manifest and queues the corresponding signal or broadcast. The binary receives no unrestricted Headquarters key or database/lease credentials. The broker uses instance/incarnation/request identity for enqueue deduplication; this does not promise exactly-once business effects.

Use `station images run IMAGE EXPORT --input @config.json` to create/start an instance, then the existing beacon instance APIs or CLI beacon commands to inspect, stop or restart it. Headquarters does not host a BeaconRunner: create the initial beacon instance through a beacon-capable worker context or the existing authorized network beacon instance route, rather than expecting an image beacon process to run in Headquarters.

## Finite process protocol and limits

One signal/planner invocation receives one line on stdin and emits one terminal JSON line on stdout:

```json
{"protocol":"station.process/v1","type":"invoke","export":"echo","runId":"run-id","attempt":1,"input":{"message":"hello"},"deadline":"2026-09-21T12:00:00.000Z"}
```

```json
{"protocol":"station.process/v1","type":"result","output":{"message":"hello","prefix":"example"}}
```

Errors use `type: "error"` with `{ "code": "application_code", "message": "bounded detail" }`. Stdout is protocol-only; ordinary diagnostics go to stderr. Duplicate terminal output, malformed frames, trailing unterminated bytes, invalid schemas and nonzero exit fail the invocation. Producing a result and then exiting nonzero is not success.

Core defaults are a 1 MiB frame, 4 MiB stdout, 64 KiB stderr and 60-second finite invocation deadline, further constrained by manifest/backend policy. The daemon wrapper gives the protocol supervisor a shutdown window before the outer runner deadline. SIGTERM and runner IPC disconnect propagate cancellation into the execution boundary. SIGKILL cannot run cleanup code; container journals, lifetime policy and independent host cleanup are still necessary. The daemon does not copy raw arbitrary binary stderr into central logs because it can contain secrets.

Signal retries, leases and broadcast/beacon recovery are Station-owned. External side effects remain at-least-once unless the application implements its own idempotency. Uploaded programs never receive queue adapter credentials merely to report completion.

## Registry HTTP API

All paths below are relative to `/api/v1` and require operator `admin` scope. JSON success responses use `{ "data": ... }`; blob reads are raw bytes.

| Method/path | Request | Result |
| --- | --- | --- |
| `PUT /registry/blobs/:digest` | Raw artifact bytes | Verified digest/size |
| `GET /registry/blobs/:digest` | — | Artifact bytes |
| `POST /registry/images` | Manifest object | Immutable manifest/digest record |
| `GET /registry/images` | — | Published version records |
| `GET /registry/resolve?ref=...` | URL-encoded reference | Resolved record |
| `PUT /registry/tags` | `{name, tag, digest}` | Updated tag identity |
| `POST /registry/pull` | `{reference}` | Imported upstream image/dependencies |
| `POST /registry/install` | `{reference}` | Image and exports with registered names |
| `POST /registry/run` | `{reference, export, input, stationId?}` | Kind, run/instance ID, image digest and registered name |

Pull fails explicitly when no upstream is configured. Install/run fail explicitly when image execution is not configured. These endpoints do not authorize custom Docker settings, host paths, invocation environment overrides or arbitrary placement fields beyond the validated optional `stationId` pin. Use `station api` for the underlying JSON operations; the CLI implements dedicated publish/list/inspect/tag/pull/install/run commands.

## Recovery, validation and remaining work

Activation roots are persisted privately under the daemon's image state directory and restored on startup. They are pinned to manifest digests and to the configured backend/environment grants. A changed configuration hash fails restoration instead of silently changing existing permissions. Preserve the registry and activation state together. There is currently no automated reconciler for changing those grants, deleting referenced blobs or performing deployment rollbacks.

Tests have exercised independent JavaScript and compiled native programs through real SignalRunner child processes, input/environment propagation without inherited controller secrets, immutable restoration, cancellation, planner output and external beacon protocol supervision. Packed-install checks have exercised the daemon/CLI/dashboard split outside the monorepo. These are evidence for the implemented paths, not proof that every operating system, storage adapter, cloud host or hostile workload is supported.

Five real Docker integration tests passed on Docker Desktop 27.5.1 with its Linux arm64 engine and Node 22 Debian runtime. They covered registry-to-container execution for bundled JavaScript and a statically compiled Go binary, input and granted environment propagation, UID 1000, read-only root, no inherited controller secret or Docker socket, network disabled, memory/PID limits, dropped capabilities, no-new-privileges and seccomp filtering. Timeout cleanup removed the complete boundary. An independent backend instance retained an unexpired running invocation and removed it at expiry; normal disposal then completed safely. The expiry test advances an operator-only clock instead of waiting five minutes.

Reproduce the integration checks using a reviewed, preinstalled digest-pinned runtime image and a native binary matching that engine’s architecture:

```sh
# From the repository root; use amd64/arm64 for the actual Docker engine.
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o /tmp/station-docker-native packages/station-images/test/fixtures/docker-native.go
STATION_IMAGE_DOCKER_IMAGE='node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9' \
STATION_IMAGE_DOCKER_ARCH=arm64 \
STATION_IMAGE_DOCKER_SECCOMP=/etc/station/seccomp.json \
STATION_IMAGE_DOCKER_NATIVE=/tmp/station-docker-native \
node --import tsx --test packages/station-images/test/docker.integration.ts
```

The tested explicit profile was the [official Moby 27.5.1 default seccomp profile](https://github.com/moby/moby/blob/v27.5.1/profiles/seccomp/default.json). Review an appropriate profile for your engine before installing it; do not disable seccomp to make a check pass. The test skips when the image variable is absent, and the native case skips without its fixture. A skipped integration test is not successful container validation. These tests are available from the source checkout, not the published package.

Before a production release, repeat relevant checks on the intended Linux configuration, complete the release dry run, supported native dependency/platform checks and fleet recovery tests against the actual durable adapters. Public multi-tenant image deployment additionally needs a customer authorization model, tenant-separated registry/storage and quotas, a reviewed isolation/network policy, deployment of the independent reaper and operational recovery controls. The planned full TUI, image dashboard/deployment pages, on-demand preparation reservations, automatic enrollment, deployment rollback/GC and VM backend are not implemented by this slice.
