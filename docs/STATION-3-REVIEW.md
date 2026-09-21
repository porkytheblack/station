# Station 3 review remediation

The external review identified genuine blockers after the earlier green test run. The earlier recommendation that the package release was ready was too broad. This report records the corrections and the limits of their validation. Public multi-tenant production acceptance still requires the intended Linux host; that work was explicitly deferred because no staging host is available.

## Merge blockers

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| Local daemon cannot restart after abandoned lock | Launcher/controller ownership now records process birth identity and a nonsecret process marker. Recovery checks that no owning launcher, supervisor or surviving service remains; concurrent recovery retains a fenced tombstone. Unknown legacy metadata fails safely with the exact lock path and reconciliation instructions. Recovery never signals saved PIDs. | CLI lifecycle cases cover stale owners, live owners, orphan service protection, concurrent starts and actionable legacy failures. All five lifecycle tests also passed inside a local Linux Docker container, exercising `/proc` birth/boot identity. Intended production-host validation is still deferred. |
| Host Chromium inherits secrets and opens local files | Browser subprocess environment is constructed from an explicit platform allowlist. Navigation/new pages allow HTTP(S) and exactly `about:blank`; the Playwright context blocks disallowed top-level navigation, including redirects/script/link paths. | Actual Chromium sentinel-environment test and local-file navigation regressions. This is not an SSRF firewall or a tenant isolation claim: host browser execution remains trusted-only. |
| Image active state writes unreadable files | Writes enforce the same 1 MiB serialized limit as reads before replacing the previous state. | Oversize replacement is rejected and the prior snapshot remains readable. |
| Invocation generations exhaust control operations | Identical source/binding combinations reuse the immutable generation while auditing each invocation. New distinct invocation generations and staged generations have separate bounds; allocations reserve control space. Bounded audit retention preserves durable rollback eligibility. Already-full legacy generation snapshots can still activate/rollback/drain. No referenced execution identities are deleted. | Saturation, repeated-binding reuse, retained identity, audit trimming and legacy-capacity control tests. Distinct configuration capacity is finite; overflow explicitly rejects allocation. |
| Transient Headquarters failure kills beacons | Fresh admission remains mandatory for new claims. Existing ownership has a bounded renewal grace from the last successful admission (default 30 seconds, configurable 0–120 seconds). Explicit denial clears grace immediately. Authority request timeout is below the runner callback deadline. | Real BeaconRunner process survives 503 and authority timeout within grace; 401 fences and reaps. No prior admission means no grace. Grace expiry fails closed. |

## Tenant and operational findings

| Finding | Correction / operational consequence |
| --- | --- |
| Shared fleet token and optional tenant assertion | Tenant Headquarters requires `execution.targets` with fixed origins and unique worker credentials. Tenant workers reject missing/mismatched tenant, worker and network assertions and require independent operator API authentication. One tenant worker's credential cannot operate another. Operator-only shared-token transport remains a trusted-fleet compatibility path and must not be used for tenant routing. |
| Self-reported heartbeat determines tenant | Tenant eligibility and credential destination are pinned in operator configuration. Heartbeat advertisements cannot grant ownership or redirect Headquarters to an attacker-selected endpoint. They remain discovery/availability data, not an authorization source. |
| All ingress clients share rate bucket | `trustedProxies` accepts explicit ingress IPs. Forwarded chains are examined from the socket right-to-left to the first untrusted hop. Spoofed headers from untrusted peers cannot choose buckets. Configure the ingress to append client addresses. |
| Enrollment lock survives writer death | Initialized ownership directories, process identity and retained recovery tombstones permit dead-owner recovery without a second unrecoverable recovery lock. Ambiguous/legacy ownership requires explicit reconciliation, with its path reported. This local file authority is not distributed HA storage. |
| Deleted rollout source blocks fleet reconciliation | Missing sources become failed rollout records while other deployments continue. Pending/failed operations can be cancelled through the operator API/CLI. Cancellation prevents future reconciliation steps; it does not resurrect the stopped source or undo a replacement already created. |
| Guest can delete cancellation PID marker | Guest files are no longer cancellation authority. Explicit cancellation, timeouts and forced service/terminal stops terminate the whole workspace container, including detached descendants. Sibling work becomes interrupted; persistent workspace files survive and later admission restarts the workspace safely. |
| Transient Docker launch poisons adapter | A failed launch no longer marks the entire adapter permanently unavailable. Later admission can retry a new operation; the failed operation is not silently replayed. Engine failures retain a sanitized diagnostic category without leaking raw command arguments/secrets. |
| Dashboard binds ambient HOSTNAME | `STATION_DASHBOARD_HOST` controls binding and defaults to `127.0.0.1`. Ambient container `HOSTNAME` is ignored. The CLI sets the dedicated variable explicitly. |
| Session cookie lacks Secure | Login and logout cookies default to Secure regardless of forwarding headers, including behind TLS termination. `auth.secureCookies:false` is an explicit local HTTP development escape hatch. |
| File logs grow without memory bounds | FileLogStorage does not build an in-memory index or replay the entire file at startup. Streaming reads return bounded newest results; individual records and the pending write backlog are capped. Rotation retains current and previous segments, with a 64 MiB write limit per segment by default. An existing oversized legacy file is retained once as the previous segment until the next rotation; streaming reads stay memory-bounded. Overflow/oversize entries call onError; this is bounded operational history, not a complete audit archive. |

