# Hermes in a Station sandbox

This example runs a real Hermes Telegram gateway inside a Docker-backed Station workspace. Station owns the container, service supervision, command execution, files and terminal. Hermes executes its tools locally **inside that container**. No Docker socket, host home directory or host credentials are mounted into the workload.

## Deployment layout

- Dashboard: http://127.0.0.1:5801.
- Daemon: http://127.0.0.1:5800 — authenticated, bound to loopback.
- Worker: `hermes-worker`; workspace ID is in `.station/hermes/sandbox.json`.
- Dashboard login: private `.station/hermes/dashboard-login.txt`, generated during initialization.
- Telegram: the bot identified by your supplied token. When a numeric user ID is provided, only that operator is allowlisted; unknown DMs are ignored and group access is disabled.
- Hermes `0.21.4`, upstream commit `9863e315f1fe1dab65f279b77eeb70b8de1fc8c4`.
- Immutable workload image: resolved from your local build and stored in the private settings.
- Model: OpenRouter `openai/gpt-4.1-mini`. Maximum 20 tool turns per request; terminal/file/memory tools enabled for Telegram. This is a turn limit, not a dollar budget; set a spending limit on the OpenRouter key for a hard financial boundary.

The image contains Node, Python, Bash, Git and Hermes. Workspace files, user-installed tools, Hermes sessions, configuration and memory live in a Docker named volume mounted at `/home/node`. Hermes uses `/home/node/.hermes`; the file explorer shows `/home/node/workspace`. The shell can access both. Provisioning reads credentials from the supplied files and installs them over Docker stdin, never in image layers or command arguments.

The container runs as UID 1000 with a read-only root, all Linux capabilities dropped, no-new-privileges, an explicit Moby seccomp profile, 3 GiB memory, 2 CPUs, 256 PIDs and 64 MiB temporary storage. The profile source is Moby v27.5.1 `profiles/seccomp/default.json`. Outbound networking uses Docker bridge so Telegram and OpenRouter work. This is not an egress allowlist. No container ports are published. Processes in this one sandbox communicate through `127.0.0.1`; this example does not provision cross-sandbox service discovery.

## Use it

Open **Sandboxes → Hermes Docker worker → workspace → Terminal → Open terminal**. Useful commands:

```sh
hermes --version
hermes gateway status
hermes chat --cli
cat hermes-smoke.txt
station-check
```

After provisioning, the gateway runs under Station. Do not start a second gateway or install a second supervisor from inside the shell. Send the Telegram bot a message to start your own conversation. A real incoming Telegram conversation still needs the operator's first message; only connectivity, configuration and an independent model/tool invocation have been verified so far.

Use **Services** to inspect the `hermes-gateway` status and bounded output. Closing the browser tab leaves the shell and service running. **Force-closing a terminal, cancelling/timing out a Station command, or stopping a service can stop the whole container for containment**, interrupting sibling services. Use **Services → Restart** on Hermes afterward. This is a material limitation for mixed interactive/always-on workloads in the current adapter. Ordinary successful bounded commands were verified alongside Hermes.

## Compose deployment (current approach)

`compose.yaml` runs the controller and dashboard in separate containers. Only the controller mounts the host Docker socket. Hermes stays in its own Station-managed sibling container, with the existing persistent named volume. The dashboard has its own network namespace and connects over verified HTTPS on the private Compose network. It mounts only the public trust certificate, with no Docker socket or private state mount. Both published ports remain host-loopback-only.

The controller uses Docker's restart policy and an exclusive `flock` on its state directory. Its stable hostname lets the entrypoint reconcile stale PID metadata after a crash, only after obtaining that exclusive lock. Do not bypass this entrypoint or run another controller against the same state. Do not scale this single-controller Compose service horizontally.

From the repository root:

