# Public tenant execution: deployment contract

Station separates the operator control plane from customer execution. This is a self-managed execution layer, not an automatically provisioned hosting service. The safe default denies workload networking. Enable internet access only after installing and validating a restricted egress network.

## Topology and identity

Run authenticated Headquarters as the public entry point. Keep its operator dashboard and administrator credentials restricted to your staff. Each private execution worker belongs to exactly one tenant; multiple keys and multiple workers may belong to that tenant. Sandbox and Browser Use can use separate specialized workers. Shared Postgres coordinates membership; it does not hold their filesystem state.

Headquarters configuration:

```ts
execution: {
  token: process.env.STATION_EXECUTION_TOKEN!,
  tenants: {
    apiKeyTenants: {
      "KEY_RECORD_ID_FOR_CUSTOMER_A": "customer-a",
      "KEY_RECORD_ID_FOR_CUSTOMER_B": "customer-b",
    },
  },
}
```

Use authenticated `StationInstance.keyStore.create(name, ['execution'])` or the operator key API to create customer keys. Map the returned **key record ID**, not the secret bearer value, to the tenant. Give that customer only the bearer key. Keys with admin/read/trigger/cancel scopes, mixed scopes or login cookies cannot become customer identities. Revocation and expiry apply normally. Keep mapping configuration operator-owned and redeploy Headquarters after changing it; do not accept arbitrary tenant IDs from requests.

Customer discovery: `GET /api/v1/tenant/execution`. Customer RPC: `POST /api/v1/tenant/stations/:stationId/execution/sandbox` or `/browser`, with `Authorization: Bearer sk_...`. RPC payloads match the operator API. Customers receive only their dedicated workers; cross-tenant owners return404. Headquarters verifies membership and forwards its authenticated tenant assertion with the private service secret. The private worker independently rejects the wrong tenant assertion. A caller-provided header cannot replace this identity.

The admin dashboard remains a fleet-wide operator tool. Do not give customers its administrator login. Build a customer-facing UI over tenant routes if required.

## Dedicated sandbox worker

```ts
import { ContainerSandboxAdapter } from 'station-sandbox/container';

execution: {
  token: process.env.STATION_EXECUTION_TOKEN!,
  tenantId: 'customer-a',
  sandbox: new ContainerSandboxAdapter({
    rootDir: '/data/customer-a/sandbox-controller', tenantId: 'customer-a',
    engine: 'docker',
    image: 'your-registry/station-tools@sha256:VERIFIED_DIGEST',
    network: 'none',
    memoryMb: 512, cpus: 1, pidsLimit: 128,
    maxEnvironments: 8, maxConcurrent: 4,
    enablePty: true,
  }),
}
```

The tools image must contain `/usr/local/bin/node`, `/bin/bash`, `/usr/bin/setsid` and the other fixed helper paths in the container adapter reference, with `/home/node` owned by UID/GID1000. Pre-pull and pin the image. A Node controller plus optional `node-pty` provides terminals. One named volume per workspace retains files and npm tools; the controller metadata root retains service intent/history. No tenant receives controller files, credentials, arbitrary host mounts or the engine socket.

Do not change tenantId on an existing station or adapter data root. Persistent tenant bindings reject reassignment; migrate through explicit backup/restore into a fresh owner only after verifying authorization. Stop a worker before moving its storage. Local root locks are not distributed HA fencing.

## Dedicated browser worker image

Build the package, then build only the runtime target:

```sh
pnpm --filter station-browser-use build
podman build --target runtime -t localhost/station-browser:2.4.0 \
  -f scripts/execution-container/Containerfile .
```

Docker uses the same Containerfile. Pin the resulting image by digest/ID and pre-pull it on each engine. The runtime contains exact Playwright1.63.0 and matching Chromium; the `integration` target adds a loopback-only fixture for tests and must not be your production image.

```ts
import { BrowserSessionManager } from 'station-browser-use';
import { ContainerBrowserAdapter } from 'station-browser-use/container';

execution: {
  token: process.env.STATION_EXECUTION_TOKEN!,
  tenantId: 'customer-a',
  browser: new BrowserSessionManager(new ContainerBrowserAdapter({
    rootDir: '/data/customer-a/browser-controller', tenantId: 'customer-a',
    engine: 'docker', image: 'your-registry/station-browser@sha256:VERIFIED_DIGEST',
    network: 'none', memoryMb: 1024, cpus: 1, pidsLimit: 256,
  }), 3, {
    recordingRootDir: '/data/customer-a/recordings', tenantId: 'customer-a',
    stateRootDir: '/data/customer-a/browser-state',
    recordingTtlMs: 7 * 24 * 60 * 60 * 1000,
    idleTimeoutMs: 15 * 60 * 1000,
  }),
}
```