## Validation and release status

Focused evidence collected during remediation:

- CLI lifecycle and management suite: 38 passing before subsequent rollout-cancel tests; dashboard 9 passing including a real launch with invalid ambient HOSTNAME.
- Browser unit suite: 82 passing. Real Chromium: 2 passing, including subprocess environment exclusion and navigation enforcement.
- Sandbox unit suite: 26 passing. New real Docker security cases: 2 passing. Existing broader Docker integration: 3 passing, covering custom npm installation, persistent files, services, PTY and controller recovery.
- Combined daemon auth, execution, tenant-routing, logs and network regressions: 36 passing before the added configuration-copy test.
- Real Headquarters with two Docker tenant workers: passed with zero skips, distinct tokens, private owner routing, an offline custom tool installation, persistent workspace access and browser screenshots.
- Image state/capacity, enrollment crash/admission and rollout regression suites are recorded in their test files and the final preflight results below.

The network test previously used a 250 ms membership lease while competing with the full workspace suite. It now uses a 10-second lease and 250 ms heartbeat; this routing/concurrency test does not test rapid failover. Separate ownership/failover tests retain their own scenarios. Scheduling completion remains bounded and early execution remains an assertion; latency is diagnostic.

GitGuardian flagged a hard-coded fixture-only password in `test/images/tenant-worker.integration.ts`. That fixture now generates its password at runtime. The scanner may continue reporting its historical incident until it rescans/resolves it; changing the fixture does not claim the external incident is dismissed. No history rewrite or scanner bypass was performed.

No npm publication occurred. A passing packaging dry run does not establish npm write permissions, production egress/quotas or distributed database failover. See [the acceptance map](STATION-IMAGES-ACCEPTANCE.md) for the original implementation coverage and deferred deployment matrix.


### Final coordinated verification

`pnpm release --dry-run --allow-dirty` completed successfully after the corrections, with no skipped checks: workspace builds, typechecks, browser installation, tests, 20 package archives and all npm publish dry runs passed. The daemon suite passed **159/159**, CLI **39/39**, browser **82/82**, sandbox **26/26**, dashboard **9/9** and image core **49/49**. The two existing platform-specific `/proc` skips in the host signal suite remain explicit; the separate CLI Linux container test passed **5/5**.

The final isolated packed-install smoke also passed after all source changes: the headless daemon excludes Next/React/dashboard, the dashboard archive runs independently, offline image preparation works, authenticated signal execution succeeds, and stopping clients/dashboard leaves the daemon alive.

Local verification logs: `/tmp/station-review-release-verified.log`, `/tmp/station-review-packed.log`, `/tmp/station-review-cli-linux.log`, `/tmp/station-review-tenant-docker.log`, `/tmp/station-browser-review-chromium.log`, `/tmp/station-sandbox-review-docker.log`. The documentation site and generated LLM files were rebuilt by that coordinated preflight. These temporary logs are supporting session evidence; committed regression tests are the reproducible record.

An earlier attempt was interrupted by overlapping documentation builds; those were stopped before this successful serialized preflight. A stale rollout mock then failed because cancellation introduced a fresh deployment read; the fixture was corrected while retaining lease-loss assertions. The final full run passed the previously flaky network integration test. This does not replace intended-host load/HA testing or prove absence of all future timing flakes.

The npm authentication preflight remains unavailable in this environment: packaging succeeded, publishing rights are **not verified**. No release was uploaded.
