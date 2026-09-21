# Station Images: authoring, registry and execution

Station Images let independently authored programs participate in Station as **signals, broadcast planners and beacons**. Programs can be native executables or bundled JavaScript. They implement a versioned process protocol; they do not have to import Station's TypeScript builders.

This guide describes the implemented 3.0 integration. It is an operator-managed execution feature, not a finished public customer deployment service. Operator registry APIs require `admin`; a separate tenant registry API uses explicitly mapped registry-only keys and isolated namespaces. Docker execution has passed real-engine tests on Docker Desktop’s Linux arm64 engine; deployment on other host configurations still requires validation. Trusted-local execution is only for code the host operator trusts.

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

Operator registry endpoints remain admin-only even when the rest of a loopback daemon runs without authentication. Configure auth and supply an operator key or authenticated operator session. There is no anonymous registry. Tenant publishing uses the separate tenant API and explicit grants described below, never operator credentials.

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

Before execution, the daemon copies and verifies the image and dependency closure into its private local cache. Child processes receive the cache path, never registry adapter objects or backend credentials. Complete cached digest-pinned activations can restart while remote storage is unavailable; moving tags still require authoritative resolution. Corrupt cached content fails verification. `storage.id` is a stable non-secret namespace identity, not an authorization boundary; changing it invalidates saved activation configuration until the operator explicitly reconciles it. Operator registry endpoints remain admin-only; tenant namespaces use the separate mapped-key gateway below.

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

The core execution library supports defaults → store → bindings → allowed overrides. Direct `/registry/run` does **not** accept arbitrary environment overrides or env files. Deployment generations can declare explicit bindings:

```json
{
  "APP_PREFIX": { "value": "production" },
  "API_TOKEN": { "fromEnv": "MEDIA_API_TOKEN" }
}
```

Both destination and `fromEnv` source keys must be in the operator's `allowedEnv` list. Literal `value` bindings are persisted non-secret configuration; never put credentials there. `fromEnv` persists only the key reference and resolves the value from the worker's scoped environment store for each attempt. Each generation receives distinct registered identities, so later bindings do not rewrite existing definitions. The reference is immutable; the secret value is **not** revision-pinned. Changing the source store can affect retries or later attempts using the same reference. A deployment can explicitly authorize per-invocation binding keys with `invocationEnv`. Supplying `environment` when invoking an alias creates a retained derived generation and an `invoke` history entry; it does not change the active alias pointer. Both ordinary generation grants and that invocation allowlist apply. This records binding references and non-secret values, never resolved secrets. Secret-store revisions are not versioned: retries resolve current values. Existing live beacons retain their process environment until an explicit restart or the rollout operation below.

For a deployment that grants `invocationEnv: ["APP_PREFIX"]` at staging, a one-off binding can be requested without changing its active generation:

```sh
station deployments run DEPLOYMENT_ID --json '{"alias":"echo","input":{"message":"hello"},"environment":{"APP_PREFIX":{"value":"one-off"}}}'
```

Use `fromEnv` for secret values. Ungranted override keys fail before enqueue. The returned generation identifies the retained derived configuration, and deployment history records `invoke`. This consumes retained generation capacity; it is not a transient secret-value channel.

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

Offline commands do not require a daemon:

```sh
station images build ./image-template.json --artifacts-dir ./build --out ./prepared-image
station images validate ./station-image.json --artifacts-dir ./build
station images pack ./station-image.json --artifacts-dir ./build --out ./packed-image
```

`build` hashes explicitly selected **precompiled** inputs and writes a manifest; `pack` verifies and copies them into a new directory. Neither compiles source, executes a build script or creates an OCI image. Symlinks, traversal and disguised native scripts are rejected.

Publish verifies every explicitly listed artifact's digest and byte count before uploading any blob, then publishes the manifest. The CLI cap is 128 MiB per file and 256 MiB total, subject to any smaller registry limit. The CLI uses resumable uploads by default and retains a private local receipt. Rerun the same publish command to reconcile the remote accepted offset before sending more bytes; it does not blindly repeat an uncertain mutation. Each blob is committed before its staging session is removed and the manifest is published. A partial publication can leave verified unreferenced blobs; rerunning a matching immutable publication is safe. The daemon also provides resumable upload sessions, described below. The dashboard also uses checksum-verified resumable chunks, tab-scoped receipts, accepted-byte progress and Pause/Resume. After a reload, reselect the same files; expired sessions restart. Automatic artifact garbage collection is not implemented.

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