Each browser session runs in its own nonroot container with a read-only root, bounded tmpfs, dropped capabilities and CPU/memory/PID limits. A profile uses an exclusively owned named volume. The controller retains bounded audit/recording metadata; screenshots may persist on its tenant-owned recording disk. No live browser or shell process is restored on restart. Browser upload/download artifacts are bounded and session-local.

## Network and storage policy

`network: 'none'` means no public internet, private LAN or metadata access; browser tests use a loopback fixture inside their own container. Offline tool tarballs and bundled applications still work. An ordinary bridge is not tenant-safe and cannot be declared restricted.

For browser internet access, the included [enforced Linux deployment](./enforced/README.md) provisions a dedicated internal Docker bridge, HTTPS proxy, effective iptables deny rules and XFS project quota covering profiles, recordings, durable state and controller metadata. Its real kernel harness checks positive HTTPS, direct/peer/metadata/DNS bypass denial and disk exhaustion. It requires a rootful local Linux Docker/XFS host; it is not a managed Railway service configuration. Run its verifier before starting workers and after host networking changes.

Other deployments can provision a separately named engine network with equivalent enforcement. `networkRestricted: true` remains an explicit operator assertion; the adapter does not attest arbitrary firewalls continuously. Keep unvalidated networks disabled. The included HTTPS profile is browser-specific; Sandbox networking and named-volume disk limits require separate enforcement.

CPU/memory/PID constraints are passed to and checked against the engine. Hard disk quotas require filesystem/storage-driver enforcement on workspace/profile named volumes and recording disks. Limits on output, uploaded bytes or recording frames cannot stop arbitrary code from filling a volume. Set those quotas, reserve capacity for the controller and retain emergency headroom. Containers share the host kernel: patch it and the runtime, monitor advisories, and choose stronger VM isolation if your threat model requires a separate kernel.

## Operations and rollout

- Bind worker endpoints privately; expose neither engine APIs nor service tokens. Restrict network/database write access to the control plane. Serve Headquarters over TLS and restrict operator routes at the ingress.
- Keep worker identity, tenant bindings and persistent volumes together. Back up API key storage, adapter metadata, workspace/profile volumes and recording disks. Test restoration before rollout.
- Set workspace/session/concurrency limits per dedicated tenant worker and capacity budgets across the host. Add ingress connection/body/time limits and external rate limiting across Headquarters replicas; in-process request admission is not a distributed quota ledger.
- Drain a worker to refuse new work while preserving inspection/cleanup. Stop it before upgrading; verify stale processes/containers were removed and exclusive ownership recovered.
- Run unit/gateway tests, real engine tests and dashboard E2E on your target architecture/image. The repository tests exercise local Linux containers and local service topologies; no cloud deployment, load capacity or independent security audit is implied.

Customer onboarding, metering/billing, automatic worker provisioning, distributed fencing/failover and a customer UI belong to the hosting platform built around these primitives. This contract keeps those responsibilities explicit.

## Reproduce the isolated tenant test

Build the packages and test image, then point the test at your local engine. Tests create only labeled temporary containers/volumes and remove their resources on completion.

```sh
pnpm --filter station-kit... build
podman build --target integration -t localhost/station-browser-integration:test \
  -f scripts/execution-container/Containerfile .
STATION_CONTAINER_ENGINE=/opt/podman/bin/podman \
STATION_BROWSER_CONTAINER_IMAGE=localhost/station-browser-integration:test \
  pnpm test:execution:tenants
```

Use your actual Docker/Podman executable path. Also pre-pull `docker.io/library/node:22-bookworm-slim` for the sandbox test. The tenant test starts Headquarters and two private tenant workers, installs a CLI offline into a real workspace, checks filesystem isolation, takes a real container browser screenshot, rejects cross-tenant operations and enforces capacity/revocation. The browser container package integration exercises profiles, pages, transfers, recordings and cancellation separately.

Headquarters tenant admission defaults to30requests/second with burst60, eight in-flight requests per tenant and128globally. Multiple keys for one tenant share that budget. Configure `execution.tenants.limits` with `requestsPerSecond`, `burst`, `maxInFlightPerTenant` and `maxInFlight`; exhausted requests receive429 with Retry-After. Budgets are local to the Headquarters process. Use ingress/distributed quotas when scaling it to multiple replicas, and production database-backed key storage for high request rates.
