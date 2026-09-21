# Station Images and registry

Status: **partially implemented for the coordinated Station 3.0.0 breaking release**. This document retains the broader design and acceptance targets; it is not a list of shipped guarantees. Use [Station 3](../STATION-3.md) and [Station Images](../STATION-IMAGES.md) for the implemented configuration and APIs. No compatibility window or legacy StationKit runtime facade is shipped.

### Implemented slice and remaining contract

The coordinated 3.0.0 split is implemented: `station-daemon`, `station-runtime-cli`, `station-dashboard` and `station-client`, without a maintained `station-kit` facade. Images support native and bundled-JavaScript signals, binary broadcast planners and beacons, pluggable metadata/blob storage, authenticated publication, resumable uploads, isolated tenant registry namespaces/grants, operator-configured private registry targets, staged immutable deployment generations, environment references, activation/rollback/drain and generation-preserving invocation. Workers support eager catalogs or on-demand finite-run preparation reservations. The CLI offers offline artifact preparation, contexts, lifecycle management, execution/file/PTY commands and an interactive resource/detail TUI. The dashboard has nested image/version/export and deployment/generation pages. Docker execution includes an independent expiry reaper.

Implemented follow-through now includes dedicated tenant worker lifecycle routing, single-use enrollment with active daemon admission/revocation, resumable dashboard publication/private registry selection/environment bindings, replay-aware TUI reconnect, revision-pinned ordinary Station signal grants for compiled planners, audited per-invocation deployment binding generations and explicit stop-before-replace beacon rollout. Invocation artifact scopes use static digest/export grants, bounded file storage and a chunked process broker. Actual SQLite SIGKILL tests cover saved-plan continuation and preparation reservation expiry/takeover.

The full plan is **not a blanket public multi-tenant production guarantee**. Invocation artifacts have no HTTP media ingress/egress or automatic cross-worker transfer/authorization; storage is operator-owned and explicitly shared where needed. Environment references resolve current scoped values per attempt rather than versioned secret snapshots. Native Docker beacon lifecycle now passes a real engine fixture; broader production-adapter/host acceptance remains tracked separately. The user explicitly skipped unavailable Linux staging; no production host is being provisioned. The coordinated release dry run passed for all 20 packages; later CLI changes passed their own build, typecheck and 35-test suite. See the [numbered acceptance map](../STATION-IMAGES-ACCEPTANCE.md) for precise evidence and gaps.

Five real Docker tests passed on Docker Desktop 27.5.1’s Linux arm64 engine, and the registry/deployment dashboard passed a real Chromium flow against a deterministic API fixture. Neither establishes all production-host or tenant guarantees. The coordinated release preflight passed without skipping checks; final incremental packaging is recorded in the acceptance map. npm publication and StationKit deprecation remain explicit release operations. Later design examples must be checked against the current CLI help and image operations guide; context creation is not network enrollment, and no VM backend is claimed.

## Objective

Compile independently authored programs into Station-compatible images, register immutable versions, make them runnable across a Headquarters network or on a chosen Station, and expose their signals, broadcasts and beacons to the existing scheduling and composition system. Authors should not need to implement their business logic with the Station TypeScript builders. They must implement a versioned Station execution protocol, directly or through a small language SDK/wrapper.

**Signals, broadcasts and beacons** are executable exports in the first format. Schedules and other primitives can reference those exports without becoming additional executable image kinds. An image is a package of code and metadata, not an operating-system image or an isolation boundary.

## Separate the four concerns

- **Image:** immutable manifest, platform-specific executable artifacts, schemas and pinned dependency references.
- **Registry:** each enabled Station can expose a registry API that stores manifests/artifact blobs, resolves human-readable versions or tags, and enforces publishing/reading grants. Headquarters also hosts a network registry whose images are available to eligible member Stations, and can separately proxy operations to a chosen private Station registry. Recording a reference never executes it.
- **Deployment:** binds an exact image digest and export aliases either to a network execution policy or to a specific Station. Staging, verification and activation are separate states; only activated exports are runnable.
- **Execution:** the Station runner starts the selected artifact with parameters, records the run and returns its result through existing Station APIs.

A Station registry and that Station's installation cache have different responsibilities, even when they share a machine or deduplicate the same blobs. A registry entry can exist without being installed anywhere. The target Station must advertise the exact installed image digest and exports, not merely a matching signal name.

Proposed flow:

    author code → compile/package → publish to Station registry → install/activate
                                                       ↓
    beacon / schedule / broadcast / API → resolved export → run or beacon instance
                                                       ↓
                                     compatible isolated process → result

## Proposed format

Use a manifest plus content-addressed blobs. Start with one entrypoint artifact per platform and multiple named exports; the protocol selects the requested export. Packaging a blob must not import or execute it in Headquarters. Registry URLs identify controlled storage, not arbitrary URLs submitted for the worker to fetch.

Illustrative manifest (field names are proposed):

```json
{
  "format": "station.image/v1",
  "name": "acme/media-tools",
  "version": "1.0.0",
  "protocol": "station.process/v1",
  "artifacts": [
    {
      "platform": { "os": "linux", "arch": "amd64", "abi": "musl" },
      "runtime": "native",
      "digest": "sha256:<artifact-digest>",
      "size": 123456,
      "entrypoint": "media-tools"
    }
  ],
  "exports": [
    {
      "name": "resize-image",
      "kind": "signal",
      "inputSchema": {
        "type": "object",
        "required": ["source", "width"],
        "properties": {
          "source": { "type": "string" },
          "width": { "type": "integer", "minimum": 1 }
        },
        "additionalProperties": false
      },
      "outputSchema": { "type": "object" },
      "timeoutMs": 60000
    },
    {
      "name": "prepare-media",
      "kind": "broadcast",
      "planner": "binary",
      "inputSchema": { "type": "object" },
      "outputSchema": { "type": "object" }
    },
    {
      "name": "watch-media",
      "kind": "beacon",
      "mode": "poll",
      "configSchema": { "type": "object" },
      "pollIntervalMs": 5000,
      "startMode": "on-demand",
      "requiredEnv": ["MEDIA_API_TOKEN"]
    }
  ],
  "dependencies": {
    "store-media": {
      "image": "acme/storage@sha256:<dependency-image-digest>",
      "export": "store-media",
      "kind": "signal"
    }
  }
}
```

The image digest covers a canonical manifest including artifact and dependency digests. Published versions are immutable. Mutable tags are resolved once when a deployment or run is created; active work never follows a moving tag. An artifact may be a native executable or a bundled JavaScript entrypoint with a declared Node/Bun runtime requirement. JavaScript bundles remain server artifacts; they are not automatically compatible with `station-browser` service workers.