Tags do not replace the definitions of queued work or restart existing beacons. Use deployment generations for versioned export aliases, explicit activation, rollback and drain. Artifact garbage collection is not implemented. Retaining old manifests, blobs and active state is necessary for recovery.

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
    mode: "eager", // Or "on-demand" to prepare queued finite work before claiming it.
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

The default is **periodic eager catalog synchronization**. With `upstream.mode: "on-demand"`, compatible finite exports and deployment-generation identities are advertised as installable without downloading executable blobs. When a queued run needs an uninstalled definition, the worker acquires a separate preparation reservation, verifies/imports the pinned closure, installs it, and only then becomes eligible to claim execution. Preparation does not consume the run's execution lease or block the runner's heartbeat loop. Images containing beacon exports are still prepared eagerly because beacon reconciliation has no cold-definition preparation hook. The on-demand path applies to finite-only images.

`GET /api/v1/registry/preparations` exposes this worker's recent `preparing`, `ready` and `failed` observations, including run ID, definition and timestamps. Preparation reservations use the network adapter; observation records are a bounded in-memory window, not a durable deployment audit log. Failure does not authorize execution; another attempt can prepare after reservation release/expiry. There is no per-image worker opt-in policy or automatic tenant image placement scheduler. Unsupported targets, including incompatible dependencies, are skipped so compatible catalog entries can still install. Corrupt records/blobs, invalid environment grants and other import failures stop that synchronization pass explicitly; they can delay later entries until repaired. The registry's ordinary metadata does not itself create a durable shared artifact store for application uploads/downloads.

A CLI context selects an API/registry endpoint. Add `--station WORKER_ID` to pin image execution to an eligible worker:

```sh
station images run acme/echo@1.0.0 echo --input @request.json --context headquarters --station coding-worker
```

For signals and planned broadcasts, Headquarters validates the selected worker's membership and installed definition; the durable pin constrains signal claims, the broadcast planner and every child run. An offline, incompatible or unprepared worker is rejected, and Headquarters itself is not an execution target. A pin remains immutable through retry/recovery; another worker does not silently take over. Omit `--station` for ordinary eligible-worker scheduling.

Headquarters can create image beacon instance intent through its shared beacon adapter, including a validated optional worker pin; an eligible BeaconRunner on a worker executes the instance. Headquarters does not spawn the beacon itself. The durable pin prevents another worker from acquiring it. A real two-runner integration case verifies the selected owner reaches readiness and that installing an image—even with an auto manifest—does not create a replica on every worker. To publish into one worker's local registry, use that worker's context. This does not promote the image into Headquarters. Headquarters can also proxy registry operations to explicit private targets:

```ts
registry: {
  targets: {
    "coding-worker": {
      url: "https://coding-worker.internal.example",
      token: process.env.CODING_WORKER_REGISTRY_TOKEN!,
    },
  },
}
```

The caller uses operator admin access at `/api/v1/stations/coding-worker/registry/...`. The server owns the destination URL and worker credential, validates the target's Station ID, protocol and major version, rejects redirects and bounds transfers. Remote targets require HTTPS. Requests cannot supply another URL or credential.

```sh
# For publish/list/inspect/pull/install/tag, --station chooses a private registry target.
station images publish ./station-image.json --artifacts-dir ./build --context headquarters --station coding-worker
station images install acme/echo@1.0.0 --context headquarters --station coding-worker
```

For `images run`, `--station` continues to mean durable execution placement against the selected context's registry. It does not silently select that worker's private registry. Connect to the worker context when invoking a worker-local image that Headquarters does not hold.

## Deployment generations, activation and rollback

A deployment is a stable name with retained immutable generations. Each generation pins its image digest, export aliases, optional worker ID, environment binding references and optional `invocationEnv` override allowlist. Staging validates the image and bindings without registering runnable exports. Activation prepares the generation and atomically changes the pointer used by later alias invocations. A failed preparation leaves the old pointer intact.

