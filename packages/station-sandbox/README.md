# station-sandbox

Persistent POSIX workspaces and supervised shell commands for Station workers. This is a separate primitive from `station-browser-use`: a workspace does not implicitly own a browser session.

`HostSandboxAdapter` runs real Bash and native programs installed on the worker. It does not emulate Unix, install Node or Git, or require Docker. Package the tools into your worker image, or install them on the host and expose them through `PATH`. Multiple workspaces can use those shared tools while keeping separate working directories and home directories.

This is a **trusted-code backend**. Commands run as the worker's operating-system user and can access anything that user can access. Workspace paths and separate `HOME` directories organize work; they do not provide tenant isolation. The adapter advertises `isolated: false`; PTY support is opt-in through `enablePty: true` with the optional native `node-pty` peer installed. File APIs and supervised services are available without that peer. Use a future container or VM adapter for stronger isolation, and do not give untrusted public clients direct command access.

## Usage

```ts
import { HostSandboxAdapter } from "station-sandbox";

const sandboxes = new HostSandboxAdapter({
  rootDir: "/data/station-workspaces",
  maxEnvironments: 20,
  maxConcurrent: 4,
  maxOutputBytes: 256 * 1024,
  maxTimeoutMs: 300_000,
  maxHistoryPerSandbox: 100,
  env: { PATH: "/opt/tools/bin:/usr/local/bin:/usr/bin:/bin" },
});

const workspace = await sandboxes.create();
const started = await sandboxes.exec(workspace.id, {
  command: "node --version && git --version && printf hello > greeting.txt",
  timeoutMs: 10_000,
});

let run = await sandboxes.command(workspace.id, started.id);
while (!run.finishedAt) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  run = await sandboxes.command(workspace.id, started.id);
}
console.log(run.status, run.stdout, run.stderr, run.exitCode);

await sandboxes.close();
```

The base adapter contract provides create, list, get, destroy, exec, command, cancel and close. Optional file, terminal and service methods advertise their capabilities separately; adapters may reject unsupported facilities. `cwd` accepts existing relative directories within the workspace; absolute paths and symlink escapes are rejected for this starting directory. This check does not restrict what the command itself can open or change.

## Install workspace tools

The adapter prepends the workspace's `node_modules/.bin` and `HOME/.local/bin` to the explicitly configured `env.PATH` (or the host PATH when none is configured). Project-installed tools take precedence over workspace global tools, which take precedence over shared host tools. Paths containing spaces are supported; quote file paths in shell command text as usual.

By default, `NPM_CONFIG_PREFIX` points to `HOME/.local`, so this installs an npm CLI for this workspace without writing to the host's global tool directory:

```ts
const install = await sandboxes.exec(workspace.id, {
  command: "npm install --global --ignore-scripts --no-audit --no-fund /data/custom-tool.tgz",
  timeoutMs: 120_000,
});
// Wait for install.finishedAt through command(), then start a fresh command:
const use = await sandboxes.exec(workspace.id, { command: "custom-tool --version" });
```

An ordinary local `npm install` also exposes project binaries by plain command name. Installations persist across commands and manager restarts when the workspace volume survives. Other workspaces do not gain these commands through their PATH. This is tool organization, not isolation: trusted commands can still access other directories allowed to the same OS user.

Operators may explicitly override `env.NPM_CONFIG_PREFIX`; that can place installations outside the workspace and changes the persistence/sharing behavior. An overridden prefix's `bin` directory is not added automatically—include it in `env.PATH` when needed. Install scripts are arbitrary code; the example disables them. Package installation from registries requires outbound network access, whereas a dependency-free local tarball can be installed offline. npm itself must already be available on the worker.

## Commands and limits

Each command starts a fresh Bash process with profiles disabled. Shell variables, changed directories and shell bindings do not carry into the next command. Files do. The bounded command API is noninteractive. Use the separate terminal lifecycle below for interactive input and real PTYs.

`exec` returns immediately with a command identifier. Poll `command` for output and wait for `finishedAt` before treating the result as final. Cancellation or a timeout may change the status before process cleanup has completed. `cancel` waits for cleanup. Nonzero exit codes and spawn errors produce failed results.

Defaults are 20 workspaces, four commands running across the adapter, a combined 256 KiB stdout/stderr capture limit, a 30-second command timeout with a configurable five-minute maximum, and 100 completed command records per workspace. UTF-8 output is decoded across chunks and incomplete trailing characters are omitted at the byte cap. Output beyond the cap is drained and discarded. Older completed records are deleted automatically and become unavailable through `command`.

