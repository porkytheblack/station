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
    <p>The complete guide generates the manifest using the actual artifact bytes. A broadcast export returns a validated declarative DAG; its persisted plan invokes only declared signal dependencies. A beacon remains connected over the supervised protocol and can request declared dependency invocations through a scoped broker.</p>
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
    <p>Workers with a configured authenticated Headquarters upstream periodically import and verify compatible images and dependencies, install immutable definitions and advertise them. Shared durable queue and membership adapters still coordinate execution. Unsupported targets are skipped; corruption and permission failures stop the synchronization pass explicitly.</p>
    <Code>{`station images publish ./station-image.json --artifacts-dir ./build --context headquarters
station images run acme/echo@1.0.0 echo --input @request.json --context headquarters
# Optional immutable worker pin:
station images run acme/echo@1.0.0 echo --input @request.json --context headquarters --station coding-worker`}</Code>
    <p>Signal and broadcast pins persist through retries; broadcast planners and children stay on the selected worker. Pinned beacons are created through their owning worker context, with the same worker ID. Remote targeted beacon creation through Headquarters fails explicitly. Without a pin, eligible workers can claim work normally. A context selects an endpoint and does not itself pin execution.</p>
    <h3>Docker operations and current limits</h3>
    <p>Docker execution uses a non-root UID, read-only root, no network, dropped capabilities, no-new-privileges, memory/CPU/PID limits and seccomp. If the engine defaults to unconfined, configure an operator-reviewed deny-default <code>seccompProfile</code>; do not disable the check. The workload receives no Docker socket. Containers share the host kernel and are not VMs.</p>
    <p>Run an independent expiry reaper with the same backend options and private staging directory, under a host service manager. It validates invocation journals and container ownership before removing expired containers, including those whose controller died.</p>
    <Code>{`station-image-reaper --config /etc/station/image-reaper.json --interval-ms 5000`}</Code>
    <p>Five real Docker tests passed on a Linux arm64 Docker Desktop engine for native/JavaScript invocation, isolation settings, timeout cleanup and independent expiry reaping. Validate the intended production host separately. Registry access is currently operator-admin only. Customer registry authorization, deployment generations, rollback/GC, on-demand preparation reservations and image dashboard flows are not complete; this is not a finished public multi-tenant hosting platform.</p>
  </>;
}
