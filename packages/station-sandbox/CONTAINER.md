# Docker and Podman workspaces

`ContainerSandboxAdapter` implements the Sandbox contract using an operator-managed Linux Docker or Podman engine. Each workspace gets a separate container and named volume. The adapter never falls back to host execution when the engine is unavailable.

```ts
import { ContainerSandboxAdapter } from "station-sandbox/container";

const sandbox = new ContainerSandboxAdapter({
  rootDir: "/var/lib/station/container-state",
  image: "node:22-bookworm-slim", // Prefer an operator-pinned image digest in production.
  engine: "docker", // Or "podman"; executable may name an absolute CLI path.
  network: "none", // Explicitly choose "bridge" for package registries / outbound access.
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 128,
  maxEnvironments: 8,
  maxConcurrent: 4,
  enablePty: true,
});
await sandbox.ready();
const workspace = await sandbox.create();
const run = await sandbox.exec(workspace.id, { command: "node --version" });
console.log(await sandbox.command(workspace.id, run.id));
await sandbox.close(); // Stop execution; retain workspace volumes and metadata.
```

Pull or build the image before starting Station. `ready()` verifies engine availability, Linux support, the image, and available resource controllers, then reconciles persisted workspaces. StationKit awaits this probe before advertising the worker or opening HTTP. Do not expose the engine socket to workload containers.

## Image and host requirements

The image must provide `/usr/local/bin/node`, `/bin/bash`, `/usr/bin/setsid`, `/bin/sleep`, `/bin/mkdir`, and `/home/node` owned by the configured non-root numeric user (default `1000:1000`). The standard Node Debian image satisfies this contract. It can include Git, compilers, browser tools and other operator-approved packages. Image setup happens at build time; workload containers cannot modify their read-only root filesystem.

Each container uses a non-root user, dropped capabilities, `no-new-privileges`, a read-only root filesystem, a bounded temporary filesystem and explicit CPU, memory and PID limits. `/home/node` is a dedicated named volume. No arbitrary host bind mounts, published ports or host runtime sockets are accepted by the adapter. Default networking is `none`; choosing `bridge` enables ordinary engine networking and outbound access, not a destination allowlist. Public tenant workers reject bridge networking. An operator-created named network may use `networkRestricted: true` only when an external egress policy is installed and verified; this assertion does not create a firewall. Recovery refuses a container whose actual network differs from current configuration.

Ordinary containers share their Linux host's kernel. These settings provide container isolation; they do not establish VM isolation or a complete hostile-tenant security boundary. Harden the engine and host for the intended tenant trust model. Named-volume disk consumption needs host/storage quotas and monitoring: the portable adapter does **not** enforce a per-volume disk quota. CPU/memory/PID limits do not limit volume growth.

## Tools and files

Workspace files live in `/home/node/workspace`. npm global packages install into `/home/node/.local`, and its `bin` directory plus workspace `node_modules/.bin` are on the command PATH. With `network: "bridge"`, an operator-authorized command can install a package and later invoke it by name:

```ts
await sandbox.exec(workspace.id, {
  command: "npm install --global semver@7.7.3 --no-audit --no-fund && semver 1.2.3",
  timeoutMs: 120_000,
});
```

Only explicitly configured environment variables enter the container. Station/database secrets are not copied automatically. Each workspace has separate files and package installations.

File methods use workspace-relative paths: `listFiles`, `readFile`, `writeFile`, `removeFile`. Reads are paged; writes accept base64 and are bounded to 1 MiB per request. Directory listings accept an offset and a limit up to 1,000. Read chunks are bounded to 1 MiB. Absolute paths and traversal outside the workspace are rejected. Container code remains able to access other files permitted to its user **inside its own container**.

## Commands, services and terminals

