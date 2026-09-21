# Compiled Station Images

Use `station-images` when code is authored independently of Station's TypeScript builders. The image contains a `station.image/v1` manifest and content-addressed artifacts; it does not contain an OS filesystem. Read the [complete guide](https://github.com/porkytheblack/station/blob/main/docs/STATION-IMAGES.md) for runnable authoring examples and the bounded protocol/schema contracts.

## Authoring and configuration

- Native programs must be compiled for declared OS/architecture/ABI; bundled JavaScript declares `node` or `bun` plus minimum runtime major. Bun standalone output is native. Publish prebuilt files with exact SHA-256 digests and sizes; there is no remote build/install pipeline or archive extraction.
- Exports are signals, binary broadcast planners or beacons. Finite programs read an NDJSON `station.process/v1` invocation and emit a result. Broadcasts return a declarative DAG referencing only declared signals; the saved plan survives restart. Beacons use the long-lived protocol and scoped dependency broker. Do not invent nested broadcast DAG nodes or arbitrary JavaScript plan expressions.
- Configure daemon `registry.rootDir` and `registry.execution`. Docker policy belongs to the operator: digest-pinned Linux runtime, compatible target, non-root, read-only filesystem, no network, resource limits and seccomp. Engines with an unconfined default need an explicit reviewed deny-default `seccompProfile`. Trusted-local execution needs explicit unsafe opt-in and is unsuitable for uploaded untrusted code.
- Grant environment keys through `registry.execution.allowedEnv` and the daemon environment store; manifests can declare required/default values. There is no arbitrary `/registry/run` environment override or implicit controller-secret inheritance.

## CLI and network workflow

```sh
station images publish ./station-image.json --artifacts-dir ./build --context headquarters
station images inspect acme/tools@1.0.0 --context headquarters
station images install acme/tools@1.0.0 --context headquarters
station images run acme/tools@1.0.0 echo --input @request.json --context headquarters --station coding-worker
```

Use an authenticated admin context. References use `name@version`, `name@tag` or a digest, not Docker colon tags. Run returns an ID and does not imply waiting. APIs under `/api/v1/registry` include blobs, images, resolve, tags, pull, install and run; run accepts `{reference, export, input, stationId?}`.

Configured workers eagerly synchronize the Headquarters catalog, validate compatible dependency closures and advertise installed immutable definitions. Shared durable queues/membership remain necessary. Unsupported targets skip; corrupt blobs/records or invalid grants fail explicitly. There are no on-demand preparation reservations or customer-scoped catalogs.

Contexts choose endpoints; optional `--station` pins signal execution and broadcast planner/children durably. Pinned beacons require the selected worker's context and its own ID; Headquarters remote-targeted beacon creation fails. Pins do not silently move on worker failure. Tags affect future requests; retain immutable definitions and blobs needed by queued runs and plans.

## Cleanup and verification

Run `station-image-reaper --config /etc/station/image-reaper.json --interval-ms 5000` as an independent host service with the same Docker options/root directory. Journals and matching container labels protect ownership; expiry cleanup still works after controller death. Runtime timeout alone is not sufficient for hostile code. Reaper config contains no invocation credentials and must be a regular file without group/world write access.

The source checkout has real Docker integration tests for native/JS execution, isolation settings, timeout cleanup and independent reaping. They are opt-in and skipped checks are not validation. See the complete guide for fixture compilation and environment variables. Production host/fleet/storage recovery requires its own acceptance; operator APIs, containers and version 3.0 do not establish public multi-tenant readiness.