```sh
docker compose -f examples/20-hermes-sandbox/compose.yaml build
docker compose -f examples/20-hermes-sandbox/compose.yaml up -d --wait
docker compose -f examples/20-hermes-sandbox/compose.yaml ps
docker compose -f examples/20-hermes-sandbox/compose.yaml logs --tail 50 station
docker compose -f examples/20-hermes-sandbox/compose.yaml restart
docker compose -f examples/20-hermes-sandbox/compose.yaml stop
node examples/20-hermes-sandbox/backup.mjs
```

Private state defaults to the existing `.station/hermes` directory. To use another initialized directory, set `STATION_DATA_PATH` to its absolute path for Compose and `STATION_DATA_DIR` to the same path for host provisioning/backup helpers. The Docker engine must already contain the pinned Hermes image. The running stack needs no host Node daemon; Node on the host is only used by the one-time setup and backup helpers.

Initialization generates a private TLS key and a one-year certificate for the internal `station` hostname; OpenSSL is required on the setup host. Only the controller receives the key. For an existing deployment, run `node examples/20-hermes-sandbox/tls.mjs` before starting this Compose configuration. Renew before expiry: stop both Compose services, archive the old TLS files privately, remove those two files from the state directory, run the TLS helper, then recreate both services so the dashboard loads the new trust certificate. Never disable certificate verification.

For migration from the original local-process setup: take a backup, run `node examples/20-hermes-sandbox/manage.mjs stop`, then start Compose. The first successful container startup marks this state as Compose-owned, preventing accidental launches through the old local manager. A reverse migration requires stopping Compose, verifying it released ownership, and explicitly removing `runtime.json`; do not delete live lock files. Both controllers must never run concurrently.

Compose controls the two control-plane containers. A sandbox is not a Compose service: `compose down` does not delete the agent volume or sandbox container. Use Station's lifecycle API for workspace deletion. Stopping the controller gracefully stops live sandbox processes and preserves desired service state for recovery. If the controller is killed, workload processes may continue until recovery reconciles them.

Only the trusted controller has Docker access, which is effectively host-administration access. The dashboard runs as a non-root user with a read-only filesystem. No service uses privileged mode. Resource limits are separate for controller, dashboard and sandbox. The controller's health check tests API responsiveness; it does not certify bot delivery or model availability. `restart: unless-stopped` handles exited containers, not merely unhealthy ones.

## Original local-process mode

Before migration, the following commands manage host Node processes. After Compose takes ownership, use Compose instead:

```sh
node examples/20-hermes-sandbox/manage.mjs status
node examples/20-hermes-sandbox/manage.mjs stop
node examples/20-hermes-sandbox/manage.mjs start
node examples/20-hermes-sandbox/backup.mjs
```

CLI-managed daemon/dashboard processes are detached from this chat. Hermes has an `always` restart policy: 10-second delay, maximum 100 restarts, including restarts carried over in its persisted service record. Inspect failures instead of relying on an unlimited crash loop. Starting the daemon recovers services whose desired state is running. Dashboard restarts are independent of the daemon.

`backup.mjs` detects Compose ownership, stops the appropriate services, archives the persistent home volume, copies controller metadata and private settings, then restarts them. It interrupts terminals. Backups are under `.station/hermes/backups/`, are private, and **contain credentials**. Encrypt them before transferring off-host. A local archive is not an off-machine disaster-recovery strategy. Do not run Docker volume prune against this deployment.

For recovery, preserve the matching controller metadata, volume data and immutable image. Stop the daemon before restoring. Restore the archive into the workspace's original named volume, restore the matching `workspaces/`, `daemon/`, settings, API key, seccomp files and (for Compose) `runtime.json`, `tls-key.pem` and `tls-cert.pem`, then start Station. Do not restore old CLI supervisor PID/lock state. A full replacement-host restore has not been tested; only archive extraction and same-host daemon recovery have.

## Reproduce a fresh setup

Requires built Station packages/dashboard, Node 22+, `node-pty`, Docker and an operator-reviewed Docker-compatible seccomp profile. Build context must be an unmodified, credential-free upstream checkout:

