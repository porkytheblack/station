# station-sandbox

Persistent POSIX workspaces and supervised shell commands for Station workers. This is a separate primitive from `station-browser-use`: a workspace does not implicitly own a browser session.

`HostSandboxAdapter` runs real Bash and native programs installed on the worker. It does not emulate Unix, install Node or Git, or require Docker. Package the tools into your worker image, or install them on the host and expose them through `PATH`. Multiple workspaces can use those shared tools while keeping separate working directories and home directories.

This is a **trusted-code backend**. Commands run as the worker's operating-system user and can access anything that user can access. Workspace paths and separate `HOME` directories organize work; they do not provide tenant isolation. The adapter advertises `isolated: false` and `pty: false`. Use a future container or VM adapter for stronger isolation, and do not give untrusted public clients direct command access.

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

The public adapter contract provides create, list, get, destroy, exec, command, cancel and close. File operations currently use shell commands; there is no separate file-transfer API. `cwd` accepts existing relative directories within the workspace; absolute paths and symlink escapes are rejected for this starting directory. This check does not restrict what the command itself can open or change.

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

Each command starts a fresh Bash process with profiles disabled. Shell variables, changed directories and shell bindings do not carry into the next command. Files do. Input is noninteractive; stdin and PTYs are not supported in this adapter.

`exec` returns immediately with a command identifier. Poll `command` for output and wait for `finishedAt` before treating the result as final. Cancellation or a timeout may change the status before process cleanup has completed. `cancel` waits for cleanup. Nonzero exit codes and spawn errors produce failed results.

Defaults are 20 workspaces, four commands running across the adapter, a combined 256 KiB stdout/stderr capture limit, a 30-second command timeout with a configurable five-minute maximum, and 100 completed command records per workspace. UTF-8 output is decoded across chunks and incomplete trailing characters are omitted at the byte cap. Output beyond the cap is drained and discarded. Older completed records are deleted automatically and become unavailable through `command`.

These limits bound admission, captured output and retained command history. They do not impose CPU, memory, disk-use, network or subprocess-count quotas on commands; provision operating-system or container limits separately. Workspace files can grow until the host volume fills or the application removes them.

Commands are bounded jobs: ordinary descendants in the command's process group are terminated when the shell exits, is cancelled, times out, or the adapter closes. Termination escalates to SIGKILL if necessary. Processes that deliberately escape the group are outside this backend's supervision guarantees. Persistent daemons and reconnectable terminals require a different lifecycle implementation.

Host environment variables are not inherited wholesale. Children receive the composed `PATH`, a locale, the workspace-local npm prefix default, explicitly supplied `env` values, and the workspace's assigned `HOME` and temporary directory. Do not put secrets in a shared environment unless all workspaces using this adapter may access them.

## Persistence and recovery

Mount `rootDir` on persistent storage. Each workspace stores its own home, working files, sandbox metadata and bounded command-result history. `close` interrupts active jobs and preserves files; `destroy` removes the workspace and requires all its commands to have finished or been cancelled.

On reopening, records left in `running` become `interrupted`. Commands are never automatically replayed. A new worker can inspect saved files and decide the next action, but live process memory, shell sessions and unpersisted output are not restored. Interrupted work may already have produced external effects; callers must decide whether retrying is safe.

Metadata writes use temporary files and rename. Malformed records fail recovery explicitly; command-result persistence failures surface as storage errors while the manager remains alive and stop admission of new commands and workspaces. This is local-file persistence, not a transactional distributed job store or a guarantee against sudden power loss. Recovering a root after a manager crash also does not discover or adopt surviving orphan processes: the supervisor must terminate the old process tree or replace the worker container before starting a replacement owner.

Exactly one live manager must own a root directory. This is a deployment requirement, not a cross-process lock implemented by this package. Separate workers need separate roots or volumes. Stable worker identity and routing to the owner belong to the Station service layer; sharing a volume between concurrent managers is unsupported.

## Runtime and deployment

The initial backend targets Node 20+ on POSIX systems and defaults to `/bin/bash`; a custom `shell` must accept Bash's command-line flags. Use normal Linux worker services with tools included in their images and persistent storage mounted for workspaces. Restarting or redeploying such a service terminates live commands, even when its storage survives.

`SandboxAdapter` is the extension boundary for future host runtimes, interactive terminal implementations, containers or VMs. Backends must report their real capabilities. Native Bun process or terminal support is separate work; selecting Bun must not silently imply terminal support or stronger isolation.