A native executable is platform-specific. Validate OS, architecture, ABI/dynamic dependencies and protocol version before activation. A Bun standalone executable follows the native artifact path. The packer records compatibility; it does not magically cross-compile arbitrary programs. Language-specific build recipes compile source before packing. Reject unsupported targets explicitly instead of falling back to another runtime.

## Process protocol and parameters

Avoid requiring Node's proprietary child-process IPC for external programs. Use versioned newline-delimited JSON on stdin/stdout, stderr for bounded logs, and no shell interpolation. The launcher selects an approved entrypoint and fixed argument vector. Business parameters are passed in JSON, not spliced into a shell command or printed in logs.

Example request:

```json
{"protocol":"station.process/v1","type":"invoke","export":"resize-image","runId":"run-123","attempt":1,"input":{"source":"artifact:photo-123","width":800},"deadline":"2026-09-21T12:00:00Z"}
```

Example response:

```json
{"protocol":"station.process/v1","type":"result","output":{"artifactId":"photo-resized-123"}}
```

Signal invocations and broadcast planning use one request per process initially. Require exactly one terminal result/error, bounded frames/output and a consistent process exit status. A result followed by a nonzero exit is not success. Validate schemas at enqueue and completion. Nonzero exit, malformed protocol, duplicate terminal output, excessive output and incompatible version must produce distinct safe failures. Keep raw stderr subject to existing log limits and redaction policy.

Provide run/attempt identity and deadline; do not give an executable database credentials or a raw lease token merely to report completion. The supervisor alone writes run state under its lease. On cancellation or lease loss, terminate the entire execution boundary with bounded grace, then force-stop it. Retry policy remains Station-owned. Side effects are at-least-once unless the application uses idempotency; this format does not promise exactly-once effects.

Input/output carry artifact references for large files. A broker resolves only references granted to that invocation. Uploaded binaries and user media are different artifact classes. Secrets are operator-managed grants resolved at execution time, never baked into registry manifests or image blobs.

## Environment variables and secrets

Environment-variable passing is part of the execution contract for **all three image kinds**, whether the artifact is native or bundled JavaScript. Code must be able to use ordinary environment reads such as `process.env`, `os.Getenv` or `std::env::var`; JSON business parameters remain separate from environment configuration.

The manifest declares required variable names and optional non-secret defaults, never secret values. Reuse Station's environment store and scope resolution rather than adding an unrelated secret store. A deployment binds permitted variables/secret references to its exports. The launcher resolves the authorized effective environment before user code starts, validates required keys and schema constraints, and rejects missing requirements before spawn.

Proposed precedence, from lowest to highest: non-secret image defaults → authorized Station environment-store values resolved with existing scopes → deployment bindings → explicit permitted invocation overrides. Operator-owned control variables are never overridable. When implementing, preserve the environment store's existing scope precedence within its layer and reject ambiguous bindings rather than silently widening a grant.

Do not inherit the controller's complete environment. Construct a minimal operator-controlled execution environment, then add approved application variables. Reuse reserved-key checks for loader/process-control variables such as `NODE_OPTIONS`, `LD_PRELOAD` and worker control credentials. CLI/API overrides can only set keys allowed by deployment policy; they cannot add arbitrary secret-store access.

- **Signals:** inject at attempt start; record non-secret binding revision metadata so later attempts' configuration is auditable. Define whether retries pin a secret revision or resolve its latest value; default to a pinned revision where the secret backend supports it, otherwise document late resolution explicitly.
- **Broadcasts:** inject into the planning process when needed. Child signals resolve their own grants; they do not inherit the planner's entire environment. Save the resulting plan independently of secret values.
- **Beacons:** inject at instance start/restart. An environment change does not rewrite a running process's environment; apply it with an explicit controlled restart. Keep instance config separate from environment secrets.

Bundled JavaScript may reuse Station's private bootstrap delivery before importing user code. Native programs that need standard environment variables receive them at exec. Native environment injection can be observable to privileged host processes; private IPC does not remove that fact. Enforce the tenant execution boundary, avoid plaintext secrets in process arguments/manifests, and redact API/TUI displays. Existing log redaction is not a guarantee against arbitrary user code printing secrets.

CLI inputs should support an env file and secret references; secret values should be read from stdin or a masked prompt rather than command-line arguments. Local env files are deployment inputs, not image contents. Never package `.env` automatically. A response may report key names, source and whether a value is set; returning the secret requires a separately authorized operation, not ordinary inspect.

## Beacons are long-lived supervised exports

Beacon images participate in the existing BeaconRunner lifecycle rather than being forced through a one-shot signal invocation. Support both `run` and `poll` modes, configured instances, readiness, heartbeats, graceful stop, restart policy and on-demand/automatic start intent.

The protocol has a long-lived beacon session alongside the one-shot signal/planner exchange:

- Controller → process: `beacon:init` with export, instance identity, incarnation, validated config and mode; `beacon:poll` with an invocation ID for supervisor-scheduled polls; `beacon:stop` with a shutdown deadline.
- Process → controller: `beacon:started`, `beacon:ready`, `beacon:heartbeat`, bounded log/error events, `beacon:poll-completed`/`beacon:poll-failed`, and `beacon:stopped`.
- For a poll beacon, Station owns cadence and non-overlap, supervises per-poll deadlines and correlates outcomes. A run beacon owns its work loop but must honor stop and health requirements. Process stdout remains protocol-only; ordinary logs go to stderr.

A beacon can request a declared signal or broadcast through a supervisor-mediated `trigger` request with a correlation/idempotency key. Resolve only the dependency grants pinned to that deployment and validate the input; return a run ID or a safe rejection. Do not put an unrestricted Headquarters API key into every beacon. Persist accepted trigger identity so a retry does not enqueue the same request twice. This is admission deduplication, not exactly-once downstream side effects.

Restarts retain durable instance intent/config and create a new incarnation; they do not restore arbitrary process memory. Enforce restart budgets, health deadlines, graceful stop then force-stop, and fence old incarnations on ownership loss. Exposure of a beacon service requires explicit operator-approved routing; a binary cannot publish an arbitrary host port merely by emitting an event. Persist instance-to-image identity and include active/desired beacon generations in artifact retention.

## Broadcasts are orchestration

A compiled broadcast must retain Station's DAG semantics, dependency tracking and recovery. Treating its executable as one opaque signal would hide its child work and is insufficient.

