# Station Sandbox and Browser Use implementation plan

Status: first slice implemented and verified for the 2.4.0 release. See [completion report](./station-execution-report.md). Working names: `station-sandbox` and `station-browser-use`. These are separate primitives, with separate adapters, lifecycle and optional worker services.

## Goal

Run a public Headquarters service and private specialized Station workers on ordinary Linux services, including Railway. Each worker owns persistent workspaces and supervises real host processes. Browser control belongs to the independent `station-browser-use` primitive. This first backend is for trusted workloads; workspace directories are not a security boundary.

## First slice (this change)

- A standalone `station-sandbox` package with an explicit environment adapter contract.
- Host-process environments: persistent workspace metadata, command start/status/cancel, bounded output, timeouts, worker concurrency and orderly shutdown.
- Environment IDs remain paired with stable station IDs. Headquarters routes to that exact owner; it never silently recreates an unavailable session elsewhere.
- Separate `station-browser-use` package: Bun WebView and Playwright adapters, navigation, input, evaluation, PNG screenshots and cleanup. A Bun subprocess owns each WebView session so Chrome profiles are not shared across sessions. Headquarters can remain on Node.
- Opt-in StationKit API. Public operations require admin authentication even when legacy Station APIs allow unauthenticated access. Private worker calls use a distinct shared service token.
- A multi-worker example and Railway deployment instructions using the existing network/queue adapters. No cloud resources are provisioned by this change.
- Opt-in Node/Bun process runtime adapters for signals and beacons, independent of the controller and browser adapters.
- Tests with real shell processes, authenticated Headquarters-to-worker requests and a real headless browser.

## API shape

Headquarters exposes `POST /api/v1/stations/:stationId/execution/:primitive`, with `primitive` set to `sandbox` or `browser`. Requests have a `method` field and method-specific arguments. Keep the owning station ID alongside each returned resource ID. Sandbox methods are create/list/get/destroy/exec/command/cancel. Browser methods are open/list/action/close. Workers expose `POST /internal/execution/:primitive`, protected by the separate service token. No automatic retry of mutations after an ambiguous network failure.

Workers use their registered private endpoint. Keep all services in the same Railway project environment; expose a public domain only for Headquarters. A worker may advertise labels such as `kind=coding` or `kind=browser`. Existing signal placement still handles scheduled jobs; interactive sandbox commands are directed to a chosen worker rather than queued as migratable jobs.

## Subsequent slices

1. Durable sandbox placement directory: select an eligible worker automatically, reserve capacity atomically and return a stable owner handle.
2. Reconnectable streaming command output and real PTYs, including input/resize, bounded retention and session authorization.
3. Per-tenant authorization and stronger execution isolation before accepting mutually untrusted code. Docker/VM/provider adapters must declare capabilities and reject unsupported requirements.
4. Workspace-aware scheduled signals and browser jobs, idempotency keys, draining, leases/fencing and recovery across worker failure.
5. Browser tabs, downloads/artifacts, persistent profiles, idle expiry and optional alternative browser backends. Do not promise live browser restoration from disk alone.
6. Load tests, admission policies, operational metrics, fleet upgrades and release versioning.

## Persistence and limits

Use one process per worker root and a dedicated persistent volume. Files and metadata survive replacement; shell state and browser sessions do not. Interrupted commands must be reported as interrupted after restart, never replayed automatically. Shared tools are installed into the image and selected through a controlled environment; worker secrets are not inherited by default. Arbitrary trusted shell code still has the OS permissions of the worker.

The prototype does not provide exactly-once effects, process migration, filesystem confinement, a tenant boundary, a package installer or a browser PWA execution backend. Workspaces are addressable directories on a native POSIX host. No Bun migration is required.

## Verification

Check file persistence, restart interruption, command exit/failure, output truncation, timeout/cancel/shutdown, concurrency, invalid input and path traversal. Verify admin-only public access, internal-token enforcement, exact-owner routing, expired/offline/cross-network rejection and no credential forwarding to arbitrary caller URLs. Exercise Playwright against a local fixture, including a valid screenshot and context cleanup. Run affected workspace checks and release-manifest tests.
