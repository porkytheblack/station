# station-runtime-cli

The Station 3 command-line client. It owns the `station` executable, independently of `stationd` and the web dashboard. Install `station-daemon` and/or `station-dashboard` separately in the same project or alongside the CLI when local service management is needed. Remote-only clients need neither package.

```sh
# Configure a remote connection. The token comes from stdin, not shell history.
station context add production --url https://hq.example.com --token-stdin
station context use production
station status
station signals
station signal run summarize --input @request.json
station tui

# Start independent local processes. Closing this terminal stops neither one.
station init ./my-station
station daemon start --config ./my-station/station.config.ts --port 4400
station context add local --url http://127.0.0.1:4400
station dashboard start --context local --port 4401
station daemon status
station dashboard stop
station daemon stop
```

Saved contexts live under `~/.station/cli` (`STATION_CLI_HOME` overrides it), with directory mode 0700 and credential file mode 0600. Context listings never show tokens. `--identity` pins an expected daemon identity; `--tenant` selects the restricted tenant execution API. Remote endpoints require HTTPS. Commands check the Station 3 handshake. Context replacement requires explicit removal first.

The TUI provides nested catalogs, details, worker-owned sandbox/browser resources, paging, filtering, refresh and Back. Run lists show the latest 200 entries. It pins its selected connection until exit. Supported actions display the exact endpoint/owner/resource and require typing `yes`; input parameters come from an explicit JSON file and are not echoed in the confirmation. Operator event streams reconnect with bounded backoff and replay cursors; missed history triggers a state refresh. Current views also reconcile every five seconds when no prompt is being edited. Tenant contexts poll authorized resources without subscribing to the global event feed. Identity changes disable mutations; failed mutations are never resubmitted. `station api` exposes other daemon JSON operations.

Worker enrollment is separate from CLI contexts. On Headquarters, configure `network.enrollment: { authority: true }` and operator authentication, then issue an invitation for a fixed worker identity:

```sh
station network invite worker-a --out worker-a.invitation.json --ttl-ms 300000
# Transfer the invitation securely to the worker host, preserving mode 0600.
station network join --file worker-a.invitation.json --out worker-a.enrollment.json
station network members
station network revoke worker-a
# On the worker, voluntarily leave using its private configuration:
station network leave --file worker-a.enrollment.json
```

`join` and `leave` also accept `--file -` for bounded stdin and need no saved context. Invitations bind the fixed HTTPS Headquarters origin (loopback HTTP for local development), network and worker identity; joining verifies the returned identities. The new mode-0600 enrollment file contains `role: "station"` and `network: { id, stationId, enrollment: { url, credential } }`. Load these fields into the worker's daemon configuration, configure worker authentication, and provision shared durable adapters separately. Enrollment does not copy database credentials or start a worker. Both invitation and output configuration contain secrets and must stay out of source control. Commands print only non-secret receipts, reserve new output files before consuming invitations, and never automatically retry enrollment mutations. If a join succeeds remotely but its response is lost, revoke the worker and issue a new invitation; rerunning does not recover the one-time credential. Leaving revokes admission but keeps the local credential file for explicit operator cleanup.

## Sandbox and Browser Use

```sh
station sandbox stations
station sandbox create --station coding-worker
station sandbox exec WORKSPACE_ID --station coding-worker --command 'git status'
station sandbox listFiles WORKSPACE_ID --station coding-worker --json '{"path":"."}'
station sandbox openTerminal WORKSPACE_ID --station coding-worker --json '{"options":{"cols":100,"rows":30}}'
station sandbox terminalInput WORKSPACE_ID --station coding-worker --json '{"terminalId":"TERMINAL_ID","data":"ls\n"}'
station browser open --station browser-worker
station browser execute SESSION_ID --station browser-worker --json '{"command":{"op":"pages"}}'
station browser recordingStart SESSION_ID --station browser-worker
station browser close SESSION_ID --station browser-worker
```