First implementation: a compiled broadcast export is a **planner**. Station invokes it in the same restricted execution backend with validated input. It returns a bounded declarative DAG referencing image exports and declared dependencies, with supported expressions for input mapping and guards. The controller validates the DAG without evaluating arbitrary code, resolves all references and persists that exact plan before dispatching any child signal.

The existing BroadcastRunner then owns dependencies, child run records, failures, deadlines and recovery. Retrying the broadcast resumes the saved plan instead of running the planner again. Planning must not itself send messages, upload application media or perform other business side effects: a lost planning result may require another planning attempt. Dependencies and mapped inputs must be validated before the corresponding child runs are admitted.

This lets a Rust, Go or JavaScript program produce a Station broadcast without importing Station's TypeScript builder. A packer can also store a validated static DAG directly, avoiding a planning process. Both represent the broadcast kind; the executable export whitelist is signal/broadcast/beacon.

Arbitrary long-lived imperative orchestration with bidirectional child-run commands, replay and durable checkpoints is a later protocol extension. Nested broadcasts also need explicit runner support; today's BroadcastNode represents a signal, so registry presence alone does not enable nested broadcast nodes.

## Composition and placement

Register all three export kinds in their respective definition catalogs, preserving their distinct lifecycle semantics. Installed signals are callable from broadcasts; installed signals and broadcasts can be triggered by schedules, beacons and APIs. Beacons expose managed instances with start/stop/restart, not ordinary one-shot run semantics. Schemas and policy must be visible without importing uploaded code. References resolve to image digest + export; local friendly aliases are deployment bindings.

For a deployment targeting Station A, constrain its executable work to Station A and install its required dependency closure there. If A is offline, runs wait or fail according to policy; do not silently move them to B. Network-scoped deployments from the Headquarters registry allow any eligible member Station, including workers that have not cached the image yet; the selected worker must stage and verify the required artifacts before executing. This is part of the initial design, not a later fleet-only extension. Existing definitions with the same name must not overwrite image exports silently.

Pin each run, broadcast plan and beacon instance incarnation to a deployment generation. An update activates a new generation for future runs; existing queued/running work retains its original digest and dependency closure. Beacons adopt a new generation only through an explicit controlled restart or rollout, never halfway through an incarnation. Rollback changes the active binding, not the meaning of an existing run or live incarnation. Garbage collection must retain all blobs referenced by queued work, active work or retained recovery plans.

## Headquarters registry: publish once, run across the network

Publishing to **Headquarters** makes an image discoverable and runnable by authorized callers on any compatible Station in that Headquarters network. Users do not have to publish or manually install it separately on each worker. Publishing to an individual Station remains a local registry operation; it is not silently promoted into the Headquarters catalog.

Registry location, execution placement and environment bindings are independent:

| Choice | Meaning |
| --- | --- |
| Publish to Headquarters | Store the image in the network registry; expose its exports to authorized network callers. |
| Run without a Station target | Place the invocation on any eligible network worker and fetch the pinned artifacts on demand. |
| Run with `--station worker-a` | Fetch from Headquarters if needed, but execute only on worker-a. |
| Publish to worker-a | Store in worker-a's registry; no automatic network-wide sharing. |

For network images, resolve the image/tag, export, dependency digests and execution policy before enqueueing work. The run record carries this identity even when no worker has downloaded the image. Worker eligibility must account for **installable** exports from the authorized network catalog as well as already-installed exports; today's name-only installed-definition matching would otherwise prevent the first run on a new worker.

The selected Station acquires a bounded preparation reservation, downloads missing blobs from Headquarters, verifies integrity/platform compatibility, installs the pinned dependency closure and acknowledges readiness. Only then may it begin execution under the run lease. Separate download/preparation deadlines from the program's execution timeout. Release failed reservations so another eligible worker can prepare an unpinned network invocation; do not start duplicate executions or ignore an explicit Station target. Cache verified blobs by digest, coalesce concurrent downloads and report preparing/downloading states in the API, CLI, TUI and dashboard.

Eligibility still requires the declared OS/architecture/runtime, tenant authorization, execution isolation, resource capacity, permitted network access and required environment bindings. "Any Station" means any member meeting those requirements; never attempt a Linux binary on an incompatible host or bypass tenant policy. New authorized workers discover the network catalog on joining, without republishing images. If none qualify, keep the work pending or return a clear placement error according to policy, with the unmet requirements.

Headquarters registry credentials and host environment do not travel with an image. Resolve the deployment's approved application variables and secret references on the chosen worker. Network-scoped bindings must be available through the authorized environment/secret service; a worker lacking a required binding is ineligible. Do not assume a variable set only on worker-a exists on worker-b.

Network broadcasts pin the planner image and all child export references. Their child signals may be placed on different eligible Stations under the broadcast's placement policy. Cross-worker inputs/outputs require durable shared artifacts, not local filesystem paths. If the caller pins the whole broadcast to one Station, propagate that constraint to its children. A network beacon has a leased owning Station per configured instance; publishing its image does not start one copy on every worker. Explicit replica/instance intent controls scale. Failover starts a new fenced incarnation on another eligible worker and requires its durable state/storage prerequisites; arbitrary process memory is not migrated.

Running work and cached images can continue through a registry outage only where their remaining coordination, lease, environment and artifact dependencies permit it. A cold worker cannot fetch missing blobs while Headquarters is unreachable. Registry availability does not replace the existing network control-plane availability requirements. Retain pinned versions and dependencies until queued runs, broadcast plans and beacon instance intent no longer reference them.

## Publish to a specific Station registry through an API

A Station or Headquarters can host its own authenticated registry endpoint. A Headquarters context defaults publishing to its network registry; an explicit `--station` selects that worker's registry. The CLI/SDK publishes to an explicit saved context or `--station` target; it must display the resolved server, Station ID and tenant before a mutation in interactive mode. In a private network, Headquarters proxies registry operations to the selected Station, preserving authorization and ownership. The storage destination remains explicit; selecting an execution target does not silently publish the binary elsewhere.

Publishing and activation remain independent even on the same Station. `push` uploads and commits an immutable image into that registry. `install` resolves it, checks execution compatibility and stages a deployment. `activate` changes its live bindings. An authorized invocation of a Headquarters image automatically creates a digest-pinned run/deployment binding and prepares its artifacts on the selected worker under network policy; it needs no separate per-worker activation command. Publishing alone never spawns processes. Explicit named deployment activation remains available for stable aliases, environment configuration and controlled rollouts.

Proposed API resources (not existing routes):