These limits bound admission, captured output and retained command history. They do not impose CPU, memory, disk-use, network or subprocess-count quotas on commands; provision operating-system or container limits separately. Workspace files can grow until the host volume fills or the application removes them.

Commands are bounded jobs: ordinary descendants in the command's process group are terminated when the shell exits, is cancelled, times out, or the adapter closes. Termination escalates to SIGKILL if necessary. Processes that deliberately escape the group are outside this backend's supervision guarantees. Use supervised services for long-lived processes and terminals for interactive work; these have separate admission and lifecycle controls.

Host environment variables are not inherited wholesale. Children receive the composed `PATH`, a locale, the workspace-local npm prefix default, explicitly supplied `env` values, and the workspace's assigned `HOME` and temporary directory. Do not put secrets in a shared environment unless all workspaces using this adapter may access them.

## Persistence and recovery

Mount `rootDir` on persistent storage. Each workspace stores its own home, working files, sandbox metadata and bounded command-result history. `close` interrupts active jobs and preserves files; `destroy` removes the workspace and requires all its commands to have finished or been cancelled.

On reopening, records left in `running` become `interrupted`. Commands are never automatically replayed. A new worker can inspect saved files and decide the next action, but live process memory, shell sessions and unpersisted output are not restored. Interrupted work may already have produced external effects; callers must decide whether retrying is safe.

Metadata writes use temporary files and rename. Malformed records fail recovery explicitly; command-result persistence failures surface as storage errors while the manager remains alive and stop admission of new commands and workspaces. This is local-file persistence, not a transactional distributed job store or a guarantee against sudden power loss. Recovering a root after a manager crash also does not discover or adopt surviving orphan processes: the supervisor must terminate the old process tree or replace the worker container before starting a replacement owner.

Exactly one live manager must own a root directory. An exclusive ownership file prevents concurrent managers. Stale ownership is reclaimed only when the recorded PID is verifiably dead on the same host; live, cross-host, malformed or unverifiable owners are refused. A recovery reservation serializes reclamation. If a crash leaves an incomplete ownership/recovery file, an operator must first verify that the old manager and its processes are gone before removing that stale reservation. PID reuse is conservative: an unrelated live PID prevents reclamation rather than permitting concurrent ownership. Separate workers need separate roots or volumes. Stable worker identity and routing to the owner belong to the Station service layer; sharing a volume between concurrent managers is unsupported.

## Runtime and deployment

The initial backend targets Node 20+ on POSIX systems and defaults to `/bin/bash`; a custom `shell` must accept Bash's command-line flags. Use normal Linux worker services with tools included in their images and persistent storage mounted for workspaces. Restarting or redeploying such a service terminates live commands, even when its storage survives.

`SandboxAdapter` is the extension boundary for host runtimes, containers or VMs. Backends must report their real capabilities. PTY support currently uses node-pty and requires a Node controller. Enabling it on a Bun controller fails explicitly because Bun 1.3.14 did not reliably deliver native PTY output in validation; Bun can still execute ordinary commands/services or run as a Station child runtime. Bun signal/beacon execution remains a separate runtime choice; selecting Bun must not silently imply native-terminal support or stronger isolation.

## Bounded file operations

```ts
await sandboxes.writeFile(workspace.id, "src/config.json", {
  base64: Buffer.from('{"enabled":true}').toString("base64"),
  createParents: true,
});
const listing = await sandboxes.listFiles(workspace.id, "src", { limit: 100 });
const chunk = await sandboxes.readFile(workspace.id, "src/config.json", {
  offset: 0, length: 4096,
});
console.log(Buffer.from(chunk.base64, "base64").toString());
await sandboxes.removeFile(workspace.id, "src/config.json");
```

Paths are relative to the workspace; absolute paths, parent traversal, NULs and symlink components are rejected. Directory listings report symlinks without following them and return a pagination offset; a changing directory can change pagination order. Reads are binary-safe base64 ranges with `bytes`, `totalBytes` and `nextOffset`. Reads and writes default to a maximum 1 MiB per operation, configurable with `maxFileBytes` up to 16 MiB. File writes validate canonical base64, write a private temporary file and rename it atomically. Directory removal requires `recursive: true`; the workspace root cannot be overwritten or removed through file APIs.