```sh
station api POST /registry/deployments --json '{"name":"media-production","reference":"acme/tools@1.0.0","aliases":{"resize":"resize-image"},"bindings":{"API_TOKEN":{"fromEnv":"MEDIA_API_TOKEN"}}}'
station api GET /registry/deployments
station api GET /registry/deployments/DEPLOYMENT_ID
station api POST /registry/deployments/DEPLOYMENT_ID/activate --json '{"generation":"GENERATION_ID","expectedRevision":1}'
station api POST /registry/deployments/DEPLOYMENT_ID/run --json '{"alias":"resize","input":{"width":800}}'
```

Read the returned `revision` before every activation, rollback or drain. A stale revision returns a conflict: refresh and review rather than retrying an obsolete change. Stage another generation using the same deployment name; the active one remains unchanged until activation. Rollback selects a previously activated retained generation:

```sh
station api POST /registry/deployments/DEPLOYMENT_ID/rollback --json '{"generation":"EARLIER_GENERATION_ID","expectedRevision":4}'
station api POST /registry/deployments/DEPLOYMENT_ID/drain --json '{"expectedRevision":5}'
```

Drain clears the active pointer and rejects new alias invocations. It does not cancel queued work, stop existing beacons, delete artifacts or remove generation history. Runs and saved plans preserve their immutable generation identity across activation and rollback. The invocation response includes deployment ID, generation ID and deployment revision, as well as the ordinary run/instance ID.

Deployment state uses private atomic filesystem storage by default; `registry.deploymentStorage` accepts a provider implementing snapshot read and compare-and-swap. Providers must serialize all writers in the namespace. A filesystem writer lock left by a killed process requires operator reconciliation and fails closed. Keep deployment state, activation state and referenced artifacts together for recovery.

The dashboard's Registry pages nest image names → versions → exports. Publication, installation, tagging and invocation are separate pages. Its Deployments pages provide staging, generation review, activation, rollback, drain, invocation and history. The dashboard identifies its fixed daemon and offers a Registry Station selector for operator-configured private targets. Selection persists through nested links and breadcrumbs. Publication, installation, tags and deployment operations route through Headquarters to the selected registry. A private image invocation targets that worker and retains its pin; the connected daemon registry offers independent execution placement. The generation form accepts environment-key references or explicitly acknowledged non-secret literals, and review shows reference names without fetching secret values.

## Resumable artifact uploads

Every configured operator registry has a resumable upload manager. Configure `registry.uploads` to set `maxChunkBytes`, `maxUploads`, `maxStagedBytes`, `ttlMs` or a custom upload storage provider. Defaults are 1 MiB chunks, 64 sessions, 512 MiB reserved staging capacity and a fixed one-hour lifetime. Final registry blob quota is separate from staging quota.

| Step | Request relative to `/api/v1/registry` | Result |
| --- | --- | --- |
| Reserve | `POST /uploads` with `{digest,size}` | Upload ID, offset, fixed expiry and state |
| Inspect/resume | `GET /uploads/:id` | Authoritative accepted offset |
| Append | `PATCH /uploads/:id` with raw bytes, `Upload-Offset`, `X-Chunk-SHA256` | New accepted offset |
| Commit | `POST /uploads/:id/commit` | Verified immutable blob, committed session |
| Cancel staging | `DELETE /uploads/:id` | Removes staging; committed blobs remain |

Offsets and chunk digests must agree with persisted state. Identical chunk retries are accepted; conflicting offsets/content fail. After a lost response, inspect the upload before resending. Commit requires the full declared byte count and whole-blob digest and is idempotent. Publish the manifest only after every artifact is committed. Expired sessions fail explicitly; reconnecting does not extend their lifetime.

File-backed sessions survive client death and storage-client recreation. Storage providers must make their upload transaction exclusive across all clients, durably reserve quotas, and retain reservations through interrupted cleanup. The HTTP layer bounds each chunk; final commit currently reassembles a bounded artifact in memory rather than supplying a constant-memory object-store multipart implementation. Quotas and maximum artifact size must account for that memory use.

## Tenant registries and execution grants