| Resource | Responsibility |
| --- | --- |
| Registry uploads | Initiate/resume a bounded upload; stream chunks; report received bytes; verify and commit a blob. |
| Registry images/versions/tags | Commit a manifest only after referenced blobs exist; list, inspect, resolve, authorize pull and manage mutable tags separately from immutable versions. |
| Network/Station deployments | Bind a digest and placement policy; stage on-demand on eligible workers or explicitly on one Station; validate environment bindings, activate a generation, report preparation errors, drain or roll back. |
| Runs | Invoke installed signal/broadcast exports with JSON parameters; inspect, cancel and follow events. |
| Beacon instances | Create with config/environment bindings, inspect, start, stop, restart and follow lifecycle events. |
| Environment bindings | Set non-secret values or secret references, inspect redacted metadata and request controlled restart where required. |
| Operations | Track long transfers/activations with operation IDs, progress and idempotency keys so reconnecting clients do not duplicate work. |

Separate read, publish, activate, invoke, environment-management and network-enrollment permissions. Authorization is enforced by the API even when a TUI hides a disabled action. Registries may be reachable directly or through Headquarters; use the same resource model so CI, the SDK, dashboard and CLI have consistent behavior. Cache credentials outside project manifests and redact credential-bearing URLs.

## Station CLI and TUI

Evolve the existing `station` command into the client CLI/TUI. The daemon is a separate executable/process, proposed as `stationd`, that can start independently of the CLI. The current command starts Station and supports `station deploy` for generating deployment files. Replace the old coupled-startup entry points in the major release without compatibility wrappers. Document the new explicit daemon/dashboard commands. Keep image deployment under an explicit namespace and move deployment-file generation to a clearly named client operation.

### Client and daemon boundary

- **Daemon (`station-daemon` package, `stationd` executable):** owns the Station/Headquarters role, registry, scheduler, network membership, execution managers, leases, durable state, logs and authenticated API. It runs independently as a service or foreground server process and can be supervised by the host service manager or container platform.
- **CLI (`station`):** performs client operations over the daemon API. It stores client contexts/credentials and formats responses. It does not own worker heartbeats, browser sessions, running jobs or beacon supervision.
- **TUI (`station tui`):** another client view with live subscriptions. Closing it disconnects that client; it does not stop the daemon or execution resources.
- **Dashboard:** a separately started application, not part of the daemon lifecycle or mandatory StationKit runtime bundle. It connects to local or remote daemons through the same authenticated API.
- **SDK:** the shared typed API client used by CLI/TUI/dashboard integrations. A daemon requires none of these clients to stay connected.

The CLI can bootstrap a local daemon with `station daemon start`, then connect after a health/version handshake. `station up` may remain a convenience alias for this operation. The default client start command launches a separate, detached daemon and returns once ready. Run `stationd --config ...` directly for a foreground server under a service manager; an optional CLI attach/follow mode streams logs without becoming the daemon or implicitly stopping it on disconnect.

Separate local lifecycle management from remote API control. `station daemon start --instance worker` starts on the local machine using that instance's configuration/data directory; changing the client context does not spawn a process on a remote host. Remote provisioning requires its own explicitly supported mechanism. `station daemon stop` is an explicit local lifecycle operation with graceful drain/force semantics; it must not be confused with stopping a beacon, browser or sandbox. A read-only client operation should report an unavailable daemon instead of silently starting one.

Track owned local instances with a locked state directory, stable instance identity, endpoint and verified process/service identity. Make start idempotent, detect port/data-directory conflicts, check protocol compatibility, and never stop an unrelated process based solely on a stale PID. Persist daemon logs/state independently of terminal output. Client exit or Ctrl-C during startup must leave an inspectable startup outcome; use `daemon status` to reconcile before another launch.

CLI-initiated terminal sessions, jobs and file operations retain their documented detach/cancel behavior. Exiting a human-control view releases its lease; expiry handles crashed clients. Closing the CLI never implicitly shuts down the daemon or stops all work. The daemon still enforces its configured idle timeouts, retention, resource limits and shutdown policy.

### Independent dashboard and remote connections

Split the current StationKit runtime/dashboard coupling. A headless Station or Headquarters must be installable and runnable without Next.js, dashboard static assets, a dashboard build, or a UI process. The CLI can launch the dashboard separately when requested; starting the daemon does not implicitly start the dashboard or open a browser. The dashboard must also be directly deployable without using the CLI.

Proposed component boundaries (`station-daemon` is the designated runtime package; new client/UI package names can be finalized during extraction):

| Component | Responsibility and dependency boundary |
| --- | --- |
| `station-daemon` | Canonical configuration, composition, runners, execution managers, environment store integration, network coordination, authenticated HTTP/WebSocket/event APIs and the `stationd` executable. Headless, with no UI dependency. |
| `station-kit` | Retired/deprecated at the 3.0.0 cutover; removed from the maintained workspace and release set. No facade, compatibility re-exports or replacement umbrella package. |
| `station-client` | Versioned API schemas/client, authentication, capabilities, event subscriptions and safe error handling. No daemon or UI dependency. |
| `station-runtime-cli` | `station` commands and TUI; optional local daemon/dashboard process management. Ordinary remote commands do not load or start the server runtime. |
| `station-dashboard` | Independently built/started web application using the daemon API, optionally with its own authenticated server-side API gateway. No scheduler or worker execution ownership. |

Local and remote daemons have the same API contract. A saved client context identifies endpoint, credentials, tenant and expected server identity; it is not proof that the server is running locally. CLI, TUI and dashboard can select a local Station, remote Station or remote Headquarters. Through Headquarters they reach authorized private workers without exposing every worker publicly. Connecting to a remote daemon does not enroll the client as a worker or start another daemon.

Examples of the proposed interface:

```sh
# Connect to an already-running remote Headquarters.
station context add production --url https://hq.example.com --token-stdin
station ps --context production
station tui --context production

# Start only a local dashboard process, viewing that remote daemon.
station dashboard start --context production --port 4401 --open
station dashboard status
station dashboard stop

# A local daemon and a local dashboard are separate start operations.
station daemon start --instance local --config ./station.config.ts
station context add local --url http://127.0.0.1:4400 --token-stdin
station dashboard start --context local --port 4401 --open
```

`dashboard start` waits for UI readiness and an API compatibility/authentication check, then returns a URL. Report a running UI with an unreachable daemon accurately; do not report a healthy Station just because the web server started. Pin each dashboard connection to its resolved context; another shell changing its active context must not silently retarget open pages or operations. Switching connections explicitly clears resource selection, unsubscribes old streams and releases human leases before showing the new target. A hosted dashboard can manage its own server-side connection store rather than assuming it can read the user's CLI credentials.