Commands have bounded execution time, output and retained history. `exec` returns an ID immediately; `command` reads status/output and `cancel` stops the process session. Cancel requests create a marker before checking the process leader, so cancelling during launch cannot leave a subsequently started command running. If the engine cannot execute cleanup, the adapter attempts to kill the whole workspace container and marks it unavailable for new work. It does not treat disconnecting the local engine CLI as proof that a guest process stopped. Deliberately detached process sessions can outlive an individual command; stopping the workspace container is the definitive cleanup boundary.

Services use `startService`, `services`, `service`, `stopService`, `restartService`, and `removeService`. They run without the ordinary command timeout. Their desired state and restart policy are saved in controller metadata. A restarted controller re-creates running service intent after reconciling container processes; callers must make external service side effects idempotent. Commands and services share the configured concurrent execution cap. Each workspace also has a bounded service count (default eight) and a bounded restart history.

Terminals require `node-pty` on a **Node** controller. They wrap `docker exec -it` or `podman exec -it`, providing a real guest PTY with input, output offsets, resizing and close. Node controllers auto-detect `node-pty`; set `enablePty: true` to require it or `false` to disable it. Bun controllers report PTY unsupported and reject an explicit requirement; Bun can still run as a workload executable inside a Node-managed container. A plain pipe is never advertised as a PTY.

Command and terminal output are periodically checkpointed to controller storage, bounded by `maxOutputBytes`. An abrupt controller failure can lose the most recent checkpoint interval. Terminal output offsets count UTF-8 bytes. A read starting inside a multibyte character advances to the next complete character; returned offsets remain safe to reuse. Live terminal sessions end on controller restart; retained transcript metadata remains available. Closed terminal and command history are bounded by `maxHistoryPerSandbox` (default 100). Services and terminal lifecycles are independent of browser sessions.

## Ownership and recovery

For dedicated public tenant workers, set `tenantId` in both `ContainerSandboxAdapter` options and StationKit's `execution` configuration. The constructor checks the root's persisted tenant marker before reconciling containers or restarting services. Reopening with a different or missing tenant identifier fails, even when StationKit uses a new data directory. Existing unbound workspaces cannot be assigned to a tenant; use a fresh root or a deliberate authorized migration.

Keep `rootDir` durable and private to one controller. It contains a stable ownership ID, workspace identities, command results, service intent and terminal history. Every managed container and volume carries matching owner/workspace labels. Existing resources are checked before reuse or deletion. An exclusive host-local lock prevents two controllers from opening the same metadata directory; unknown or cross-host lock owners are not automatically stolen.

Do not copy a live controller's metadata root to another active controller. This is single-controller ownership, not a distributed lease or cross-host failover protocol. Back up both the metadata root and named-volume data; losing either requires operator-directed recovery.

After a controller crash, `ready()` stops old container processes, starts the owned container with its existing volume, marks in-flight commands interrupted, retains terminal transcripts and resumes persisted service intent. Memory, process stacks and interactive sessions are not restored. Partially provisioned records remain for reconciliation instead of being silently forgotten.

`destroy` requires active commands, services and terminals to be stopped. It removes the owned container, its volume and controller metadata. `close` stops processes but retains durable workspace data. Engine or storage cleanup failures are reported; operator inspection may be needed before a failed workspace can accept more work.

## Real-engine validation

Run against a dedicated development engine with the Node image already present:

```sh
STATION_CONTAINER_ENGINE=/usr/bin/docker \
STATION_CONTAINER_IMAGE=node:22-bookworm-slim \
pnpm --filter station-sandbox exec node --import tsx --test test/container.integration.ts
```

An absolute Podman CLI path works too; its active remote connection may target a Linux VM. The harness requires `node-pty`. It creates and deletes isolated test containers/volumes and verifies custom npm installation, persistent files and tools, non-root execution, capabilities, read-only root filesystems, absence of host mounts/sockets, actual cgroup limits, networking disabled by default, concurrent admission, timeout/cancel/output bounds, HTTP services, real PTY input/resize/close, and abrupt-controller recovery. It never provisions a cloud host.
