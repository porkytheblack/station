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

The TUI is a keyboard-driven, read-only view of health, workers, definitions, runs and execution owners. It pins its selected connection until exit. Perform mutations through explicit commands or `station api`, which exposes the complete daemon JSON API.

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

Every server-supported execution method is available through these wrappers. The method and resource ID are positional; all remaining fields use `--json JSON`, `--json @file.json` or `--json -` for stdin. These wrappers cover file transfers, processes, services, terminals, browser actions, profiles, recording and control leases using the server's existing schemas. They do not offer an interactive terminal attachment or automatic binary upload/download conversion; the API's data encoding applies. Unsupported backend capabilities remain explicit server errors.

```sh
station api GET /runs
station api POST /schedules --json @schedule.json
station api PATCH /env/VARIABLE_ID --json -
station events
```

There is no implicit retry of stateful operations. Closing CLI/TUI does not stop resources. Live terminal/control operations obey the daemon's lease and timeout rules.

## Registry

```sh
station images publish ./station-image.json --artifacts-dir ./build
station images list
station images inspect acme/tools@1.0.0
station images tag acme/tools --tag stable --digest sha256:FULL_DIGEST
station images pull acme/tools@1.0.0
station images install acme/tools@1.0.0
station images run acme/tools@1.0.0 resize --input @request.json
```

Publish reads only explicit manifest artifact basenames from the supplied directory. It verifies every artifact's size/digest before uploading anything, then publishes the manifest. It does not compile source, archive directories or include environment files implicitly. The CLI upload cap is 128 MiB per file and 256 MiB total. Operator API credentials are required. Select a worker's context to publish directly to its registry. Pull requires a configured registry upstream; install/run require the daemon image runtime. Unsupported configurations return explicit errors. Direct Headquarters registry proxying remains unavailable; use a saved context for the target registry.

## Local process management

Local services are Unix processes managed by a detached Station supervisor with a random authenticated loopback control endpoint. Stop requests go to this owner; the CLI never signals a PID read from disk. Starts are locked per instance and idempotent only for the same launch configuration. Ports are checked before launch. Each instance retains a private output log and state file under `processes/<kind>-<instance>`.

`daemon start` explicitly binds loopback and passes its `--port` (default 4400), overriding the corresponding config values. Run `stationd` directly under a service manager for public binds or other operator policies. Dashboard start uses default port 4401, checks its selected daemon connection, and pins the target URL through server environment configuration. It does not copy the CLI token into frontend assets: authenticate separately in the dashboard.

`daemon/dashboard logs` prints the saved log. `--follow` is currently rejected explicitly. Status distinguishes a live supervisor from an API that is not ready. A startup timeout leaves the process independently managed so you can inspect its logs or stop it. Shutdown sends SIGTERM, waits eight seconds, then kills the still-owned process group. Stale/unreachable controllers fail closed; inspect state manually before removing a stale lock. There is no remote provisioning, automatic host restart integration, log rotation or crash resurrection. For production daemon supervision use systemd or an equivalent service manager. Windows users can run `stationd` directly; detached local CLI management currently requires Unix.

`station init --role headquarters|station` creates a configuration starting point only. Supply the shared durable adapters, network identity and credentials required for network roles. No automatic enrollment backend is implied.


## Packaging verification

After building the workspace, run `pnpm --filter station-runtime-cli test:packed` from the repository. This opt-in integration check creates local package archives, installs them in independent temporary projects, and exercises the installed CLI, authenticated daemon, real signal execution and standalone dashboard. It verifies the headless install excludes Next/React and the dashboard excludes the daemon, including survival of CLI exit and independent shutdown. It requires npm dependency access, Unix and loopback networking; it never publishes npm packages. Test credentials are removed afterward.