The default CLI-launched dashboard binds to loopback. For a remote target, use an authenticated dashboard gateway or an explicitly configured browser-to-daemon flow; do not assume cross-origin browser access works automatically. Keep long-lived daemon credentials in the client/credential store or dashboard server, not query strings or shipped frontend bundles. A gateway must enforce its own user authentication, origin/CSRF controls and fixed authorized target configuration; it must not become an arbitrary URL proxy. Remote endpoints use authenticated TLS connections. Separately hosted/shared dashboards require explicit deployment and access configuration.

Stopping the dashboard leaves the daemon and workloads running; stopping a local daemon leaves its dashboard open with an offline/reconnect state. SSH or service-manager provisioning of a remote daemon is a separate capability from connecting to its API. Support independent release/version negotiation, capability discovery and clear incompatibility errors across clients and servers.

The major release deliberately breaks `station-kit` imports and coupled-startup behavior. Update consumers to the replacement packages and document the new imports/configuration/commands in the release notes. Do not ship a transitional compatibility installer; runtime-only installations must not pull in the dashboard. Remove the daemon's mandatory Next.js proxy/startup path once the standalone dashboard is wired to authenticated APIs.

### Coordinated major release: retire StationKit without a transition window

Release the maintained Station package family together as **3.0.0**, including existing primitives, adapters and the new daemon/client/CLI/dashboard packages. The current workspace line is 2.x. Align maintained package versions, workspace/peer dependency ranges, lockfile entries, examples, documentation and the explicit release inventory with the new major. Retired `station-kit` is excluded from the new release set; no compatibility version of it is published.

At the cutover:

1. All code uses the replacement package imports, API contracts and commands. Remove StationKit's workspace package after moving its implementation, tests and assets to the proper owners.
2. Publish the validated 3.0.0 packages in dependency order. Deprecate existing `station-kit` npm releases with a message naming their replacements, as part of that release operation. There is no overlapping support window, facade, re-export shim or legacy bin forwarding.
3. Publish breaking-change notes covering imports, configuration, commands, API/protocol versions and storage upgrade requirements. These are upgrade instructions, not a promise to keep old interfaces working.
4. End StationKit maintenance at cutover. Existing published versions remain downloadable; do not unpublish them or erase user data.

Use explicit protocol/version negotiation. Old clients/daemons that cannot speak the new contract receive a clear incompatible-version error rather than an automatic legacy mode. A major version bump authorizes interface changes, not destructive data handling: define backup, storage upgrade and rollback behavior, or reject incompatible storage with a clear error. Do not silently reinterpret existing run/instance data.

This is the release design only: editing this plan does not bump package manifests, publish packages or apply npm deprecations before implementation and validation are complete.

### Rethinking StationKit: extract the daemon, not another launcher

The current implementation couples packaging and lifecycle in concrete places:

- `packages/station-kit/package.json` owns the `station` binary, React/Next.js dependencies and a build that runs both TypeScript and Next.js, then packages `.next/standalone`.
- `src/cli-main.ts` loads configuration, starts the Next.js child on the API port plus one, waits for it, starts `createStation`, optionally opens a browser and shuts down both processes together.
- `src/server/index.ts` owns runtime composition and the Hono/control server, while accepting `nextPort` and proxying non-API traffic to the local dashboard.
- `src/config/schema.ts` mixes daemon configuration with UI behavior such as `open`, and references daemon-owned auth/logging adapter types.

Putting a `station-daemon` name around that same coupled launcher would not achieve the separation. Move the runtime responsibilities into the new package, then remove its mandatory dashboard dependency and process lifecycle coupling.

**Ownership after extraction:**

| Existing responsibility | New owner |
| --- | --- |
| `createStation`, configuration schema/loader, data-directory resolution | `station-daemon` only; update all callers to the new imports |
| Signal/broadcast/beacon composition, schedules, network leases and registration | `station-daemon` using existing primitive packages |
| Sandbox and Browser Use manager hosting, tenant binding and execution routing | `station-daemon` using the existing execution packages |
| Auth/key storage, environment store wiring, log/event storage, API routes and WebSocket/SSE serving | `station-daemon`; these serve all clients, not just a dashboard |
| Role selection: standalone, Station or Headquarters | Daemon configuration; one daemon implementation supports all roles |
| Executable entrypoint and TypeScript application/config loading | `stationd` and daemon-owned bootstrap; remote CLI commands do not load user application modules |
| Next.js app, React/xterm components, UI build and static assets | `station-dashboard` |
| Saved contexts, API commands, TUI, local daemon/dashboard launchers, deployment-file generation | `station-runtime-cli` |
| Shared wire schemas, capability versions, API errors and typed transport | `station-client` initially, or a small independent contracts package if required to avoid dependency cycles |

The dependency direction is client → API contracts and daemon → API contracts + primitive packages. The dashboard/CLI must not import daemon implementation modules merely to obtain response types. The daemon must not import a dashboard or CLI launcher. Keep worker/controller runtime choices and individual execution adapters independent of this packaging split.

Move `open`/browser launching, dashboard port/host and UI process options into CLI/dashboard configuration. Daemon configuration retains API bind address, role, storage, runner settings, credentials, network membership and execution policy. Remove `nextPort` from the canonical daemon API after replacing the proxy coupling. Update every `station-kit/server` caller to `station-daemon` and remove the old `nextPort` argument. Document this as a breaking API change; do not retain or silently ignore the coupled-startup option.

**Extraction order:**

1. Move current server/configuration/storage code into `station-daemon` with an embeddable API and a foreground `stationd` entrypoint. Preserve `createStation` behavior and the existing role/runner semantics; add a focused headless startup/shutdown test first.
2. Introduce shared API contracts/client transport. Inventory existing dashboard-only endpoints and authentication assumptions; expose equivalent authorized operations without importing UI code into the daemon.
3. Move the Next.js application/build/assets into `station-dashboard`. Configure its API destination explicitly and validate local and remote daemon connections, authentication, streaming, uploads and human-control leases.
4. Move client commands/process management into `station-runtime-cli`. Its `station` entrypoint launches optional local daemon/dashboard packages via explicit commands or connects to an existing remote endpoint. Use a supported installed entrypoint, not a hardcoded monorepo `.next/standalone` path.
5. Remove the old StationKit workspace package after updating all callers. Prepare its npm deprecation for the coordinated major release and write breaking-change notes. No compatibility exports or duplicate runtime code.
6. Update workspace dependencies, examples, Docker/service entrypoints, documentation, package contents and the release script's explicit public-package list. Build/publish packages in dependency order and verify packed installations outside the monorepo.

