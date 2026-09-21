# station-images

Station images package independently compiled signals, broadcast planners and beacons. They contain a validated JSON manifest and immutable SHA-256-addressed executable blobs. An image is **not an OS image or an isolation boundary**.

This package supplies the registry, dependency import, compatibility checks, process protocol and supervisors. The Station daemon supplies authentication, tenant scope, scheduling, placement, durable ownership and deployment policy.

## Package an image

Bundle JavaScript to one entrypoint, or compile a native executable for a declared OS/architecture/ABI. Node/Bun JavaScript needs `runtimeMajor`; Bun standalone executables use `runtime: "native"`. Files imported by a JavaScript entrypoint must be bundled into it. No `npm install`, arbitrary compiler or uploaded code runs during publication.

```ts
import { readFile } from "node:fs/promises";
import { FileImageRegistry, digestBytes, type ImageManifest } from "station-images";

// Operator-managed storage directory scoped to ONE tenant.
const registry = new FileImageRegistry("/var/lib/station/tenant-a/registry");
const bytes = await readFile("./dist/resize.mjs");
const manifest: ImageManifest = {
  format: "station.image/v1",
  protocol: "station.process/v1",
  name: "acme/media",
  version: "1.0.0",
  artifacts: [{
    platform: { os: "any", arch: "any" },
    runtime: "node", runtimeMajor: 20,
    digest: digestBytes(bytes), size: bytes.byteLength,
    entrypoint: "resize.mjs",
  }],
  exports: [{
    name: "resize", kind: "signal",
    inputSchema: { type: "object", required: ["width"], properties: { width: { type: "integer", minimum: 1 } } },
    outputSchema: { type: "object" },
    requiredEnv: ["MEDIA_TOKEN"], timeoutMs: 60000,
  }],
};
await registry.putBlob(bytes, manifest.artifacts[0].digest);
const image = await registry.publish(manifest);
await registry.setTag("acme/media", "latest", image.digest);
```

Every artifact must exist with its declared size/digest before publication. A name/version can never be overwritten. Tags can move; resolve a tag once and persist its returned digest before scheduling. Canonical manifest JSON includes pinned dependency identities. Unknown manifest fields and unsupported schema keywords fail validation, so a misspelled security property never silently disappears.

Native Linux artifacts declare `abi: "glibc"`, `"musl"`, or `"none"` for static linkage. Native artifacts must have matching 64-bit little-endian ELF, single-architecture 64-bit Mach-O, or PE format/architecture headers. Shell scripts and universal Mach-O files are rejected. Compatibility checks additionally use the operator-declared backend target and author-declared ABI; this package does not inspect every dynamic dependency or prove that native binaries are correctly built. Test artifacts on their actual target before activating them.

Dependencies use `dependencies: { alias: { image: "acme/other@sha256:<64 hex digits>", export: "other", kind: "signal" } }`. Only signals and broadcasts are triggerable dependencies. Publication validates each referenced image/export/kind. Beacons are managed instances rather than callable signal nodes.

The schema subset supports `type`, `properties`, `required`, boolean `additionalProperties`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, and `description`. It rejects `$ref`, regex patterns, union/composition and other unsupported keywords. Schemas can nest 16 levels; input JSON can nest 64. Errors identify the failed property but do not echo its value.

## Registry and Headquarters imports

`ImageRegistry` supplies shared validation and publication rules over independently configurable metadata and blob adapters. `FileImageRegistry` is its filesystem convenience wrapper and preserves the existing directory layout. Both provide:

- `putBlob(bytes, expectedDigest?)`, `getBlob(digest)`.
- `publish(manifest)`, `getManifest(digest)`, `resolve(reference)`, `list()`.
- `setTag(name, tag, digest)`, `validateDependencies(manifest)`.

References are a digest alone or `name@version`, `name@tag`, `name@sha256:…`. Every read rechecks content integrity. Defaults limit a blob to 256 MiB, a manifest to 256 KiB, and all stored blobs to 2 GiB. `maxBlobBytes` and `maxTotalBytes` configure lower per-registry limits. Blob quota does not include manifests/metadata; operators also need filesystem quotas/retention for a public service. Publication is immutable and atomic. Unreferenced blobs/manifests from interrupted publication remain harmless but require operator retention tooling.

