# Execution dashboard E2E

Run after building the Station packages and the StationKit Next.js dashboard:

```sh
node packages/station-kit/test/e2e/dashboard.mjs
```

The harness starts a real production Next standalone server, a Headquarters service, and separate private Station processes for Sandbox, Bun Browser Use and Playwright Browser Use. These processes share SQLite network membership by default. Playwright drives the public Headquarters dashboard and logs in using its actual username/password form; execution mutations go through the UI and Headquarters routing.

Requirements: Node, Bash, npm, Bun with WebView, installed Playwright Chromium and its system dependencies, plus permissions to launch browsers/processes and bind loopback ports. This is an explicit E2E suite, outside the default unit-test filename glob. It does not build or install browser dependencies automatically.

Coverage:

- Authenticated discovery and selection of specialized workers.
- Workspace creation and an actual offline npm global install from an npm-packed local fixture.
- Running the installed CLI by plain name in a fresh command.
- A second workspace does not inherit the first workspace's installed CLI. This verifies install placement, not security isolation.
- Full owner Station process stop/start on the same filesystem; the original workspace and CLI remain usable.
- Nonzero command exit/stderr, cancellation, a configured timeout and workspace deletion removing installed files.
- Real Bun WebView and Playwright navigation, clicks, typing, keypresses, evaluation, PNG rendering and download, and closing a session during a never-settling evaluation.
- Dashboard JavaScript error collection and graceful fixture cleanup.

Screenshots and a machine-readable summary remain in a temporary artifact directory printed at the end. Set `STATION_E2E_ARTIFACTS` to select another directory. Failed-run workspace data is retained for diagnosis; successful-run workspace data is removed.

To verify discovery and routing with PostgreSQL instead of SQLite, set `STATION_E2E_DATABASE_URL` to a test database connection string. The harness creates two tables under a randomly generated `station_e2e_…` prefix and drops those tables during cleanup. It does not use or modify ordinary Station tables. Build `station-adapter-postgres` first. This option tests the network registry through PostgreSQL; workspace files still reside on the sandbox worker's local persistent directory.