```sh
git clone https://github.com/NousResearch/hermes-agent.git /tmp/hermes-source
git -C /tmp/hermes-source checkout 9863e315f1fe1dab65f279b77eeb70b8de1fc8c4
docker build -f examples/20-hermes-sandbox/Dockerfile -t station-hermes:9863e315 /tmp/hermes-source
node examples/20-hermes-sandbox/initialize.mjs station-hermes:9863e315 /path/to/reviewed-seccomp.json
docker compose -f examples/20-hermes-sandbox/compose.yaml build
docker compose -f examples/20-hermes-sandbox/compose.yaml up -d --wait
node examples/20-hermes-sandbox/provision.mjs /path/to/openrouter-key.txt /path/to/telegram-token.txt TELEGRAM_NUMERIC_USER_ID
```

Initialization uses the dashboard username `operator`; set `STATION_ADMIN_USERNAME` to choose another name. It refuses to overwrite an existing deployment. Image IDs are pinned in settings and workspace metadata. Changing the setting alone does not upgrade an existing workspace: plan an offline migration with a backup. Python dependencies use the upstream frozen `uv.lock`; Debian package repositories are not snapshot-pinned, so rebuilds can include OS security updates.

Provisioning without a Telegram user ID defaults to human-approved pairing. With an ID it sets allowlist-only DMs, ignores unknown senders and disables groups. Re-provisioning a running gateway updates files; restart the managed daemon to load the updated credentials/policy. It preserves existing model/tool configuration.

## Verification performed on 2026-09-22

- Real Hermes/OpenRouter request invoked the terminal tool, wrote `hermes-smoke.txt`, and reported its contents; independently read back through Station.
- Dashboard sign-in, workspace navigation and interactive PTY worked; the shell saw the same file.
- Installed a small custom executable under `~/.local/bin`; it was available on PATH and survived restart.
- A Node HTTP server and separate curl process communicated over sandbox localhost without publishing a port.
- Injected SIGKILL into the gateway only; Station restarted it and Telegram polling reconnected.
- Offline backup, full daemon restart and automatic gateway recovery succeeded; custom tool and workspace content persisted.
- Extracted the test file from the backup and verified its contents.
- Compose controller SIGKILL recovered automatically; the separate dashboard reconnected over verified TLS and Hermes resumed Telegram polling.
- A duplicate controller was rejected before daemon startup; a container with no Docker socket failed closed.
- Compose offline backup retained the custom install, workspace content, controller metadata and TLS identity; both services restarted healthy afterward.
- Effective configuration had the requested Telegram allowlist, unknown-DM ignore and disabled groups.

This is a persistent **single-operator local deployment**, not a highly available production service. Docker Desktop and the Mac must stay running and awake. Compose supplies container restart policies; it does not start Docker Desktop, wake the Mac or provide failover. Moving to an always-on Linux host needs boot supervision, disk quotas/monitoring, off-host backups, restore drills and host-level validation. Current Debian Python links SQLite 3.40.1; Hermes detects its WAL issue and deliberately uses DELETE journaling. Validate an updated embedded SQLite runtime before increasing database concurrency. Secrets remain readable by trusted code inside this sandbox, including the agent; do not run unrelated tenants here.

## Engine unavailable and cleanup

Without a reachable Docker engine, this container-backed deployment refuses startup. It never changes to host-process execution automatically. A lost engine connection during operation makes Docker actions fail; that alone does not prove a workload has stopped. Restore engine access and reconcile by restarting the controller, checking the service and reconnecting terminals. Podman is an explicit alternative adapter, not automatic migration of Docker volumes.

`node examples/20-hermes-sandbox/cleanup-docker.mjs` previews stale stopped containers; add `--apply` to remove containers created and last stopped over a calendar month ago, unused images/networks older than that cutoff, and old build cache. It preserves all volumes, Station containers, running containers and recently used stopped containers. The report is written privately to `.station/hermes/docker-cleanup.json`. Review it before broadening cleanup; volume age does not prove the data is disposable.

Upstream references: [Hermes Docker](https://hermes-agent.nousresearch.com/docs/user-guide/docker), [Telegram](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram), [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration).