Only `station-runtime-cli` owns the new `station` executable; `station-daemon` owns `stationd`. Remove the old workspace bin and document uninstalling an existing global StationKit installation before installing the new CLI to avoid a bin collision. No forwarding wrapper is shipped. The 3.0.0 release explicitly changes the old coupled no-argument startup behavior.

**Required separation tests:** daemon install/build/start without Next.js or React; no dashboard spawned by daemon startup; CLI/TUI exit does not stop it; dashboard shutdown does not stop work; remote CLI installation does not require daemon/UI dependencies; standalone daemon/dashboard packed installs work outside workspace paths; all existing runner, auth, tenant and execution tests still pass. Verify no maintained package/example imports `station-kit`, no compatibility facade/bin is packed, and removed coupled-startup options produce actionable errors. Validate all replacement packages as packed 3.0.0 installs.

The following commands illustrate the proposed UX; they are **not available yet**:

```sh
# Create configurations and launch separate local daemon instances.
station init ./headquarters --role headquarters
station daemon start --instance headquarters --config ./headquarters/station.config.ts
station init ./worker --role station
station daemon start --instance worker --config ./worker/station.config.ts
station daemon status --instance worker
station daemon logs --instance worker --follow

# Alternatively, a service manager can launch the daemon directly.
# Run this instead of daemon start for the same instance.
stationd --config ./worker/station.config.ts

# Save an API connection without putting a credential into shell history.
station context add production --url https://hq.example.com --token-stdin
station context use production
station context ls

# Enroll the local worker using an authorized, short-lived enrollment token.
station network join --headquarters https://hq.example.com --token-stdin
station network status
station network leave

# Publish once to the current Headquarters registry; execute anywhere eligible.
station image build . --tag acme/media-tools:1.0.0
station image push acme/media-tools:1.0.0
station run acme/media-tools:1.0.0#resize-image --input @resize.json
# Same Headquarters image, execution pinned to one worker.
station run acme/media-tools:1.0.0#resize-image --station media-worker --input @resize.json

# Alternatively publish to a worker-local registry, then deploy explicitly.
station image build . --tag acme/media-tools:1.0.0
station image push acme/media-tools:1.0.0 --station media-worker
station image ls --station media-worker
station image inspect acme/media-tools:1.0.0 --station media-worker
station image pull acme/media-tools:1.0.0 --station media-worker
station image install acme/media-tools:1.0.0 --station media-worker --env-file ./media.env
station deployment activate <deployment-id> --station media-worker
station deployment rollback <deployment-id> --station media-worker

# Invoke finite work, or manage long-lived beacon instances.
station run resize-image --station media-worker --input @resize.json
station run prepare-media --station media-worker --input @workflow.json
station beacon create watch-media --station media-worker --config @watch.json
station beacon start <instance-id> --station media-worker
station beacon logs <instance-id> --station media-worker --follow
station beacon stop <instance-id> --station media-worker
station logs <run-id> --station media-worker --follow

# Set configuration through the environment store; secrets arrive via stdin.
station env set MEDIA_API_TOKEN --secret --stdin --station media-worker
station ps --station media-worker
station daemon stop --instance worker
station tui
```

`context add` connects a client to an API; `network join` enrolls a running worker with Headquarters. They are distinct operations with different credentials and permissions. Starting a Station locally, registering its endpoint and configuring its execution runtime are also separate steps. Provide clear diagnostics for an unreachable endpoint, missing container runtime, expired enrollment or incompatible image rather than claiming a worker is ready prematurely. CLI startup launches an independent daemon; direct `stationd` invocation runs the server in the foreground for external supervision. Both use the same configuration and instance ownership rules.

All commands use the API/client layer and support stable `--json`, meaningful exit codes and non-interactive stdin/file inputs for automation. Interactive conveniences must not be required for CI. Pin the resolved context/target for an operation so switching contexts in another shell cannot redirect an in-flight upload.

The TUI is a view over those same resources and operations:

- A persistent header shows active context, Headquarters/Station identity, tenant and connection state.
- An overview lists Stations, roles, health, capacity, installed exports and work in progress.
- Nested views cover Registry → Image → Version → Exports; Station → Deployments → Runs/Beacon instances; environment bindings; Browser sessions and their tools; and sandbox/VM environments with files, terminals and services.
- Detail panes show live logs, run parameters with sensitive fields redacted, beacon readiness/restarts, upload progress, validation failures and activation history.
- Keyboard navigation, search/filter, a command palette, help, resize handling and reconnectable event cursors make it useful over SSH. Logs are bounded; a dropped stream cannot silently lose its place.
- Publishing, activation, stopping and rollback show their exact target and effect. Secrets use masked entry; copying/showing secrets is not a default action. Completed operations and failures remain visible rather than disappearing with a transient toast.

Keep the CLI useful without the TUI or dashboard running. Choose a TUI library after a small terminal interaction prototype; library choice must not determine the registry/protocol design.

## Full CLI coverage: Browser Use and sandbox/VM environments

The Station CLI is a complete API client, not only an image publisher. Every supported, authorized Browser Use and environment operation must be available without opening the web dashboard. The TUI presents the same operations interactively; scripts and agents use explicit commands or structured JSON. Maintain a checked operation-to-command coverage table so an API addition cannot silently become dashboard-only.

Browser Use and Sandbox remain separate primitives. **Environment** is the backend-neutral grouping for host, container and future OS-VM workspaces. Existing sandbox APIs cover host/container environments; a real VM backend and VM-specific operations still require implementation. Reuse `station sandbox` for the common workspace interface. A `station vm` command family may expose actual VM lifecycle operations when a VM adapter exists; it must not relabel a host directory or container as a hardware VM.

### Browser Use command coverage

| Command group | Required coverage |
| --- | --- |
| Sessions | Discover eligible workers/backends, list/open/inspect/close sessions, viewport and idle-timeout options, explicit owner selection. |
| Profiles | List available grants, select a profile on open, inspect supported status, delete only where supported and authorized. Provider profile provisioning remains operator-managed until a provisioning API exists. |
| Navigation and input | Navigate/back/forward/reload; click, fill, type, press, select, check/uncheck, focus, hover, scroll, wait, mouse movement/clicks and both forms of drag. Preserve semantic targets, frame scopes and explicit match indices. |
| Observation | DOM inspection, accessibility snapshots, HTML/content, evaluation, screenshots and page metadata. Sensitive output remains opt-in where the API requires it. |
| Pages and dialogs | List/create/select/close pages; arm supported dialog handling with bounded lifetime. |
| Live/human control | Read a live frame, open the dashboard live viewer, acquire/renew/release an authorized human control lease and show its expiry. Automation must not acquire a human lease to bypass challenge pauses. |
| Recording and diagnostics | Start/stop/list/inspect/delete screenshot recordings, retrieve frames and open playback; inspect console/network metadata, provider/reliability diagnostics and supported trace exports. |
| Recovery and audit | Create/list/inspect/delete/resume checkpoints; follow/read bounded audit history and report unknown outcomes. A checkpoint is not a saved live browser process. |
| Files | Upload a local file through validated bounded bytes, initiate supported downloads, retrieve/delete artifacts, and write screenshot/trace/download bytes to explicit local paths. |