Tenant artifact access is a separate API beneath `/api/v1/tenant/registry`. Configure `registry.tenants` with distinct registry/blob/upload namespaces and mappings from verified API key **record IDs** to a tenant and permissions. Keys must have exactly the `registry` scope. Permissions are independent: `read`, `publish`, `activate` and `invoke`. Operator/session credentials, mixed-scope keys and unmapped keys do not become tenant keys. Key revocation is checked on later requests.

Tenant request bodies cannot choose another tenant, arbitrary worker URL, filesystem path or worker ID. Reads, tags, blobs, dependency resolution and upload sessions stay within the mapped namespace. Limits apply across all keys belonging to a tenant. Distinct namespace labels cannot compensate for adapters accidentally sharing the same physical storage; the operator must configure truly separate namespaces and enforce their quotas.

Registry-only tenants can publish/read but cannot execute. `createTenantRegistryWorkerGateway({tenantId, registry, url, token, stationId})` connects a namespace to an operator-provisioned dedicated worker. The fixed origin must use HTTPS outside loopback. The gateway verifies protocol/version, worker identity, tenant ownership, container isolation and opaque registry identity; forwards worker/tenant/namespace expectations; transfers the verified pinned dependency closure through resumable uploads; and invokes only that selected worker. Tenant bodies cannot override these destinations or credentials.

A real Docker test runs Headquarters with two dedicated tenant workers and exercises publication, signal results with granted environment/UID 1000/seccomp mode 2, compiled broadcast completion, signal/broadcast cancellation, beacon readiness/restart/new incarnation/stop, foreign-result denial and key revocation. The gateway checks immutable export and worker ownership before lifecycle reads or mutations. Separate fixture tests reject identity/redirect mismatches and reconcile a chunk whose response was lost. Gateway transfer receipts are currently in-memory: restarting it can leave prior remote staging until its fixed expiry, without changing committed immutable blobs.

See [Tenant image registries](../packages/station-daemon/REGISTRY-TENANCY.md) for full configuration. The operator still provisions each dedicated worker's queues, environment, storage and host/network policy. This helper does not implement a general tenant fleet scheduler, and local Docker verification does not establish production-host isolation or failover acceptance.

## Worker enrollment and live clients

Enrollment is separate from saving a CLI context or supplying shared queue credentials. The authority issues short-lived single-use invitations bound to a fixed network and worker ID. Redeeming an invitation returns a worker credential; the durable store retains only hashes, serializes independent writers and persists revocation. Explicit operator re-enrollment rotates the credential generation and invalidates the earlier credential. The file authority fails closed if a crash leaves its transaction lock; an operator must verify the previous authority stopped before recovering that lock.

Operator endpoints are `POST /api/v1/network/enrollments`, `GET /api/v1/network/members` and `DELETE /api/v1/network/members/:id`. Invitation redemption uses `POST /api/v1/network/join`; worker-credential checks and voluntary revocation use `POST /api/v1/network/admission` and `/network/leave`. Invitations expire after five minutes by default (at most fifteen). Worker admission uses a fixed HTTPS authority origin, bounded response/time limits and a fresh check rather than a cached authorization lease. The daemon gates initial admission, subsequent claims and heartbeat/lease renewal on fresh authority checks. A real daemon test revokes an active worker and verifies that it stops execution, cannot claim new work and cannot restore membership merely by heartbeating. Enrollment does not distribute database credentials or revoke a malicious process's independently acquired database access.

Configure Headquarters with `network.enrollment: {authority: true}` and authentication. For an authenticated worker, merge the generated `role` and `network` fields into its ordinary Station config, retaining the operator-configured shared network/queue adapters:

```sh
station network invite worker-a --out ./worker-a.invitation.json --ttl-ms 300000
station network join --file ./worker-a.invitation.json --out ./worker-a.enrollment.json
station network members
station network revoke worker-a
# Or voluntarily revoke with the worker credential:
station network leave --file ./worker-a.enrollment.json
```

Invitation and worker files are private (0600); the CLI reserves a new output path before issuing/redeeming credentials and does not print secrets to stdout. Join/leave use only the authority and identity in that private file (or `--file -` stdin), never a URL/context override. `leave` retains the local credential file for explicit cleanup. A lost redemption response requires a new operator invitation, not blind replay. The generated worker file contains `network.enrollment: {url, credential}` and is sensitive configuration, not a shareable project artifact.