Every server-supported execution method is available through these wrappers. The method and resource ID are positional; all remaining fields use `--json JSON`, `--json @file.json` or `--json -` for stdin. These wrappers cover file transfers, processes, services, terminals, browser actions, profiles, recording and control leases using the server's existing schemas. The dedicated file commands below perform binary encoding locally; generic JSON methods retain the API encoding. Unsupported backend capabilities remain explicit server errors.

```sh
station api GET /runs
station api POST /schedules --json @schedule.json
station api PATCH /env/VARIABLE_ID --json -
station events
```

There is no implicit retry of stateful operations. Closing CLI/TUI does not stop resources. Live terminal/control operations obey the daemon's lease and timeout rules.

Interactive shells attach to a worker-owned PTY:

```sh
station sandbox shell WORKSPACE_ID --station coding-worker --cwd project
station sandbox attach WORKSPACE_ID --station coding-worker --terminal TERMINAL_ID
```

Ctrl-C reaches the remote process; Ctrl-] detaches while its terminal keeps running. Resizes are forwarded, retained output follows its byte cursor, and raw mode/cursor visibility are restored on detach, process exit or transport failure. Reattaching replays retained output. The worker must support PTYs. Detach never destroys the sandbox or closes the terminal; use `closeTerminal` explicitly when finished.

Local files have explicit source/destination paths; downloads never overwrite existing files:

```sh
station sandbox upload WORKSPACE_ID --station coding-worker --file ./input.bin --path assets/input.bin --parents
station sandbox download WORKSPACE_ID --station coding-worker --path results/output.bin --out ./output.bin
station browser upload SESSION_ID --station browser-worker --file ./photo.png --selector 'input[type=file]' --mime image/png
station browser execute SESSION_ID --station browser-worker --json '{"command":{"op":"download","selector":"a.download"}}'
station browser download SESSION_ID --station browser-worker --artifact ARTIFACT_ID --out ./download.bin
station browser screenshot SESSION_ID --station browser-worker --out ./screen.png
```

Uploads are limited to 4 MiB. Sandbox downloads read in 1 MiB pages with a 64 MiB local cap; the file must remain unchanged during the transfer. Browser downloads/screenshots are limited to 8 MiB after decoding. Backend policy can impose smaller limits. Browser upload and screenshot support `--control-token` when operating an acquired human-control lease. A download reads an existing browser artifact; it does not silently click a link or delete the remote artifact.

## Registry

```sh
# Build a directory bundle from a template and already compiled artifact files.
station images build ./template.json --artifacts-dir ./build --out ./image
station images validate ./image/manifest.json --artifacts-dir ./image/artifacts
station images pack ./image/manifest.json --artifacts-dir ./image/artifacts --out ./verified-copy
station images publish ./station-image.json --artifacts-dir ./build
station images list
station images inspect acme/tools@1.0.0
station images tag acme/tools --tag stable --digest sha256:FULL_DIGEST
station images pull acme/tools@1.0.0
station images install acme/tools@1.0.0
station images run acme/tools@1.0.0 resize --input @request.json
```

`images build` calculates size/digest fields in a manifest template, validates the image and copies only declared precompiled files into a new directory containing `manifest.json` and `artifacts/`. It does not invoke a compiler, package manager or project script. `pack` preserves and verifies existing hashes; `validate` checks without writing. These three commands work offline without a daemon/context. Existing output directories, final-component symlinks, invalid native executable headers and unsafe basenames are rejected.

Publish reads only explicit manifest artifact basenames from the supplied directory. It verifies every artifact's size/digest before uploading anything, then publishes through the resumable upload API and commits the manifest. Private upload receipts under the CLI home retain upload IDs; rerunning the same command reads the server offset and continues from accepted bytes, including after a lost chunk/commit response. Chunks use the server's advertised size limit and SHA-256 checks. Completed staging is deleted to release its quota; receipt cleanup follows. Transport failures are not retried automatically, and missing upload support fails explicitly without falling back to a different authorization path. It does not compile source, archive directories or include environment files implicitly. The CLI upload cap is 128 MiB per file and 256 MiB total. Operator credentials or an explicitly configured registry-only tenant context are required. `--tenant` registry operations use the server-selected `/tenant/registry` namespace; they cannot target another worker with `--station`. Select a worker's context to publish directly to its registry. Pull requires a configured registry upstream; install/run require the daemon image runtime. Unsupported configurations return explicit errors. `--station WORKER` selects an operator-configured private registry through Headquarters for list/inspect/publish/tag/pull/install. For `images run`, `--station` instead pins execution through the selected daemon’s registry. It never silently moves the publication destination.

