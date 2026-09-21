# Station 3.0 implementation review

This is a breaking package split plus the first executable Station Image implementation. It is not a declaration that the complete public hosting platform is production-ready. Nothing has been published to npm by this work.

## What is implemented

- `station-daemon` owns the API, runners, network coordination and image registry. It does not launch Next.js.
- `station-dashboard` runs independently and connects to one configured daemon. `station-runtime-cli` and `station-client` connect locally or remotely. The CLI can optionally supervise separately installed local services.
- StationKit is removed from the maintained workspace. All maintained packages target 3.0.0; there is no compatibility facade.
- Immutable Station Images support native executables and bundled JavaScript, with signal, broadcast-planner and beacon exports. Input/output uses a bounded JSON process protocol. Application environment variables must be granted explicitly.
- Headquarters publication is discovered by configured workers, which verify compatible artifacts and dependencies before advertising them. Explicit Station placement survives retries/recovery instead of silently moving to another worker.
- Docker execution uses a pinned operator image, non-root users, bounded resources, read-only filesystems, dropped capabilities, restricted networking and enforced seccomp. An independent image reaper can remove expired owned containers after a controller dies.

See [the package and CLI guide](STATION-3.md), [the detailed image guide](STATION-IMAGES.md), and [the broader design with remaining work](plans/station-images.md).

## Validation evidence

The checks below exercise real behavior where stated; passing a simulated engine contract test is not counted as a live Docker result.

| Area | Evidence |
| --- | --- |
| Daemon | 109 tests passed, including authenticated registry APIs and execution ownership |
| Image integration | 9 tests passed: JavaScript/native execution, granted environment variables, persisted broadcast plans, supervised beacon dependency triggers and Headquarters distribution |
| Placement | Shared SQLite workers exercised signal retries, owner-only execution, beacon restart and expired-lease recovery; broadcast tests verify planner and child placement persistence |
| Broadcasts | 27 tests passed, including cancellation races, durable planning and partial-write recovery |
| Beacons | 58 tests passed |
| SQLite adapters | 40 tests passed, including additive placement migrations |
| Image Docker backend | Five live Docker tests passed: isolation settings, JavaScript execution, compiled Go execution, timeout cleanup and independent reaping |
| Sandbox Docker backend | Three live tests passed with an explicit seccomp profile: custom npm install persistence, files, terminals, services, cancellation, default network denial and killed-controller recovery |
| Browser Docker backend | Live named-volume integration passed: active kernel seccomp, isolation/resource flags, separate cookies, persistent profile restart, page controls, uploads/downloads, screenshots, trace ZIPs, recording recovery and cancellation |
| Seccomp configuration | Six focused tests passed across sandbox and browser adapters; unconfined defaults fail closed |
| Tenant execution E2E | Real Headquarters and two private tenant workers passed: authenticated routing, offline custom tool installation, sandbox file isolation, browser screenshot, cross-tenant denial, admission limits, key revocation and retained-storage ownership checks |
| Dashboard | Live dashboard E2E passed with private workers, custom npm install persistence, terminals, files, services, Bun/Playwright sessions, profiles and recordings |
| Execution policy | Four proxy tests and five provisioner tests passed |
| Package separation | Tarballs installed into independent temporary applications; daemon lacks Next/React/dashboard dependencies, dashboard lacks daemon dependencies; stopping the dashboard leaves the daemon running |
| Workspace regression | Full `pnpm test` passed with zero failures; full workspace typecheck passed |
| Release packaging | All 20 package dry runs passed with `node scripts/release-npm.mjs --dry-run --allow-dirty --skip-checks`; full tests and typechecking were run independently |
| Release access checks | 10 release-script tests passed, including foreign ownership, team grants, read-only access and unauthenticated dry-run behavior |

The live image, sandbox and browser tests used Docker Desktop's Linux arm64 engine and an explicitly supplied official Moby 27.5.1 deny-default seccomp profile. This engine advertises an unconfined default; these backends refused that configuration until the profile was supplied. These tests do not validate a production Linux host's filesystem quotas, egress policy, HA configuration or VM isolation.

## Remaining limits

- Image registry operations currently require operator privileges. Customer-scoped image publication, tenant registry namespaces and the complete public deployment authorization model are not implemented.
- The CLI has explicit commands and generic API access. Its TUI is read-only; interactive provisioning, terminal attachment and full image deployment/dashboard workflows remain future work.
- No VM backend, automatic network enrollment, deployment generation/rollback manager or registry garbage collector is implemented.
- Durable adapters other than SQLite were typechecked, but placement changes have not been exercised against live PostgreSQL, MySQL or Redis servers.
- The existing bounded pending-job scan can delay eligible work behind a large backlog for offline workers. It does not permit another worker to take a pinned job.
- Docker shares the host kernel. Public operation still requires deployment-specific isolation, storage quota, network, recovery and capacity acceptance tests. A trusted-host backend is for trusted code only.
- External image side effects remain at-least-once. Applications must implement their own idempotency where needed.

## Release procedure

Review and commit the changes before a live release: the release script rejects a dirty tree. Run `pnpm release --dry-run` for the full preflight and package validation, then `pnpm release` only when ready to publish. A local dry run does not change previously published StationKit packages or deprecate them on npm.

The CLI package is `station-runtime-cli`, with executable `station`. The unscoped `station-cli` name belongs to another npm publisher; no personal namespace is used. At validation time, `npm whoami` returned 401, so npm login must be renewed before publishing. An unauthenticated dry run verifies packaging only and reports publish access as unverified. Authenticated runs check effective write access before building or uploading; npm can still require publish-time 2FA or additional token permissions.