Admission is distinct from draining: draining blocks new claims while keeping existing leases; denied/unavailable admission fences active signal/beacon children, skips lease renewal and blocks new work. Renewal checks are bounded at five seconds and subprocess cleanup escalates if SIGTERM is ignored. This is application admission for operator-managed workers; already-issued external side effects cannot be undone.


The operator TUI reconnects its read-only event feed with bounded backoff and a last-event cursor, revalidating daemon identity on reconnect. The server retains at most 256 events/1 MiB and signals a reset when a cursor expires or belongs to an earlier process epoch. Views reconcile on events and periodically; mutations never retry automatically. Tenant contexts poll their authorized views rather than subscribing to the global feed. The event buffer is not a durable audit log.

The TUI now nests workspace files, terminals, services and command receipts, plus browser pages, profiles, recordings, diagnostics, recovery checkpoints and artifact receipts. Registry exports and deployment generations/history/rollouts have detail views. Commands and artifact history are limited to receipts observed by this TUI because the APIs expose no global history list. Frame metadata is available in the terminal; visual playback remains in the dashboard. Binary transfers use the explicit CLI helpers. Common credential fields and embedded base64 are redacted, but arbitrary text is not guaranteed secret-free.

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

`signalName` is a sibling signal export, a declared image signal dependency alias, or a revision-pinned native Station signal alias explicitly granted by the operator. The daemon resolves it to the immutable registered name. Plans are bounded, cycle-checked and validated against permitted dependencies and expression structures. Arbitrary JavaScript input/guard expressions are not accepted.

The planner is a separate queued signal. Broadcast state first records its pinned planner/dependency identity, then persists the validated resulting plan before dispatching child runs. Recovery uses the saved plan rather than re-evaluating the planner once the plan has been committed. A crash before that persistence may repeat planning, so planners must not perform business side effects. Normal BroadcastRunner behavior supplies dependency progression, cancellation and child run records.

### Grant an ordinary Station signal to an image planner

A manifest may declare `nativeSignals: { trusted: { name: "trusted_step", revision: "sha256:..." } }`. Configure a matching `registry.execution.nativeSignals` entry with `{name, revision, file, selfContained: true}`. The file is a trusted operator-owned, prebundled JavaScript module whose default export is the named Station signal. Only `station-signal` may remain as an external import. Uploaded code cannot supply a module path or add this grant.

Station verifies the source revision, prepares an immutable local snapshot and verifies cached bytes at every bootstrap. The planner returns the alias `trusted`; its saved DAG records the revision-qualified registration. Later source changes do not rewrite that plan. This path loads trusted operator code with ordinary Station signal privileges; it is not a way to execute untrusted uploads outside image isolation. Real mixed native/image workflow tests cover restore without repeating completed children, and a SQLite subprocess test kills the controller between child completions and resumes the persisted plan.

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

Use `station images run IMAGE EXPORT --input @config.json` to create/start an instance, then the existing beacon instance APIs or CLI beacon commands to inspect, stop or restart it. Headquarters does not host a BeaconRunner. It can write shared beacon instance intent for installed image exports; eligible workers reconcile and run that intent. A beacon-capable worker context can also create the instance directly.

## Explicit beacon generation replacement

Activation and rollback select future aliases; they never silently replace a live beacon. Request a controlled replacement separately:

```sh
station deployments rollout DEPLOYMENT_ID --json '{"operationId":"rotate-worker-a-1","expectedRevision":7,"sourceInstance":"OLD_INSTANCE_ID","generation":"ACTIVATED_GENERATION_ID","alias":"watch"}'
```

The target must be a previously activated beacon generation, and the source instance must belong to the same deployment. Its existing configuration is validated against the target schema. The daemon durably records the operation, requests the source to stop, waits for observed stopped state, and then creates a deterministic replacement instance. It retains the source and old incarnation identity. Completion requires replacement readiness. A coordinator lease serializes reconciliation across controllers; startup resumes retained pending operations. Retrying the same operation ID reconciles that operation instead of creating another replacement. Inspect the deployment's `rollouts` records after a timeout or interrupted response; never invent a new operation ID to retry an uncertain operation.