`importImage(destination, reference, source)` recursively copies the exact dependency closure and verifies its digests/sizes before publication. `source` supplies async `resolve(reference)` and `getBlob(digest)` methods. The transport must use an operator-approved fixed origin, authenticate tenant reads, bound response bodies before buffering, and apply its own timeout/cancellation. This library never follows a URL from an uploaded manifest. Imports do not execute or activate an image. A mutable tag is resolved only for that import; callers retain the returned digest.

Registry directories must be private and operator-owned. Sharing one `FileImageRegistry` across tenants without API authorization is unsafe. Registry upload admission uses a filesystem lock across processes; concurrent upload receives `registry_busy` and should retry. A crash can leave `upload.lock`; after confirming no publisher owns it, an operator removes the stale lock. No automatic process-identity guessing or garbage collection is performed.

### Storage adapters

```ts
import {
  ImageRegistry, FileRegistryMetadataAdapter, FileRegistryBlobAdapter,
} from "station-images";

const storage = {
  id: "production-images-v1", // Stable namespace identity, never a credential.
  metadata: new FileRegistryMetadataAdapter("/data/image-catalog"),
  blobs: new FileRegistryBlobAdapter("/data/image-artifacts"),
};
const registry = new ImageRegistry({ storage });
```

Built-ins are `FileRegistryMetadataAdapter`, `FileRegistryBlobAdapter`, `MemoryRegistryMetadataAdapter` and `MemoryRegistryBlobAdapter`. Memory adapters are volatile and share data only when clients reuse the same adapter instances. Mix the two layers independently. Custom providers implement `RegistryMetadataAdapter` and `RegistryBlobAdapter` from this package; PostgreSQL/S3 drivers are **not bundled**, and Station's existing queue database adapters do not implement these contracts.

Metadata adapters implement bounded `read`, atomic `create` for manifests/versions, atomic `writeTag`, and complete bounded `listVersions`. Blob adapters implement bounded `read` and atomic `create(digest, bytes, maxTotalBytes)`. Creation returns false when a key exists and must never overwrite it. Blob quota admission must be atomic across all writers to the same namespace; a process-local counter is insufficient for distributed storage. The shared registry checks schemas, digests, sizes, dependency closure, immutable version conflicts and committed manifests. Commit a version only after its manifest and blobs are readable; custom backends need read-after-write consistency. Interrupted publication may leave unreferenced objects, which must not become runnable manifests.

Daemon configuration accepts `registry.storage: storage` instead of `registry.rootDir`, plus optional `registry.cacheDir`. Custom registries stage verified artifacts and dependencies into a private local execution cache. Only its path and immutable identities enter child-process shims; adapter objects and storage credentials stay in the daemon. Pinned activations can recover offline from a complete cache, while moving tags resolve through the authoritative registry. Change `storage.id` when replacing a namespace: saved activations reject identity changes until explicitly reconciled. Adapter connection/client lifecycle is owned by the operator; Station does not close externally supplied clients.

## External signal protocol

A signal reads one newline-delimited JSON request from stdin and emits exactly one newline-delimited terminal frame to stdout. Logs go to stderr. It must exit successfully after emitting a result; a result followed by a nonzero exit is failure.

```json
{"protocol":"station.process/v1","type":"invoke","export":"resize","runId":"run-123","attempt":1,"input":{"width":800},"deadline":"2026-09-21T12:00:00Z"}
```

```json
{"protocol":"station.process/v1","type":"result","output":{"width":800}}
```

Or:

```json
{"protocol":"station.process/v1","type":"error","error":{"code":"invalid_source","message":"Source unavailable"}}
```

Minimal bundled JavaScript:

```js
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const output = { width: request.input.width };
  process.stdout.write(JSON.stringify({ protocol: "station.process/v1", type: "result", output }) + "\n");
});
```

Native Rust/Go/C programs use the same stdin/stdout contract and ordinary OS environment reads. Do not put secrets or database/lease credentials in protocol parameters.

`executeImage({ registry, reference, exportName, input, runId, attempt, backend, environment, signal })` runs one attempt, returning `{ image, exportName, output, stderr }`. It validates input before launch and signal output before returning. It bounds request/frame/output/log size, rejects extra terminal frames, and terminates the complete execution boundary on timeout/cancel. Application-provided error messages are not propagated to callers. Returned `stderr` is raw application content; the caller must apply redaction/access control before showing or storing it.