## Deployment generations

The configured daemon owns durable deployment generations and authorization. Commands pass structured request bodies without guessing revisions:

```sh
station deployments list
station deployments stage --json '{"name":"tools","reference":"acme/tools@1.0.0","aliases":{"resize":"resize"}}'
station deployments inspect DEPLOYMENT_ID
station deployments activate DEPLOYMENT_ID --json '{"generation":"GENERATION_ID","expectedRevision":0}'
station deployments run DEPLOYMENT_ID --json '{"alias":"resize","input":{"width":640}}'
station deployments rollback DEPLOYMENT_ID --json '{"generation":"GENERATION_ID","expectedRevision":2}'
```

Use the actual generation and revision returned by stage/inspect; stale compare-and-swap revisions fail. These wrappers require a daemon that exposes deployment routes. `--station WORKER` targets that configured private registry through Headquarters.

## Local process management

Local services are Unix processes managed by a detached Station supervisor with a random authenticated loopback control endpoint. Stop requests go to this owner; the CLI never signals a PID read from disk. Starts are locked per instance and idempotent only for the same launch configuration. Ports are checked before launch. Each instance retains a private output log and state file under `processes/<kind>-<instance>`.

`daemon start` explicitly binds loopback and passes its `--port` (default 4400), overriding the corresponding config values. Run `stationd` directly under a service manager for public binds or other operator policies. Dashboard start uses default port 4401, checks its selected daemon connection, and pins the target URL through server environment configuration. It does not copy the CLI token into frontend assets: authenticate separately in the dashboard.

`daemon/dashboard logs` prints the saved log; `--follow` streams new bytes and handles file rotation/truncation until Ctrl-C. Ending the follower does not stop the service. Status distinguishes a live supervisor from an API that is not ready. A startup timeout leaves the process independently managed so you can inspect its logs or stop it. Shutdown sends SIGTERM, waits eight seconds, then kills the still-owned process group. Locks retain a launcher/controller process identity and a separate random process marker. After a reboot or killed launcher, start recovers a lock only when both the recorded process and all marked controllers/services have exited. Concurrent recovery cannot remove a newly acquired lock. A killed controller with a still-running service fails closed. Recovery never signals a saved PID, and ambiguous or legacy locks report the exact path for manual inspection. Retired lock directories are small retained arbitration records; leave them in place while launchers may still be running. There is no remote provisioning, automatic host restart integration, log rotation or crash resurrection. For production daemon supervision use systemd or an equivalent service manager. Windows users can run `stationd` directly; detached local CLI management currently requires Unix.

`station init --role headquarters|station` creates a configuration starting point only. Supply the shared durable adapters, network identity and credentials required for network roles. No automatic enrollment backend is implied.


## Packaging verification

After building the workspace, run `pnpm --filter station-runtime-cli test:packed` from the repository. This opt-in integration check creates local package archives, installs them in independent temporary projects, and exercises the installed CLI, authenticated daemon, real signal execution and standalone dashboard. It verifies the headless install excludes Next/React and the dashboard excludes the daemon, including survival of CLI exit and independent shutdown. It requires npm dependency access, Unix and loopback networking; it never publishes npm packages. Test credentials are removed afterward.

Deployment invocation can pass `environment` bindings only when the active generation explicitly grants their keys in `invocationEnv`; each override records a retained derived generation without changing the active alias pointer. Use environment references for secrets. `station deployments rollout ID --json @rollout.json` forwards `{operationId,expectedRevision,sourceInstance,generation,alias}` for durable stop-before-replace beacon rollout. Reuse the same operation ID after uncertain responses, inspect the deployment rollout record, and expect possible downtime; activation alone does not replace live beacons.