This is a stop-before-replace rollout with possible downtime, not a rolling availability guarantee. Granted `fromEnv` keys resolve when the replacement starts, so this supports controlled process-environment rotation without pretending the secret store has immutable revisions. The dashboard has generation review but currently uses the CLI/API for explicit live rollout.

## Invocation files and artifact references

Large runtime data is separate from executable image blobs. `FileInvocationArtifactStore` stores bounded file payloads behind opaque `station-artifact:<64 hex>` references. An export declares `artifacts: {read?: true, write?: true}` and the operator separately grants those capabilities to its exact manifest digest and export:

```ts
// Inside registry.execution; use the actual immutable image digest.
artifacts: {
  rootDir: "/data/tenant-a/invocation-artifacts",
  grants: {
    [imageDigest + "#transform"]: {
      readReferences: [authorizedInputReference],
      write: true,
    },
  },
  maxBytes: 64 * 1024 * 1024,
  maxArtifacts: 16,
  maxChunkBytes: 64 * 1024,
  ttlMs: 60 * 60 * 1000,
  maxStorageBytes: 1024 * 1024 * 1024,
  maxStoredArtifacts: 1024,
}
```

The trusted wrapper creates a scope for a finite run/attempt or beacon instance/incarnation. A reference appearing in input does **not** authorize reading it: it must be in the operator's static `readReferences`. No storage path or controller credential enters the process. Keep each tenant's store physically separate and quota controlled. Staging rejects declared capabilities without grants.

Programs keep stdin open for broker replies and exchange `station.process/v1` `artifact:request` frames. Each request has a bounded unique `id` and an `operation`: `create` with `{size,digest}`, `append` with `{reference,offset,data}` (base64), `commit` with `{reference}`, or `read` with `{reference,offset,length}`. Correlated `artifact:response` frames return results; committed metadata includes reference, size, digest and expiry. Payload chunks stay within the granted limit, so large files do not have to fit in one result frame. Ordinary terminal signal results remain bounded.

The local store applies per-scope and durable global quotas, offsets, checksums, expiry and incomplete-upload cleanup. Defaults are 64 MiB/16 artifacts/64 KiB chunks/one hour per scope and 1 GiB/1024 references per store; configured maxima are bounded. The daemon reaps expired invocation artifacts every 60 seconds while configured. SDK callers can use `await store.scope(...)`, `scope.handle(frame)`, `scope.close()` and `store.reapExpired()` to import, read and clean authorized payloads. Stale transaction locks fail closed and require operator recovery.

There is no media-upload/download HTTP API, automatic reference authorization, cross-worker transfer service or distributed artifact-store driver. Other workers can access a reference only when the operator deliberately supplies the same authorized filesystem store and grants. These limits differ from executable-blob retention: automatic garbage collection of referenced image generations remains disabled. Final daemon integration evidence is recorded in the acceptance map.

## Finite process protocol and limits

Without artifact capabilities, a signal/planner invocation receives one line on stdin and emits one terminal JSON line on stdout. Artifact-enabled programs additionally exchange the bounded broker frames above and must continue reading replies:

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
| `GET /registry/preparations` | — | Local bounded preparation observations |
| `GET /registry/generations` | — | Activated and retained generation catalog for workers |
| `GET /registry/deployments` | — | Deployment records |
| `GET /registry/deployments/:id` | — | Generations, active pointer, revision and history |
| `POST /registry/deployments` | `{name,reference,aliases?,stationId?,bindings?,invocationEnv?}` | Staged generation |
| `POST /registry/deployments/:id/activate` | `{generation,expectedRevision}` | Activated pointer and new revision |
| `POST /registry/deployments/:id/rollback` | `{generation,expectedRevision}` | Previously active generation selected |
| `POST /registry/deployments/:id/drain` | `{expectedRevision}` | Active pointer cleared; retained work untouched |
| `POST /registry/deployments/:id/run` | `{alias,input?,environment?}` | Immutable generation and run/instance identity; allowed overrides retain a derived generation |
| `POST /registry/deployments/:id/rollout` | `{operationId,expectedRevision,sourceInstance,generation,alias}` | Durable stop-before-replace intent and eventual readiness |