Examples of the proposed interface:

```sh
station browser capabilities --station browser-worker --json
station browser open --station browser-worker --profile account-a
station browser ls --station browser-worker
station browser navigate <session-id> https://example.com
station browser inspect <session-id> --json
station browser click <session-id> --role button --name Continue --exact
station browser fill <session-id> --label Search --value station
station browser screenshot <session-id> --output ./screen.png
station browser pages <session-id> --json
station browser upload <session-id> --selector 'input[type=file]' --file ./sample.txt
station browser download <session-id> --selector '#download'
station browser artifact get <session-id> <artifact-id> --output ./download.bin
station browser recording start <session-id> --interval 5s
station browser live <session-id>
station browser checkpoint create <session-id>
station browser diagnostics <session-id> --json
station browser close <session-id>

# Typed structured access covers complex target/frame/drag commands without
# requiring a custom CLI flag for every field. The server still validates it.
station browser command <session-id> --input @browser-command.json
```

`station browser live` opens an authenticated viewer or supplies frames through an explicitly supported terminal display mode; a text-only terminal is not assumed to provide a graphical browser. The TUI should offer preview/open-viewer actions while retaining CLI control and screenshots. Do not expose API keys or provider CDP URLs in an open-viewer URL.

Current limitations remain visible in CLI help/capabilities: inline uploads have a 4 MiB decoded total limit; Steel/Browserbase downloads and trace export are not yet implemented; Bun has fewer commands than Playwright. "Full capability availability" means complete access to what the selected backend actually supports, with explicit unsupported errors and planned coverage for future APIs. It does not justify a silent switch to a different browser or claims that large video transfer already works.

### Sandbox and VM command coverage

| Command group | Required coverage |
| --- | --- |
| Environments | Discover backends, create/list/inspect/destroy workspaces, inspect limits/owner/storage and select supported backend options. |
| Commands | Execute with working directory, parameters, approved environment bindings and timeout; inspect/follow output, obtain the remote exit code, cancel and list execution history where supported. |
| Terminals | Open/list/attach/detach/read/write/resize/close PTYs, preserve bounded output offsets across reconnects, forward terminal resize and restore local terminal settings on all exits. |
| Files | List/paginate/read/write/remove; convenient local-to-remote and remote-to-local copy using bounded chunks, explicit overwrite handling and transfer progress. Directory/archive convenience must preserve traversal/symlink restrictions. |
| Services | Start/list/inspect/stop/restart/remove supervised services, follow logs/status and expose only endpoints authorized by the backend/network policy. |
| Tools and configuration | Execute package-manager/Git commands within the environment; upload inputs, inspect installed tools and use configured persistent storage. Environment/secret binding changes follow the same scope and restart rules as other execution. |
| VM extensions | When supported: boot/shutdown/reboot, serial/interactive console, snapshots/restore, volume/network inspection and attachment under operator policy. Suspend/resume and live-memory snapshots are capabilities, not universal guarantees. |

Proposed commands:

```sh
station sandbox capabilities --station coding-worker --json
station sandbox create --station coding-worker --backend container
station sandbox ls --station coding-worker
station sandbox exec <environment-id> --cwd repo -- git status --short
station sandbox shell <environment-id>
station sandbox terminal attach <environment-id> <terminal-id>
station sandbox files ls <environment-id> ./repo --json
station sandbox cp ./tool.tgz <environment-id>:tool.tgz
station sandbox exec <environment-id> -- npm install --global ./tool.tgz
station sandbox service start <environment-id> --name preview --command 'npm run dev'
station sandbox service logs <environment-id> preview --follow
station sandbox service stop <environment-id> preview
station sandbox destroy <environment-id>

# VM-specific operations are proposed for a real, advertised VM backend.
station vm create --station linux-worker --template agent-linux
station vm console <environment-id>
station vm snapshot create <environment-id>
station vm stop <environment-id>
```

Transfer paths after `<environment-id>:` are workspace-relative, never arbitrary host paths. Reject traversal and preserve the existing backend path restrictions; commands default to the workspace root unless `--cwd` is supplied. `exec -- program args...` requires a typed argv execution API; the existing sandbox string-command interface is not automatically equivalent. Extend the backend contract for argv/stdin/env support, or require explicit `--shell` for shell text. Never join untrusted argument values into shell commands. Package installation and Git remain normal commands subject to the environment's network and filesystem policy.

### Routing, output and operation semantics

Use the active context and resource ownership to route every operation through Headquarters to its owning worker. Resource references must retain context, tenant and owner; if ownership cannot be resolved unambiguously, require `--station`. Do not relocate an existing terminal or browser session merely because another worker has capacity. Creation may use network placement; subsequent operations remain bound to the resulting resource.

Support stdin/file input, stable JSON errors with codes, bounded pagination, cancellation, deadlines and reconnectable output cursors. Separate human progress on stderr from JSON/binary data on stdout. For an interactive command, Ctrl-C forwards an interrupt as specified by the terminal protocol; detaching leaves the remote process alive, whereas cancellation explicitly stops it. Non-interactive exec must expose the remote exit result separately from transport/authorization failure, with documented exit-code mapping. Disconnecting a client does not imply a process was cancelled.

A generic `station api` or typed `command --input` path can provide complete coverage while ergonomic subcommands are added, but it is not an authorization bypass. Use the same schema validation, tenant restrictions and capability checks. Credentials, human leases and secret values must not leak through shell history or ordinary output. Local file operations must report the destination and avoid silently overwriting existing files.

The TUI adds Browser → Session → Live/Pages/Profiles/Recordings/Diagnostics/Recovery and Environments → Workspace → Files/Terminal/Commands/Services views. A VM detail view adds only advertised VM operations. Show unsupported actions with an explanation rather than presenting controls that silently fail. An interactive shell and a browser viewer are explicit user-selected modes; leaving the TUI restores the terminal and releases any active human-control lease.

