# Station Sandbox: detailed guide

This guide describes the implementation prepared for Station 2.4.0. It covers using a sandbox directly, exposing it through Headquarters, operating it from Station Kit, and deciding what your deployment must supply. API examples follow the source in this repository; deployment examples require your own storage, image and credentials.

## Contents

1. [What a sandbox provides](#what-a-sandbox-provides)
2. [Choose a backend](#choose-a-backend)
3. [Runnable walkthrough: install a custom tool](#runnable-walkthrough-install-a-custom-tool)
4. [Commands, terminals and services](#commands-terminals-and-services)
5. [Files and the dashboard](#files-and-the-dashboard)
6. [Git and authorized repositories](#git-and-authorized-repositories)
7. [Containers and shared tools](#containers-and-shared-tools)
8. [Headquarters and tenant routing](#headquarters-and-tenant-routing)
9. [Persistence and recovery](#persistence-and-recovery)
10. [Limits and capacity](#limits-and-capacity)
11. [Public deployment responsibilities](#public-deployment-responsibilities)
12. [Troubleshooting and further reading](#troubleshooting-and-further-reading)

## What a sandbox provides

A sandbox is a retained workspace with a home directory, files, command execution, optional interactive terminals and supervised background services. An agent can clone a repository, edit files, install tools, run tests, inspect results and return to that workspace later.

Station runs real programs. Bash interprets shell commands; Node runs JavaScript; Git manages repositories. There is no Unix emulator and Station does not automatically install these programs. The operator supplies a host or container image containing them.

Keep these three resources distinct:

| Package | Resource | Typical use |
| --- | --- | --- |
| `station-sandbox` | Workspace, command, terminal, service | Coding agents, builds, Git, CLI tools |
| `station-browser-use` | Browser session, profile, recording | Agent navigation, interaction, screenshots |
| `station-browser` | Station runtime inside a browser worker | Browser-local signals, broadcasts and beacons |

A sandbox does not automatically create a Browser Use session. A workflow can use both primitives and retain both handles. Browser recordings belong to Browser Use, not the sandbox filesystem unless your application explicitly copies them there.

The basic lifecycle is **create → execute/read/write → retain or destroy**. Closing the adapter shuts down its active work while retaining workspace storage. Destroying a workspace deletes its owned data. Persist the owning Station ID together with the sandbox ID; a sandbox ID alone does not locate a resource elsewhere in the fleet.

## Choose a backend

| Property | `HostSandboxAdapter` | `ContainerSandboxAdapter` |
| --- | --- | --- |
| Import | `station-sandbox` | `station-sandbox/container` |
| Execution | Processes under the worker's OS user | One Docker/Podman container per workspace |
| Files | Directories below `rootDir` | Named volume per workspace; separate controller metadata |
| Isolation | `isolated: false` | Container isolation; shared host kernel |
| Hardware virtualization | Not required | Not required on a Linux container host |
| Tools | Installed on host/image; workspace-local installs | Baked into image; workspace-local installs |
| Resource enforcement | Must be supplied outside the adapter | CPU, memory and PID limits configured by adapter |
| Network | Host's access | None by default; operator-configured network otherwise |
| Intended use | Trusted local/internal agents | Isolated execution on operator-managed engines |

**Use the container backend for the public tenant execution path.** Separate folders and `HOME` values in the host backend do not stop one command from reading another directory accessible to the worker's OS user. File API path validation does not change that fact.

Containers are not VMs. The current package does not implement a Firecracker/VM adapter. Its `SandboxAdapter` interface allows other implementations, but each implementation must report its actual capabilities. Read `capabilities.pty`, `files`, `services`, `isolated` and `networkRestricted`; do not silently substitute a weaker backend.

The controller and the programs it launches are also separate choices. Use a Node controller for native PTYs. Bun can be a program installed inside the workspace environment without changing the sandbox backend.

## Runnable walkthrough: install a custom tool

This example uses the **trusted host backend** on a POSIX machine with Node 20+, npm and `/bin/bash`. It creates a temporary workspace, builds a dependency-free npm CLI locally, installs it inside the sandbox, runs it in a fresh command, reopens the adapter and runs it again. The demo itself needs no registry access after its dependencies are installed.

In a new application, install `station-sandbox` and the development runner `tsx`. In this monorepo, use the workspace package instead of assuming an unpublished version is on npm:

```sh
pnpm add station-sandbox
pnpm add -D tsx
# Save the following code as sandbox-demo.ts, then:
pnpm exec node --import tsx sandbox-demo.ts
```

The example uses an async entry point so it also works in projects without `"type": "module"`. It removes only the temporary demo root on completion.

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostSandboxAdapter } from "station-sandbox";

async function main() {
  const rootDir = await mkdtemp(join(tmpdir(), "station-sandbox-guide-"));
  let adapter: HostSandboxAdapter | undefined;
  try {
    adapter = new HostSandboxAdapter({ rootDir, maxTimeoutMs: 120_000 });
    const workspace = await adapter.create();

    const run = async (command: string) => {
      const started = await adapter!.exec(workspace.id, {
        command, timeoutMs: 120_000,
      });
      let result = started;
      while (!result.finishedAt) {
        await new Promise(resolve => setTimeout(resolve, 50));
        result = await adapter!.command(workspace.id, started.id);
      }
      assert.equal(result.status, "completed", result.stderr);
      assert.equal(result.exitCode, 0, result.stderr);
      return result;
    };
    const write = (path: string, contents: string) =>
      adapter!.writeFile(workspace.id, path, {
        base64: Buffer.from(contents).toString("base64"),
        createParents: true,
      });

    await write("custom-tool/package.json", JSON.stringify({
      name: "station-guide-hello", version: "1.0.0",
      bin: { "station-hello": "cli.cjs" },
    }));
    await write("custom-tool/cli.cjs",
      '#!/usr/bin/env node\nconsole.log("hello from the sandbox");\n');

    await run("npm pack ./custom-tool --offline --ignore-scripts --pack-destination .");
    await run("npm install --global --offline --ignore-scripts --no-audit --no-fund ./station-guide-hello-1.0.0.tgz");
    assert.equal((await run("station-hello")).stdout.trim(), "hello from the sandbox");

    // Closing preserves storage. A new adapter must acquire the same root.
    await adapter.close();
    adapter = undefined;
    adapter = new HostSandboxAdapter({ rootDir, maxTimeoutMs: 120_000 });
    assert.equal((await adapter.get(workspace.id)).id, workspace.id);
    assert.equal((await run("station-hello")).stdout.trim(), "hello from the sandbox");
    console.log("PASS: custom tool installed, executable, and retained after reopen");

    await adapter.destroy(workspace.id);
  } finally {
    // Do not remove a live adapter's storage if shutdown fails.
    await adapter?.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
```

The default npm prefix is `$HOME/.local`. The adapter places workspace `node_modules/.bin` first in `PATH`, followed by `$HOME/.local/bin`, then shared system tools. Thus project tools override workspace-global tools, which override shared tools. A separate workspace gets a different home and does not automatically gain this installation.

For a real project, `npm install` or `pnpm install` writes into the project as usual, provided those tools exist and network policy permits dependency fetching. The demo disables package lifecycle scripts; packages needing native compilation or install hooks require an explicit decision to enable those scripts and the necessary build toolchain.

Host adapters allow operator environment overrides, including `NPM_CONFIG_PREFIX` and `PATH`. An overridden install prefix changes where files persist and its `bin` directory must be added explicitly. The container adapter fixes its workspace/home/PATH layout and npm prefix; shared container tools should use its standard system paths.

## Commands, terminals and services

The following snippets assume an existing adapter named `sandboxes` and a `workspace` returned by `create()`. They are individual API examples; the walkthrough above is the complete runnable program.

These are three different lifecycles. Choose based on how long the process must live and whether it needs interactive input.

| Facility | Use it for | State between interactions |
| --- | --- | --- |
| `exec` | Build, test, Git operation, bounded script | Files persist; each call starts a new shell |
| Terminal | Interactive shell, REPL, terminal application | Shell state stays while that terminal lives |
| Service | Preview server or other long-lived process | Supervised process with a finite restart policy |

### Bounded commands

```ts
const started = await sandboxes.exec(workspace.id, {
  command: "git status --short",
  cwd: "repository", // Existing directory relative to the workspace.
  timeoutMs: 10_000,
});
const current = await sandboxes.command(workspace.id, started.id);
// Poll until current.finishedAt is present; the walkthrough shows the full loop.
// If cancellation is required:
await sandboxes.cancel(workspace.id, started.id);
```

`exec` returns a handle before execution finishes. `command` returns the current result, including `stdout`, `stderr`, `exitCode`, `truncated`, timestamps and status. Possible statuses are `running`, `completed`, `failed`, `cancelled`, `timed_out` and `interrupted`. Wait for **`finishedAt`**, because cancellation/timeout status can change before cleanup completes. `cancel` waits for cleanup.

Output is bounded and excess bytes are discarded, so `truncated: true` means the captured log is incomplete. For a large artifact, write it to a workspace file and retrieve bounded chunks through the file API. That still consumes disk space.

Each command uses a fresh Bash shell without profile startup files. `cd`, `export`, aliases and shell functions from one command do not carry into the next. Use `cwd`, command-local environment assignments, explicit configuration files or a terminal for those needs. There is no per-command `env` field in `CommandInput`.

Ordinary command descendants are cleaned up when the command finishes, times out or is cancelled. Do not start a server with `exec("node server.js &")` and expect it to survive command cleanup. The host backend cannot contain processes deliberately escaping its process group.

### Interactive terminals

Install the optional native `node-pty` peer on the **controller**, use Node, and enable PTYs. For the host adapter, set `enablePty: true` when constructing it. Container PTYs also require the peer on the controller, not merely inside the tools image.

```ts
const terminal = await sandboxes.openTerminal(workspace.id, { cols: 100, rows: 30 });
await sandboxes.terminalInput(workspace.id, terminal.id, "pwd\r");
const output = await sandboxes.terminal(workspace.id, terminal.id, 0);
console.log(output.data);
// Poll again using output.nextOffset; output may not have arrived on the first read.
await sandboxes.resizeTerminal(workspace.id, terminal.id, 120, 40);
await sandboxes.closeTerminal(workspace.id, terminal.id);
```

Terminal offsets count bytes. Keep `nextOffset`; check `startOffset` and `truncated` when reconnecting because retained output is bounded. The host ring is memory-only. Container terminals checkpoint a bounded output tail to controller metadata; output since the last checkpoint can be lost on a crash. Render output in a terminal emulator or as escaped text. Reconnecting to a live terminal does not mean restoring a shell after a worker restart.

### Supervised services

```ts
const service = await sandboxes.startService(workspace.id, {
  name: "preview",
  command: "node server.cjs", // Supply this file in the workspace first.
  restart: { policy: "on-failure", maxRestarts: 3, delayMs: 1000 },
});
console.log(await sandboxes.service(workspace.id, service.id));
await sandboxes.stopService(workspace.id, service.id);
// Later, explicitly restart it or remove the retained definition:
await sandboxes.restartService(workspace.id, service.id);
await sandboxes.removeService(workspace.id, service.id);
```

Policies are `never`, `on-failure` and `always`, with a finite restart budget. An explicit restart resets that budget. The status `running` reports process startup, not successful application readiness. Recovery differs by backend: host services retain their definitions but require an explicit restart. Container services retain a desired-running flag and are automatically relaunched after initialization when that flag remains set, including after a graceful adapter close. Explicitly stop a container service before shutdown if it must remain stopped. Relaunch starts a fresh process and can repeat application side effects; it does not restore process memory. A recovery launch can fail admission, so inspect its resulting status.

Services do not automatically receive public URLs, port forwarding, health checks or load balancing. Host services also share the host's port namespace. Those deployment facilities must be supplied separately.

## Files and the dashboard

File operations use workspace-relative paths. They reject absolute paths, parent traversal and symlink components; listings can describe symlinks without following them. Binary content travels as base64, not JSON text pretending to be a file.

```ts
await sandboxes.writeFile(workspace.id, "src/settings.json", {
  base64: Buffer.from('{"enabled":true}\n').toString("base64"),
  createParents: true,
});
const listing = await sandboxes.listFiles(workspace.id, "src", { limit: 100 });
const chunk = await sandboxes.readFile(workspace.id, "src/settings.json", {
  offset: 0, length: 4096,
});
console.log(listing.entries, Buffer.from(chunk.base64, "base64").toString("utf8"));
```

For paginated directory listings, pass the returned `nextOffset` into the next call. For large reads, continue from `nextOffset` until reaching `totalBytes`; directory/file changes during pagination are not a snapshot. Writes replace a file rather than append a chunk. Directory removal requires `removeFile(id, path, { recursive: true })`. These methods are optional on the general `SandboxAdapter` interface; check capabilities when using an arbitrary adapter.

In **Station Kit → Sandboxes**:

1. Select a worker and create or open a workspace.
2. Use **Commands** for bounded jobs and their captured output.
3. Use **Files** to browse directories, inspect/edit files, upload/download content and manage entries.
4. Use **Terminal** for interactive shell work when the worker advertises PTY support.
5. Use **Services** to inspect and control retained background services.

Each facility has its own page, for example `/sandboxes/<stationId>/<sandboxId>/files`. The terminal path ends in `/terminal` (singular). Tabs depend on advertised capabilities. Workspaces stay with the owning worker; selecting a different worker does not migrate them. Stop commands and live facilities before destroying a workspace.

The current dashboard is an **operator dashboard with fleet-wide access**. It is not the customer-facing tenant UI. Build customer views over tenant endpoints instead of giving customers an administrator login.

## Git and authorized repositories

A sandbox can use Git normally if Git is installed and the repository is reachable. The following commands are a local workflow; replace the example repository URL with the intended repository:

```sh
git clone https://github.com/OWNER/REPO.git repository
cd repository
git switch -c agent/documentation-demo
git config --local user.name "Station Agent"
git config --local user.email "station-agent@example.invalid"
printf 'Workspace documentation experiment.\n' > STATION-NOTES.md
git diff --stat
git status --short
git add STATION-NOTES.md
git commit -m "Document workspace experiment"
git show --stat --oneline HEAD
```

Run this as one command, or use `cwd: "repository"` for subsequent calls. `git diff` does not display the contents of a new untracked file until it is staged; use the file viewer to inspect it. The clone, branch and commit remain local until an explicit push. The `gh` CLI is a separate program that must be included in your image or installed; Git itself does not provide GitHub PR operations.

### Application credentials

A repository owner's GitHub App installation can authorize repository access. Your application should mint an installation token scoped to the required repository and permissions. Installation tokens expire after one hour and cannot exceed the installation's grants. [GitHub's installation-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) explains scoping and renewal.

**Station Sandbox does not currently implement that GitHub App credential broker.** The integration belongs in your application/control plane:

1. Resolve the authenticated tenant and its authorized repository.
2. Mint a short-lived token for that repository and the necessary operations.
3. Supply Git authentication through a controlled credential helper or equivalent mechanism for the authorized workload.
4. Renew credentials as needed and remove temporary credential material when the operation ends.

Keep the App private key in the trusted control plane. Do not embed tokens in Git remote URLs, command strings, retained logs or committed files. Adapter `env` values are shared configuration for its workspaces, not a per-repository secret store. A credential available to executing code can be read by that code; only give a workspace credentials it is authorized to use.

Repository permissions and branch protection still apply. A successful local commit does not establish permission to push, merge or bypass review. Your agent application must define which remote operations it may perform.

## Containers and shared tools

Use an operator-managed Linux Docker or Podman engine. The controller needs permission to manage the engine; customer code must not receive that permission or its socket.

```ts
import { ContainerSandboxAdapter } from "station-sandbox/container";

const sandboxes = new ContainerSandboxAdapter({
  rootDir: "/data/customer-a/sandbox-controller",
  tenantId: "customer-a",
  engine: "docker",
  image: "your-registry/station-tools@sha256:VERIFIED_DIGEST",
  network: "none",
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 128,
  maxEnvironments: 8,
  maxConcurrent: 4,
  enablePty: true,
});
await sandboxes.ready();
const workspace = await sandboxes.create();
// Use the same command/file/terminal/service methods described above.
await sandboxes.close();
```

Replace the image placeholder with your built, pre-pulled image. The image must provide `/usr/local/bin/node`, `/bin/bash`, `/usr/bin/setsid` and the fixed helper utilities used by the adapter, with `/home/node` owned by the configured non-root user (default UID/GID 1000). A minimal distroless image lacking these utilities will not work. See the [container implementation](src/container.ts) and [deployment contract](../../scripts/execution-container/README.md) when preparing the image.

The adapter creates a read-only root filesystem, drops capabilities, enables no-new-privileges, limits CPU/memory/PIDs, mounts a retained volume at `/home/node`, and supplies bounded temporary storage at `/tmp`. Workspace files live at `/home/node/workspace`; npm global tools live at `/home/node/.local`.

Bake shared Node, Git, package managers, compilers and common CLIs into the image once. Individual workspaces can install additional tools into their writable home/project. Changing the operator's image is not an automatic upgrade of already-retained workspace containers; plan explicit replacement/migration and validate tool compatibility.

`network: "none"` prevents online clones and registry installs. To permit them, configure a restricted named network and enforce its egress policy outside Station. `networkRestricted: true` declares that policy; it does not create firewall rules. An unrestricted bridge is not a restricted tenant network. The browser-specific enforced storage profile in this repository does not automatically impose quotas on Sandbox named volumes.

## Headquarters and tenant routing

The intended public topology is:

```text
Customer / agent
    │ tenant execution key
    ▼
Headquarters ── authenticated private RPC ──► tenant A sandbox worker
    │                                    └─► tenant A browser worker
    └──────── authenticated private RPC ──► tenant B sandbox worker
```

Each execution worker belongs to one immutable tenant. Headquarters authenticates the caller, resolves its tenant and checks the selected worker. The worker independently validates the forwarded identity. Multiple workspaces on one tenant's worker are not separate customer identities. Shared membership storage does not store workspace files.

Customer keys must have exactly the `execution` scope. Headquarters maps the **key record ID**, not the secret key value, in `execution.tenants.apiKeyTenants`. Worker configuration sets `execution.tenantId` and the adapter's `tenantId` consistently. The private execution token is separate from customer keys. The [deployment contract](../../scripts/execution-container/README.md) contains the configuration snippets.

| Request | Purpose |
| --- | --- |
| `GET /api/v1/tenant/execution` | Discover this tenant's execution workers |
| `POST /api/v1/tenant/stations/:stationId/execution/sandbox` | Customer sandbox RPC |
| `POST /api/v1/stations/:stationId/execution/sandbox` | Operator sandbox RPC |

Send `Authorization: Bearer <customer-key>` to the tenant API. The following JSON bodies illustrate the exact RPC shapes; replace resource placeholders with returned IDs. Success returns `{ "data": ... }`.

| Operation | Request body |
| --- | --- |
| Create | `{ "method": "create" }` |
| List | `{ "method": "list" }` |
| Get | `{ "method": "get", "id": "SANDBOX_ID" }` |
| Execute | `{ "method": "exec", "id": "SANDBOX_ID", "command": "git status --short", "cwd": "repository", "timeoutMs": 10000 }` |
| Poll/cancel | `{ "method": "command", "id": "SANDBOX_ID", "runId": "RUN_ID" }` (or `cancel`) |
| List files | `{ "method": "listFiles", "id": "SANDBOX_ID", "path": ".", "options": { "limit": 100 } }` |
| Read file | `{ "method": "readFile", "id": "SANDBOX_ID", "path": "README.md", "options": { "offset": 0, "length": 4096 } }` |
| Write file | `{ "method": "writeFile", "id": "SANDBOX_ID", "path": "hello.txt", "options": { "base64": "aGVsbG8K", "createParents": true } }` |
| Open terminal | `{ "method": "openTerminal", "id": "SANDBOX_ID", "options": { "cols": 100, "rows": 30 } }` |
| Read terminal | `{ "method": "terminal", "id": "SANDBOX_ID", "terminalId": "TERMINAL_ID", "offset": 0 }` |
| Terminal input | `{ "method": "terminalInput", "id": "SANDBOX_ID", "terminalId": "TERMINAL_ID", "data": "pwd\r" }` |
| Start service | `{ "method": "startService", "id": "SANDBOX_ID", "options": { "name": "preview", "command": "node server.cjs" } }` |
| Inspect/stop service | `{ "method": "service", "id": "SANDBOX_ID", "serviceId": "SERVICE_ID" }` (or `stopService`) |
| Destroy | `{ "method": "destroy", "id": "SANDBOX_ID" }` |

The REST wrapper uses `options` for file writes, terminal creation and service creation. Direct adapter calls take those objects as method arguments. `exec` fields remain at the top level of the RPC body.

Retain returned handles in your application's durable workflow state. Route all subsequent calls to the same owning Station. Resource creation and commands are not automatically placed/migrated across workers by this API. For agent integrations, fix the endpoint, credentials and allowed worker/resource handles in trusted application configuration rather than accepting them as model-supplied arguments.

A timeout or disconnected response can leave a mutation's outcome unknown. Reconcile the resource before retrying a create, command, write or service operation. Shell commands can have external effects and are not generally idempotent. The gateway can return an `outcome` marker with an error; inspect it rather than treating every 503 as proof that nothing happened.

## Persistence and recovery

| State | Between commands | After adapter/worker restart |
| --- | --- | --- |
| Repository, edits, local commits | Retained | Retained if workspace storage survives |
| Workspace-installed tools | Retained | Retained with home/project storage |
| Completed command records | Retained within history bound | Available from retained metadata |
| Running command | Pollable while alive | Interrupted; not automatically replayed |
| Terminal shell and output | Retained within that live terminal | Shell not restored; host ring lost, container checkpointed tail retained |
| Service definition/history | Retained within configured bounds | Host: explicit restart. Container: desired-running services relaunch automatically |
| Service/command process memory | Lives with process | Not restored |
| Container `/tmp` | Temporary | Do not rely on it for persistence |

For host execution, persist the whole `rootDir`. For container execution, preserve **both controller metadata and engine volumes**. Keeping one without the other is not a complete backup. A new empty volume mounted at the same path does not restore old workspaces.

Exactly one controller owns an adapter root. Root locks prevent concurrent local owners; they are not a distributed lease or a high-availability storage system. Stop/fence the old worker before moving storage or starting a replacement. Host recovery does not adopt orphan processes. Container recovery checks resource ownership and restarts its owned container as part of recovery; it does not restore process memory.

Handle malformed metadata or storage failures explicitly instead of deleting files to force startup. If a lock appears stale, verify the old owner and its workloads are stopped before repairing it. Tenant identity is retained with the data root; do not reassign that root to another customer. Keep a documented, tested backup/restore process outside the package.

## Limits and capacity

These are implementation defaults, not promised throughput. Tune them against measured workload memory, CPU, disk and duration.

| Control | Host default | Container default |
| --- | --- | --- |
| Workspaces (`maxEnvironments`) | 20 | 8 |
| Execution slots (`maxConcurrent`) | 4 bounded commands across adapter | 4 commands/services combined across adapter |
| Captured stdout + stderr (`maxOutputBytes`) | 256 KiB | 256 KiB |
| Maximum command timeout (`maxTimeoutMs`) | 300,000 ms | 300,000 ms |
| Completed command history (`maxHistoryPerSandbox`) | 100 per workspace | 100 per workspace |
| Memory / CPU / PIDs | No adapter enforcement | 512 MiB / 1 CPU / 128 per container |
| Terminal capacity | `maxTerminals`: 8 active across adapter | `maxTerminalsPerSandbox`: 4 per workspace |
| Service capacity | `maxServices`: 16 retained across adapter | `maxServicesPerSandbox`: 8 per workspace |

An omitted command timeout uses 30 seconds, capped by the configured maximum. The host has separate command, terminal and service admission controls. Container services share `maxConcurrent` execution slots with bounded commands, while terminals have their own limit. Neither setting limits the total process count by itself. Container memory/PID limits cover all processes in that workspace container. Stopped service definitions still consume retained service capacity until removed.

The host file API defaults to 1 MiB per operation, configurable through `maxFileBytes` up to 16 MiB. The gateway adds its own request/response limits; effective limits are the smallest applicable layer. Large uploads require application-level artifact handling, not simply increasing one adapter option.

Output/history bounds do not cap filesystem growth. Container named volumes need independently enforced disk quotas, and the fleet needs admission based on aggregate capacity. Eight containers configured for 512 MiB each still require host/controller/engine headroom.

## Public deployment responsibilities

The package supplies execution primitives and tenant routing support. Operating a public service also requires the following concrete controls:

- **Identity:** authenticated Headquarters, execution-only customer keys, operator-owned tenant mapping and dedicated tenant workers. Keep the operator dashboard private to staff.
- **Containment:** container workers for tenant workloads, patched Linux host/engine, no workload access to the engine socket or controller credentials. Container isolation shares a kernel; assess whether your threat model needs a stronger boundary than the implemented backend.
- **Network:** default deny or enforced restricted egress. Explicitly test that permitted repository/package traffic works while metadata, management and other tenants' networks remain inaccessible.
- **Storage:** separate retained roots/volumes, quotas, backups, deletion policy and tested recovery. Browser storage limits do not cover sandbox volumes.
- **Lifecycle:** drain admissions before replacement, bound termination, preserve ownership and account for backend-specific service recovery behavior. Do not promise survival of live shells through redeploys.
- **Credentials:** per-authorized-workload secret delivery and rotation, no persistent tokens in logs or remote URLs. The package does not supply a GitHub credential broker.
- **Operations:** metrics, disk/CPU/memory alerts, artifact retention, customer accounting and reconciliation of uncertain requests. Preview URLs, autoscaling and billing are application/platform work.

The host-process backend can run within an ordinary service container, but that does not provide independently isolated customer workspaces. Running the container backend requires an accessible, operator-managed Docker/Podman engine. Merely deploying the controller as a container does not grant it a nested engine or the necessary host controls.

Before opening a deployment to customers, validate the actual target's tenant separation, egress restrictions, quotas, credentials, process cleanup and storage recovery. A passing local package test is not evidence that those external controls are configured on your host.

## Troubleshooting and further reading

| Symptom | What to check |
| --- | --- |
| `command not found` | Tool installed in host/image? Workspace bin in expected PATH? Install command actually finished successfully? |
| Git/npm cannot reach the internet | Container defaults to `network: "none"`; inspect the operator's egress policy. |
| Command fails after roughly 30 seconds | Set `timeoutMs` explicitly within `maxTimeoutMs`, or use a service for long-lived work. |
| `busy` on destroy | Cancel commands and close/stop live terminals/services before deletion. |
| `capacity` | Check the relevant command/workspace/terminal/service limit; remove unused service definitions. |
| No Terminal tab / `unsupported` | Check advertised PTY capability, Node controller and working native `node-pty` installation. |
| Files disappeared after deployment | Verify the old root/volume was retained and mounted; check that routing still targets the owning worker. |
| Root already owned | Stop/fence the previous controller. Do not delete a live owner's lock. |
| Tenant API returns 404 for a worker | Check discovery, tenant mapping and ownership; cross-tenant resources are intentionally hidden. |
| `unavailable` / uncertain mutation | Check worker membership, draining, engine and storage, then reconcile before retrying. |

Source and companion references:

- [Package README and shorter API examples](README.md)
- [Adapter interface and host implementation](src/index.ts)
- [File, terminal and service types](src/advanced.ts)
- [Container implementation and exact options](src/container.ts)
- [Headquarters RPC validation and dispatch](../station-daemon/src/server/routes/execution.ts)
- [Execution network example](../../examples/18-execution-network/README.md)
- [Public tenant deployment contract](../../scripts/execution-container/README.md)
- [Agent execution reference](../../.claude/skills/station/execution.md)
- [Browser Use documentation](../station-browser-use/README.md)

The walkthrough verifies tool installation and retained files using the host adapter. Container, PTY, network-policy and tenant-isolation validation require their respective deployment prerequisites and separate tests; the walkthrough does not establish those guarantees.