Pull fails explicitly when no upstream is configured. Install/run fail explicitly when image execution is not configured. These endpoints never authorize custom Docker settings or host paths. Direct image run accepts only its declared input and optional validated `stationId` pin. Deployment run separately accepts explicitly granted environment bindings as described above. Use `station api` for the underlying JSON operations; the CLI implements dedicated publish/list/inspect/tag/pull/install/run commands.

## Recovery, validation and remaining work

Activation roots are persisted privately under the daemon's image state directory and restored on startup. They are pinned to manifest digests and to the configured backend/environment grants. A changed configuration hash fails restoration instead of silently changing existing permissions. Preserve the registry and activation state together. Explicit deployment rollback is available. There is no automated reconciler for changing operator grants or safely deleting referenced blobs; preserve all retained generation artifacts.

Tests have exercised independently compiled Go beacon readiness/poll/heartbeat/restart/stop, native Station workflow and schedule composition, and JavaScript/native programs through real SignalRunner child processes, input/environment propagation without inherited controller secrets, immutable restoration, cancellation, planner output and external beacon protocol supervision. Packed-install checks have exercised the daemon/CLI/dashboard split outside the monorepo. These are evidence for the implemented paths, not proof that every operating system, storage adapter, cloud host or hostile workload is supported.

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

A separate native Docker beacon test passed with an independently cross-compiled Go executable: readiness, poll/heartbeat, granted environment, scoped dependency-trigger deduplication per incarnation, same-instance restart/new incarnation and clean container stop. Actual SQLite SIGKILL tests also passed saved-plan continuation and preparation lease takeover after wall-clock expiry.

The user explicitly deferred intended-Linux-host verification because that target is unavailable. That exception leaves production isolation/adapter/failover claims unverified; it does not convert local fixture results into production evidence. The coordinated 20-package release dry run and isolated packed installs passed; live npm publish permissions remain unverified. Perform deployment-specific verification before relying on production guarantees. The concrete dedicated tenant gateway has real Docker fixture coverage; production acceptance for namespace storage, queue ownership, quotas, syscall/network controls, independent reaping and recovery remains unverified because no Linux staging host is available in this session. Tenant registry grants and dedicated lifecycle routing, staged deployments with audited invocation bindings, explicit beacon rollout, daemon enrollment gates, mixed native/image planners, nested private-registry dashboard workflows and on-demand preparation are implemented. Invocation artifact scopes have static operator grants and local storage; final integration evidence and remaining transfer limits are recorded in the acceptance map. Actual SQLite process-kill recovery now covers saved plans and preparation lease expiry. Production-adapter/host verification and authenticated live publication remain; automatic image artifact GC is not enabled. The optional VM backend is not required to validate the Docker implementation. Use the [acceptance matrix](STATION-IMAGES-ACCEPTANCE.md) for specific implementation and evidence gaps rather than inferring completion from a package version.

The [CLI execution coverage map](STATION-CLI-COVERAGE.md) enumerates every current sandbox/browser RPC, the generic or dedicated command, and the test evidence without implying support on every backend.

For scripts, `station sandbox exec ID --station OWNER --command "git status" --wait --wait-timeout-ms 300000 --json-errors` waits for the accepted command and prints the final JSON result. Ordinary remote exit codes are preserved; remote timeout maps to 124, cancellation to 130 and interrupted/lost execution to 125. A failed result with no usable exit code maps to 1. Default exec remains asynchronous. The local wait deadline is 300000 ms by default (1–86400000 allowed), starts after the execution receipt, and stops polling without cancelling the remote command; Ctrl-C likewise detaches the waiter. Local timeout/interrupt returns the latest known JSON snapshot, exits 124/130 and reports `wait_timeout`/`wait_interrupted`. Set a remote execution timeout separately using `--json '{"timeoutMs":10000}'`. Global `--json-errors` emits a sanitized `{error:{code,status,message}}` on stderr; transport failures exit 1 and are distinct from the returned remote result. Neither polling failure nor disconnect replays exec or sends cancel.