The host file checks are not an OS isolation boundary or protection against hostile concurrent shell processes swapping parent paths. Commands still run with the worker user's permissions. Use an isolated execution adapter and appropriate mount policies for untrusted code.

## Reconnectable interactive terminals

Install `node-pty` with native builds enabled and configure `enablePty: true` on the host adapter. The default terminal limit is eight; `maxTerminals` controls active terminals independently of bounded commands and services.

```ts
const sandboxes = new HostSandboxAdapter({ rootDir: "/data/workspaces", enablePty: true });
const workspace = await sandboxes.create();
const terminal = await sandboxes.openTerminal(workspace.id, { cols: 100, rows: 30 });
await sandboxes.terminalInput(workspace.id, terminal.id, "node --version\r");
let cursor = 0;
const output = await sandboxes.terminal(workspace.id, terminal.id, cursor);
cursor = output.nextOffset;
console.log(output.data);
await sandboxes.resizeTerminal(workspace.id, terminal.id, 120, 40);
await sandboxes.closeTerminal(workspace.id, terminal.id);
```

Terminals start a real interactive Bash shell. Exported variables, working directory and installed tools remain available within that session. Input uses terminal control sequences, so carriage return submits a command and Ctrl-C can interrupt foreground work. Input is capped at 64 KiB per call by default (`maxTerminalInputBytes`); dimensions must be between 1 and 500.

`terminals` lists handles; `terminal` reads the bounded UTF-8 output ring. Its offsets count bytes. Retain `nextOffset` and pass it on reconnection to the same live worker/session. `startOffset` identifies the oldest retained byte and `truncated` reports missed output; `offset` gives the actual UTF-8 boundary returned. Terminal output is a raw terminal stream, not HTML; render it with a terminal emulator or as escaped text.

The ring uses `maxOutputBytes` and stays in memory. Terminal metadata and bounded completed-handle history are saved, but a worker restart marks former live sessions interrupted and resets their output ring. Reconnectability means reconnecting a client to an existing live session, not restoring a shell after a host crash. Cleanup hangs up the terminal and escalates its owned process group if needed; deliberately detached processes remain outside host containment guarantees.

The [node-pty installation guide](https://github.com/microsoft/node-pty) describes native build prerequisites. On macOS, some prebuilt package installations can leave `spawn-helper` without an executable bit. Enabling PTY checks that helper and reports an unsupported error; it never modifies dependencies at runtime. Repair the installed helper's execute permission or rebuild node-pty during deployment preparation. A successful module import alone is not enough to establish that PTYs can spawn. Real PTY and loopback service tests need OS permissions unavailable in some restricted test runners.

## Supervised long-lived services

```ts
const service = await sandboxes.startService(workspace.id, {
  name: "preview",
  command: "node server.cjs",
  restart: { policy: "on-failure", maxRestarts: 3, delayMs: 1000 },
});
console.log(await sandboxes.service(workspace.id, service.id));
await sandboxes.stopService(workspace.id, service.id);
await sandboxes.restartService(workspace.id, service.id);
// Remove a definition and stop its process:
await sandboxes.removeService(workspace.id, service.id);
```

Services use the same working directory, home and installed-tool PATH as commands and terminals. Names are unique per workspace. The default policy is `never`; `on-failure` retries nonzero or signalled exits, and `always` also retries clean exits. Every policy has a finite restart budget (0–1000) and fixed delay (10–60,000 milliseconds). Automatic restarts consume that budget; an explicit restart resets it. A service status of `running` means the process started, not that its HTTP endpoint passed a readiness probe.

`services` lists persisted definitions. `service` reports status, the latest attempt's bounded stdout/stderr, restart count and attempt timestamps/exit codes. At most 100 attempts per definition are retained, further limited by `maxHistoryPerSandbox`. `maxServices` defaults to 16 retained definitions across the manager, including stopped definitions; remove unused services to free capacity. Concurrent lifecycle mutations of one service return `busy`. Stop cancels pending backoff and terminates the current process group with bounded escalation.

Graceful worker shutdown marks active services interrupted. Recovery retains their definitions and last saved history but does not automatically restart them, even when their within-worker crash policy was `always`. An operator/controller must explicitly restart after verifying old processes are gone and retrying side effects is appropriate. Live output is saved at transitions/exit, so output just before a hard crash may be lost. Metadata persistence errors stop new facility admission. The service layer does not provide endpoint routing, readiness probes, persistent process memory, OS quotas or high availability by itself.