Acceptance: verify every advertised API operation through the CLI; test both human-readable and JSON modes, local and Headquarters-routed targets, denied tenant/unsupported backend operations, binary transfers, remote exit status, cancellation, Ctrl-C/detach, PTY resizing/reconnection, human lease expiry and partial-transfer recovery. Cover native platform limitations explicitly. The TUI must be a client of these tested operations rather than a separate execution path.

## Upload, installation and public tenants

Upload to a staging area with explicit size/quota limits; stream bytes and verify the declared digest and length. Never execute partially uploaded artifacts. Avoid archive extraction for the first single-artifact format; any later archive support must reject traversal, symlinks and special files.

Activation sequence:

1. Authorize the publisher, tenant, target Station and requested exports.
2. Resolve immutable manifest and dependencies; reject cycles/missing references.
3. Transfer missing blobs, verify integrity, validate manifest/schema/protocol/platform.
4. Check operator resource, secret, filesystem and network grants. An image can request capabilities but cannot grant them to itself.
5. Atomically activate the deployment generation and advertise its exports.

Public multi-tenant binaries must run through a verified isolation backend with tenant-scoped storage, resource limits and egress controls. Running them directly as child processes of Headquarters or a shared host worker is not an acceptable default. Reuse the container/sandbox execution work where its capabilities meet the protocol; extend it for safe argv/stdin/process supervision rather than smuggling arbitrary shell commands into it. A digest proves identity/integrity, not trust or safe behavior.

Compilation/builds that run user code also belong in an isolated build environment. The registry/control plane should remain metadata and transport only. Provision private per-tenant execution resources and expose only authorized operations through Headquarters.

## Current repository integration points

- `station-signal/src/signal-runner.ts`: registrations currently contain a module file path; dispatch uses Station's JavaScript bootstrap. Add a typed execution target instead of overloading a filename with an executable path.
- `station-signal/src/bootstrap.ts`: current Node/Bun module import and IPC path remains available for native Station applications. External process protocol requires a separate bridge.
- `station-signal/src/process-runtime.ts`: chooses Node/Bun for existing bootstraps. It is not a binary artifact registry or tenant isolation boundary.
- `station-broadcast/src/dynamic.ts`: materializes validated dynamic specs against a signal registry. Extend versioned reference resolution rather than inventing a second DAG scheduler.
- `station-broadcast/src/broadcast-runner.ts`: existing registration and durable orchestration provide the execution basis for image-backed plans.
- `station-beacon/src/bootstrap.ts` and `station-beacon/src/beacon-runner.ts`: bridge the external beacon protocol into existing supervised instances, scoped environment delivery, health, polling and restart behavior.
- `station-env`: reuse scope resolution and reserved-key validation for image execution bindings.
- `station-network/src/types.ts`: definition advertisements currently list names; add installed artifact/protocol/platform metadata and digest-aware placement.
- `station-kit` → `station-daemon`: extract canonical composition/configuration/server/auth/storage ownership and remove StationKit without compatibility exports. Add registry/deployment APIs to the daemon. Move UI assets/startup to `station-dashboard` and client commands to `station-runtime-cli`; existing broadcast-definition storage is not a binary blob registry.

Storage adapters must migrate run records to retain image/export/deployment identity consistently across memory, SQLite, PostgreSQL, MySQL and Redis where applicable. Name-only dispatch is not sufficient for safe updates.

## Implementation sequence and acceptance

0. Perform the daemon/client/dashboard package extraction above as the architectural prerequisite; verify the replacement runtime behavior and update all consumers before adding registry/image APIs to the daemon; no legacy-interface compatibility layer.
1. Specify/test the manifest and signal/planner/beacon process protocols, environment binding contract, compatibility rules, digest identity and dependency resolution. Ship independently authored native and bundled-JavaScript fixtures.
2. Implement Station-hosted registry metadata/blob adapters and authenticated APIs, then CLI packaging/publishing to a selected Station; test streaming/resume limits, integrity, tenant grants and uncertain upload recovery. Add Headquarters network catalog discovery and authorized blob retrieval for all member Stations.
3. Implement staged install/atomic activation on a selected Station and isolated signal execution. Add network eligibility, preparation reservations and automatic verified pulls on cold workers. Demonstrate JSON parameters, scoped environment/secret passing, output validation, cancellation and restart recovery.
4. Integrate the definition catalog and digest-pinned run storage. Demonstrate a schedule/beacon triggering an installed external signal and a native Station broadcast consuming it.
5. Implement compiled broadcast planning, saved-plan replay and pinned child references. Demonstrate external broadcast → native and external signals without re-running completed child work after recovery.
6. Add image-backed beacons with run/poll lifecycles, readiness/health, scoped triggers, controlled environment updates and image-generation rollouts.
7. Extend the separated daemon/client/dashboard packages with registry/image workflows, local/remote saved contexts and full CLI daemon/dashboard lifecycle management. Maintain independent installation/startup and API version negotiation. Extend CLI contexts, daemon lifecycle management and worker enrollment. Cover all Browser Use and sandbox operations with typed command/argv/file/streaming support; define VM capability extensions without claiming an implemented VM backend. Add the TUI and matching nested dashboard registry/deployment/beacon/browser/environment pages using the same APIs.
8. Document authoring, publishing, API integration, operations and breaking upgrade instructions. Apply the coordinated 3.0.0 bump across maintained packages and complete release dry-run/packed-install checks before publishing and deprecating StationKit.

End-to-end acceptance must prove: compile outside Station; publish; upload/install to a specified Station registry; invoke with parameters and authorized environment values; consume the export from another primitive; update without changing in-flight work; rollback; recover after worker restart; reject incompatible targets, corrupt uploads, tenant cross-access and disallowed execution capabilities. Also verify native and JavaScript beacon start/readiness/poll/stop/restart, retained incarnation identity, scoped triggering, missing/reserved env rejection, secret redaction, controlled rotation, CLI context targeting, authenticated enrollment and TUI reconnects. Prove that a single Headquarters publication runs on two compatible workers with empty caches, that a newly joined worker needs no republish, that dependency/environment grants resolve correctly, and that explicit placement, cross-tenant denial, preparation failure and beacon ownership survive failover. Verify that closing or killing CLI/TUI clients does not kill the daemon or its work, that direct daemon startup needs no CLI, and that repeated starts, stale PID files, daemon restarts and version mismatches are handled correctly. Verify a headless install/build without Next.js, independent dashboard startup/shutdown, CLI/TUI/dashboard access to a remote daemon, authenticated Headquarters routing to private workers, credential handling, context switching and reconnect/version errors. Test genuine isolated execution, not only mocked process launches.
