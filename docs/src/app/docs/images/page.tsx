import { Metadata } from "next";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Station Images and registry — Station",
  description: "Publish compiled native or bundled JavaScript signals, broadcast planners and beacons to an operator registry and execute them across a Station network.",
};

export default function ImagesPage() {
  return <>
    <div className="eyebrow">Compiled execution</div>
    <h2 style={{ marginTop: 0 }}>Station Images and registry</h2>
    <p>Station 3 accepts independently authored native executables and bundled JavaScript as signals, broadcast planners and beacons. An image is a manifest plus verified executable blobs. It is not an OCI filesystem image: isolation comes from the configured execution backend.</p>
    <p>Use the <a href="https://github.com/porkytheblack/station/blob/main/docs/STATION-IMAGES.md">complete authoring and operations guide</a> for a runnable manifest generator, all protocol fields, environment grants, Docker policy, independent cleanup and recovery.</p>
    <h3>Build the artifact</h3>
    <p>Compile native code for the target OS, architecture and ABI, or bundle JavaScript and its dependencies into a single file. Station does not install application dependencies or compile uploads. A manifest uses <code>station.image/v1</code>, artifact SHA-256 digests and byte counts, target declarations, and named exports of kind <code>signal</code>, <code>broadcast</code> or <code>beacon</code>.</p>
    <p>A finite signal receives an NDJSON invocation on stdin and returns a result on stdout. Parameters are structured JSON; stdout is reserved for the protocol.</p>
    <Code>{`// build/echo.mjs — no Station import required
let text = "";
for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
if (request.protocol !== "station.process/v1" || request.type !== "invoke") {
  throw new Error("Unsupported invocation");
}
console.log(JSON.stringify({
  protocol: "station.process/v1", type: "result",
  output: { input: request.input, prefix: process.env.APP_PREFIX ?? "" },
}));`}</Code>
    <p>The complete guide generates the manifest using the actual artifact bytes. A broadcast export returns a validated declarative DAG; its persisted plan invokes declared image signals or revision-pinned ordinary Station signals explicitly granted by the operator. A beacon remains connected over the supervised protocol and can request declared dependency invocations through a scoped broker.</p>
    <h3>Configure, publish and run</h3>
    <p>Configure <code>registry.rootDir</code> for storage and <code>registry.execution</code> for execution. Select an operator-owned Docker backend with a preinstalled digest-pinned Linux runtime image, matching target and bounded resource policy. Grant only the environment keys required by the exports. Controller credentials are not inherited. The trusted-local backend requires explicit opt-in and must only execute trusted code.</p>
    <Code>{`station context add local --url http://127.0.0.1:4400 --token-stdin
station context use local
station images publish ./station-image.json --artifacts-dir ./build
station images inspect acme/echo@1.0.0
station images install acme/echo@1.0.0
station images run acme/echo@1.0.0 echo --input '{"message":"hello"}'
station images tag acme/echo --tag stable --digest sha256:FULL_MANIFEST_DIGEST`}</Code>
    <p>Supply the operator admin token on stdin when adding the context. References are <code>name@version</code>, <code>name@tag</code> or immutable digests. Run returns a signal run, broadcast run or beacon instance ID; it does not wait for completion. Registry APIs live under <code>/api/v1/registry</code>: blob upload/read, image publish/list, resolve, tag, pull, install and run. The run body is <code>{"{reference, export, input, stationId?}"}</code>.</p>
    <h3>Publish once at Headquarters</h3>
    <p>Registry storage is adapter-based: <code>ImageRegistry</code> owns validation and immutable publication, with separate metadata and blob adapters. Configure <code>registry.storage</code> as <code>{"{ id, metadata, blobs }"}</code> instead of <code>rootDir</code>. File and memory adapters are built in; custom PostgreSQL/S3 providers implement <code>RegistryMetadataAdapter</code> and <code>RegistryBlobAdapter</code>. Those cloud drivers are not bundled. Custom providers must enforce atomic writes, bounded reads and shared blob quotas.</p>
    <p>Custom storage uses a verified local execution cache, optionally selected with <code>registry.cacheDir</code>. Adapter credentials stay in the daemon. Complete cached digest-pinned activations can recover offline, while moving tags still resolve at the authoritative registry. The storage ID identifies a namespace and must change when replacing it; it is not tenant authorization.</p>
    <p>Workers with a configured authenticated Headquarters upstream periodically import and verify compatible images and dependencies, install immutable definitions and advertise them. Shared durable queue and membership adapters still coordinate execution. Unsupported targets are skipped; corruption and permission failures stop the synchronization pass explicitly.</p>
    <Code>{`station images publish ./station-image.json --artifacts-dir ./build --context headquarters
station images run acme/echo@1.0.0 echo --input @request.json --context headquarters
# Optional immutable worker pin:
station images run acme/echo@1.0.0 echo --input @request.json --context headquarters --station coding-worker`}</Code>
    <p>Signal and broadcast pins persist through retries; broadcast planners and children stay on the selected worker. Headquarters can create shared beacon instance intent with a worker pin; eligible workers execute it. A worker-local context can also create the instance directly. Without a pin, eligible workers can claim work normally. A context selects an endpoint and does not itself pin execution.</p>
    <h3>Staged deployments and environment bindings</h3>
    <p>A deployment retains immutable generations: image digest, aliases, optional worker pin and environment bindings. Staging checks compatibility without activation. Activation and rollback change the pointer used by future alias invocations; existing runs and beacons keep their identities. Drain blocks new alias invocations without deleting retained work.</p>
    <Code>{`station deployments stage --json @generation.json
station deployments inspect DEPLOYMENT_ID
station deployments activate DEPLOYMENT_ID --json '{"generation":"GENERATION_ID","expectedRevision":1}'
station deployments run DEPLOYMENT_ID --json '{"alias":"echo","input":{"message":"hello"}}'
station deployments rollback DEPLOYMENT_ID --json '{"generation":"EARLIER_GENERATION_ID","expectedRevision":4}'
station deployments drain DEPLOYMENT_ID --json '{"expectedRevision":5}'`}</Code>
    <p>The stage body contains <code>{'{name,reference,aliases?,stationId?,bindings?,invocationEnv?}'}</code>. A binding is a persisted non-secret <code>{'{value:"production"}'}</code> or a store reference <code>{'{fromEnv:"API_TOKEN"}'}</code>. Both destination and source keys require operator grants. References resolve current scoped store values per attempt; they do not snapshot secret revisions. A staged <code>invocationEnv</code> allowlist can permit selected keys in an invocation’s <code>environment</code> bindings. Each override creates a retained derived generation and an <code>invoke</code> history entry without moving the active pointer. Use references for credentials; resolved secret values are not persisted. Refresh and review after a revision conflict.</p>
    <p>The dashboard nests Registry → image → version → export, and Deployments → generation. Publish, install, tags, invocation, staging, activation, rollback, drain and history each have focused views. Its binding editor accepts environment references or explicitly confirmed non-secret literals. A Registry Station selector keeps the chosen private target across links, breadcrumbs, publication and deployment pages; private image invocation is routed to and pinned on that worker.</p>
    <h3>Cold workers and private registries</h3>
    <p>Configure worker <code>registry.upstream.mode</code> as <code>on-demand</code> to advertise compatible finite exports without first downloading binaries. Separate network preparation reservations verify/import the image before an execution claim. <code>/api/v1/registry/preparations</code> reports a bounded local window of preparing, ready and failed observations. Images containing beacons remain eager because their reconciler has no cold-definition hook.</p>
    <p>Headquarters can configure <code>registry.targets</code> with fixed private worker URLs and credentials. Its <code>/api/v1/stations/:stationId/registry</code> proxy validates the worker identity and protocol. For image publish/list/inspect/install/tag/pull commands, <code>--station</code> selects that private registry. For <code>images run</code>, it means execution placement in the selected registry. Request bodies never choose a target URL.</p>
    <h3>Resumable publication and tenant grants</h3>
    <p>The CLI publisher verifies local bytes, reserves upload sessions, sends offset- and digest-checked chunks, commits each immutable blob, then publishes the manifest. Rerunning the command reconciles its private receipt with the server offset after an uncertain response. The dashboard uses the same resumable protocol with Pause/Resume, accepted-byte progress and tab-scoped receipts. After reload, reselect the same files; Resume first reads the server offset. It never silently retries a mutation. Upload quotas and expiry are independent of final blob storage quotas.</p>
    <p>Tenant APIs live under <code>/api/v1/tenant/registry</code>. Operator mappings bind registry-only key record IDs to separate storage namespaces and read/publish/activate/invoke grants. Revocation, mixed-scope refusal and cross-namespace digest/upload denial are enforced. The concrete createTenantRegistryWorkerGateway helper verifies a fixed dedicated worker identity and imports the pinned artifact closure before execution. A real Docker Headquarters/two-tenant-worker test covers signal execution and cross-tenant denial. The operator still provisions independent worker storage, queues, secrets and host policy; this is not a general tenant scheduler.</p>
    <p>Review the <a href="https://github.com/porkytheblack/station/blob/main/docs/STATION-IMAGES-ACCEPTANCE.md">numbered acceptance matrix</a> for exact tests and remaining requirements. That map distinguishes verified native Docker beacons, actual daemon revocation, mixed native/image planners, SQLite SIGKILL recovery and static invocation artifact scopes from unverified production-host/failover claims and absent automatic cross-worker media transfer.</p>
    <h3>CLI and terminal workflows</h3>
    <p>The TUI nests workspace files, terminals, services and command receipts, and browser pages, profiles, recordings, diagnostics, recovery checkpoints and artifact receipts. Registry exports and deployment generations/history/rollouts have details. Owner routing, explicit mutation confirmation and bounded replay reconnect use the shared client. Receipts cover this TUI’s observed operations; visual playback remains in the dashboard and binary transfer uses CLI helpers. The <a href="https://github.com/porkytheblack/station/blob/main/docs/STATION-CLI-COVERAGE.md">command coverage map</a> lists every current execution method and its actual tests; backend support still varies.</p>
    <p>For scripts, sandbox <code>exec --wait</code> returns the final JSON result and remote exit status; default exec remains asynchronous. <code>--wait-timeout-ms</code> bounds local polling, while Ctrl-C and local timeout stop waiting without cancelling remote work. <code>--json-errors</code> emits sanitized structured failures on stderr. Remote execution timeout and explicit cancellation remain separate operations.</p>
    <h3>Worker enrollment and revocation</h3>
    <p>Headquarters enables <code>network.enrollment: {"{authority:true}"}</code> with authentication. Invite a fixed worker, transfer the private invitation, then join independently of CLI contexts. The generated file supplies <code>role</code> and <code>network</code> fields including the credential; shared adapters and worker authentication are still operator configured.</p>
    <Code>{`station network invite worker-a --out worker-a.invitation.json
station network join --file worker-a.invitation.json --out worker-a.enrollment.json
station network members
station network revoke worker-a
station network leave --file worker-a.enrollment.json`}</Code>
    <p>Secrets stay in mode-0600 files or bounded stdin and are not printed. Invitations are single use; uncertain redemption needs a new invitation. Fresh daemon admission gates claims and renewal, fences active children after revocation and prevents heartbeat self-readmission. Enrollment does not distribute or revoke shared database credentials.</p>
    <h3>Explicit beacon rollout</h3>
    <Code>{`station deployments rollout DEPLOYMENT_ID --json '{"operationId":"rotate-a","expectedRevision":7,"sourceInstance":"OLD_INSTANCE","generation":"ACTIVATED_GENERATION","alias":"watch"}'`}</Code>
    <p>The daemon durably stops the source before creating a deterministic replacement, retains its old incarnation, and completes after replacement readiness. Retry the same operation ID and inspect retained rollout state after uncertain responses. This can have downtime. Alias activation alone does not replace live instances; new process environments resolve current granted references, not immutable secret revisions.</p>
    <h3>Planner grants and invocation artifacts</h3>
    <p>For ordinary Station signals, the image declares <code>nativeSignals</code> aliases with name and revision digest. Matching <code>registry.execution.nativeSignals</code> grants name an operator-owned, self-contained bundle; only <code>station-signal</code> may remain external. Uploaded code cannot choose a host module path. Saved plans use immutable names and cached bytes are reverified at bootstrap.</p>
    <p>Large runtime files use a separate <code>FileInvocationArtifactStore</code>. Exports declare artifact read/write capabilities; <code>registry.execution.artifacts</code> supplies the private root, per-scope/global quotas and static grants keyed by exact image digest and export. Reading requires explicitly allowed references; input strings never authorize themselves. Correlated <code>artifact:request</code>/<code>artifact:response</code> frames support bounded create/append/commit/read chunks and opaque <code>station-artifact:</code> references. Deadline/expiry cleanup removes incomplete payloads.</p>
    <p>Operator SDK scopes can import and read files, but no media upload/download HTTP endpoint, automatic cross-worker transfer or distributed artifact driver is included. Workers need explicitly configured shared filesystem access and grants. See the complete guide for policy and protocol fields. Executable image blobs and retained deployment generations are a different store and have no automatic reference-aware garbage collection.</p>
    <h3>Docker operations and current limits</h3>
    <p>Docker execution uses a non-root UID, read-only root, no network, dropped capabilities, no-new-privileges, memory/CPU/PID limits and seccomp. If the engine defaults to unconfined, configure an operator-reviewed deny-default <code>seccompProfile</code>; do not disable the check. The workload receives no Docker socket. Containers share the host kernel and are not VMs.</p>
    <p>Run an independent expiry reaper with the same backend options and private staging directory, under a host service manager. It validates invocation journals and container ownership before removing expired containers, including those whose controller died.</p>
    <Code>{`station-image-reaper --config /etc/station/image-reaper.json --interval-ms 5000`}</Code>
    <p>Five real Docker tests passed on a Linux arm64 Docker Desktop engine for native/JavaScript invocation, isolation settings, timeout cleanup and independent expiry reaping. Validate the intended production host separately. Operator registry access requires admin authorization. Tenant registry namespaces, grants and a concrete dedicated execution gateway have real Docker fixture coverage. Durable worker enrollment/revocation, reconnectable TUI event streams, static artifact-reference scopes, mixed planner grants, audited environment overrides and explicit live-beacon rollout are implemented and have focused acceptance evidence. The user explicitly deferred unavailable production Linux staging; its deployment checks remain unverified; this is not a finished public multi-tenant hosting platform.</p>
  </>;
}