Default limits: 1 MiB frame, 4 MiB stdout, 64 KiB stderr and 60-second invocation. Configure `maxFrameBytes`, `maxOutputBytes`, `maxStderrBytes`, `timeoutMs`; the manifest timeout is also enforced. Backend preparation has its own backend-controlled limits; the invocation deadline covers the running protocol exchange. Long-lived jobs should be beacons or use supervised rescheduling rather than holding an unlimited signal process.

## Environment grants

`environment` takes `allowedKeys`, `store`, `bindings`, `overrides`. Precedence is image non-secret defaults → resolved store values → deployment bindings → invocation overrides. **Every application key, including an image default, must be explicitly granted.** `requiredEnv` fails before launch when unavailable. No controller environment is inherited.

`resolveImageEnvironment()` is separately exported for adapters. It reuses Station env-key validation and additionally blocks host path/home/shell controls and all `STATION_*` variables. A trusted operator may supply a minimal `base` environment to that helper; invocation APIs do not expose arbitrary base overrides. Resolve secrets through the existing Station environment store; never persist plaintext grants inside manifests or run snapshots. Secret revision binding and audit records remain the caller's responsibility. Printing a secret from user code cannot be made safe by this protocol alone.

## Isolation backends

`ImageProcessBackend` declares its `isolation`, actual `target` and asynchronous `spawn(spec)`. A boundary exposes piped stdin/stdout/stderr, `exited`, `terminate(force)` and `dispose()`. Dispose must clean all descendants even when the initial process succeeds. Container/microVM adapters select fixed commands and enforce resource/network/storage policy outside uploaded code. There is no shell command interpolation.

`executeImage` and `startImageBeacon` require a container or VM by default. Set `requiredIsolation: "vm"` to demand a VM; a container cannot satisfy it.

`DockerImageProcessBackend` requires a preloaded, operator-reviewed Linux image pinned with `@sha256:…`. Its image must provide `/usr/bin/timeout` and the declared Node/Bun executable when used. It defaults to no network, a non-root UID/GID, read-only root, dropped capabilities, no-new-privileges, bounded CPU/memory/PIDs/tmpfs, and a read-only mount containing only the verified artifact. Application secrets are delivered through a private transient env file and never added to Docker command arguments. Container/image ancestry is validated and writable image volumes are rejected. Configure only trusted operator options, not manifest-supplied Docker flags. Explicit disposal removes the container; stopped-container journals can be reconciled. Run the independent `station-image-reaper` service described below for controller crashes and hostile workloads; an in-container timeout or a timer inside stationd alone is not sufficient orphan control. Docker is a shared-kernel boundary, not equivalent to a VM against adversarial tenants. If Docker globally uses an unconfined seccomp default, configure an operator-reviewed `seccompProfile` absolute JSON path. The backend requires a deny-default profile with explicit syscall names, snapshots it privately by content hash, and supplies it explicitly to every container. It never changes the host Docker default or silently disables syscall filtering.

For explicitly trusted development only:

```ts
const backend = new TrustedLocalProcessBackend({
  allowUnsafeHostExecution: true,
  target: { os: "darwin", arch: "arm64", abi: "none", runtimes: { node: 22 } },
});
// executeImage also requires requiredIsolation: "trusted-host".
```

This uses POSIX process groups and a minimal environment, but **it does not sandbox filesystem/network access or impose host CPU/memory quotas**. A hostile program can escape a process group. Never enable it for public uploaded code. Windows host execution is currently unsupported; Linux Docker/VM adapters are independent of this development backend. Runtime version declarations must match the reviewed executables/images; the library does not fetch runtimes.

## Independent host reaper

Each Docker invocation records a private, fsynced journal **before container creation** with its random container name, pinned operator image, root ownership hash, creation time and absolute expiry. Matching ownership and timestamps are also immutable container labels. `maxRuntimeMs` sets the maximum invocation lifetime (default 5 minutes; maximum 24 hours), starting before container preparation. This lifetime applies to beacon incarnations too; the supervising runner may restart them under its policy.

`DockerImageProcessBackend.reapExpired()` force-removes expired matching containers even when their Station controller has crashed. It checks the exact name, image, ownership label and timestamp labels, then removes by inspected container ID to avoid name-replacement races. Unexpired invocations are never terminated. Foreign containers, old journals without ownership metadata, missing/unreachable containers and any ambiguous state remain for operator review. The method does not need the old runtime image to remain cached and does not run uploaded artifacts. `reconcile()` separately removes only verified stopped containers, regardless of expiry.

For protection when stationd itself is gone, run the separately packaged executable from an independent host service:

```sh
station-image-reaper --config /etc/station/image-reaper.json --once
station-image-reaper --config /etc/station/image-reaper.json --interval-ms 5000
```

The JSON file contains the **same operator `DockerImageOptions`** as the daemon: image digest, absolute rootDir, actual target, and explicit socketPath/executable if configured. It contains no application secrets. Files must be regular, bounded and not writable by group or others; symlink configuration files are rejected. Unknown configuration keys are rejected. `--once` prints aggregate removal/retention counts; loop mode prints removals and responds to SIGINT/SIGTERM. No daemon, registry server, image manifest or tenant API token is required.

Example systemd unit for a host where the executable is installed at `/usr/local/bin/station-image-reaper`:

```ini
[Unit]
Description=Station image invocation expiry reaper
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

The service needs operator access to the same Docker engine and staging directory. Run a reaper for every active execution policy; when rotating an operator image, keep the old policy's reaper until its journals are drained. Reaping happens after expiry plus polling/engine latency, not at an exact real-time deadline. Host/Docker outages delay cleanup; monitor retained expired journals. In-process daemon reaping is useful housekeeping but does not replace this independent service. Legacy unverifiable journals require explicit operator reconciliation and are never guessed safe to delete.

## Broadcast planners

A `kind: "broadcast", planner: "binary"` export uses the same invocation contract. Its terminal output is a declarative plan:

```json
{"nodes":[{"name":"resize","signalName":"resize","dependsOn":[],"input":{"kind":"ref","path":["input"]}}],"failurePolicy":"fail-fast"}
```

The validator checks bounded node counts, unique node names, cycles, missing dependencies, allowed signal references and structural expression ASTs. `signalName` selects a signal in this image or a declared dependency alias. Input/guard expressions support existing `ref`, `lit`, `obj`, `arr`, `tmpl`, `op` forms; references can access input and declared upstream nodes. Nested broadcast nodes are not supported. The daemon resolves aliases to pinned runnable identities, validates schema compatibility, **persists the exact plan before any child runs**, and passes it to BroadcastRunner. Executing a planner alone does not execute its children. Planners must avoid business side effects because an interrupted planning attempt can repeat.

## Long-lived beacons

`startImageBeacon()` runs a distinct lifecycle, returning `{ image, ready, done, poll(id?), stop() }`. Options include config, instanceId, incarnation, readiness/heartbeat/poll/stop timeouts, `onEvent`, and a brokered `trigger` callback. BeaconRunner retains durable intent, leases, restart policy and cadence. The session never schedules its own polls. Only one poll may be outstanding.

Controller requests:

- `beacon:init` with export, instanceId, incarnation, config and mode.
- `beacon:poll` with invocationId for poll-mode beacons.
- `beacon:stop` with shutdown deadline.

Process events:

- `beacon:started`, then `beacon:ready`.
- `beacon:heartbeat` before the health deadline.
- `beacon:poll-completed` or `beacon:poll-failed` with matching invocationId; a failure includes bounded `error` text.
- `beacon:stopped`, then successful process exit after a requested stop.

All frames include `protocol: "station.process/v1"`. Logs use stderr. Protocol and stderr bytes have per-minute budgets for long-lived processes. Exit without a stop acknowledgement, malformed frames, missed health/poll deadlines and cancelled ownership fail the incarnation and terminate its boundary.

A beacon can emit `trigger` with `id`, `dependency` alias and JSON `input`. Only declared signal/broadcast dependencies are admitted. The callback receives the immutable dependency plus instance/incarnation identity and returns a runId; the supervisor replies `trigger:result` or a safe `trigger:error`. In-memory retries reuse the same promise and reject conflicting input. **The daemon callback must validate dependency input and persist admission idempotency under its ownership fence**; in-memory dedup does not survive restart or guarantee exactly-once side effects. Max 16 concurrent trigger requests and 10000 retained request identities per incarnation keep the broker bounded.

`BeaconProtocolState` is also exported for custom supervisors. Environment changes require a new incarnation; process memory is not restored.

## Verification and scope

`pnpm --filter station-images test` exercises publication/import integrity, schema and environment grants, native C and JavaScript execution, protocol failures, cancellation/deadlines, planner DAG validation, beacon lifecycle and Docker engine contract tests. Native testing requires a C compiler. The default suite uses a fake Docker engine to check strict policy, journals and independent reaping. The separate `test/docker.integration.ts` suite has also been exercised against real Linux Docker with a digest-pinned Node 22 image and an explicit reviewed Moby seccomp profile: JavaScript and native Go image execution, non-root/read-only/cgroup/seccomp/network isolation, environment grants and timeout cleanup passed. No paid browser provider is needed.

Opt in to real Docker checks with `STATION_IMAGE_DOCKER_IMAGE=repo@sha256:…`, optionally `STATION_IMAGE_DOCKER_SOCKET`, `STATION_IMAGE_DOCKER_SECCOMP`, and `STATION_IMAGE_DOCKER_NATIVE`, then run `node --import tsx --test packages/station-images/test/docker.integration.ts`. The native fixture source is `test/fixtures/docker-native.go`; cross-compile it for the configured Linux architecture with `CGO_ENABLED=0`. Images and seccomp policy are operator-prepared inputs; tests never weaken Docker host settings.

This library does not implement a compiler, tenant billing, signature/provenance trust, registry retention/GC, artifact-media broker, microVM backend or cluster ownership. It supports those as daemon/backend responsibilities rather than silently claiming that a local process launcher provides them.

## Resumable uploads

`ImageUploadManager` stages bounded, digest-verified chunks before committing the
complete artifact through `ImageRegistry.putBlob()`. `ImageUploadStorage` is a
separate adapter contract: it must serialize each callback across every client of
one staging namespace and persist each write before resolving. The callback does
not promise rollback; immutable chunk writes and final registry commits are
recoverable when a later metadata write fails. `FileImageUploadStorage` supplies
single-host durable staging, and `MemoryImageUploadStorage` is deliberately
volatile. Distributed deployments must supply a shared transactional/locking
adapter; separate in-memory adapters do not coordinate.

```ts
import { FileImageUploadStorage, ImageUploadManager, digestBytes } from "station-images";
const uploads = new ImageUploadManager({
  registry,
  storage: new FileImageUploadStorage("/data/station/upload-staging"),
  maxChunkBytes: 1024 * 1024,
  maxUploads: 64,
  maxStagedBytes: 512 * 1024 * 1024,
  ttlMs: 3_600_000,
});
const blob = Buffer.from("compiled artifact bytes");
const upload = await uploads.create(digestBytes(blob), blob.length);
await uploads.append(upload.id, 0, blob, digestBytes(blob));
await uploads.commit(upload.id);
await uploads.cancel(upload.id); // Release staging; the immutable registry blob remains.
```

A create reserves the entire declared size. Fixed expiry is not extended by
activity. Completed uploads retain their reservation and chunks until cancellation
or expiry so an interrupted response can be retried; `sweep()` deletes expired
staging, and creation also sweeps before quota admission. Metadata, temporary-file
and filesystem overhead require operator disk capacity beyond the byte reservation.
The file adapter synchronizes data and directories, rejects symlinks, uses atomic
metadata replacement, and serializes local processes with an exclusive lock. A
process killed while holding that lock requires operator recovery: confirm no owner
is active, inspect any incomplete temporary files/metadata, then remove the stale
lock. It never guesses that a live controller is dead.

The authenticated daemon upload contract is:

- `POST /api/v1/registry/uploads` with `{ "digest": "sha256:…", "size": 123 }`.
- `GET /api/v1/registry/uploads/:id` returns the durable offset and fixed expiry.
- `PATCH /api/v1/registry/uploads/:id` sends raw chunk bytes, `Upload-Offset`, and
  `X-Chunk-SHA256` (the complete `sha256:…` chunk digest). Identical chunk retries
  are idempotent; overlapping or out-of-order writes return a conflict.
- `POST /api/v1/registry/uploads/:id/commit` verifies the complete SHA-256 digest
  and performs an idempotent immutable blob commit.
- `DELETE /api/v1/registry/uploads/:id` cancels/releases staging idempotently.

Responses are private/noncacheable; `Upload-Max-Chunk-Bytes` advertises the server
chunk limit. These routes require operator authorization. An upload ID alone never
grants artifact access. Uploading a blob neither publishes a manifest nor activates
or executes code. All staging records are bound to the final registry namespace.
