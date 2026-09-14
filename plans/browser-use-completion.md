# Browser Use completion review

Browser Use now has separate session pages for Control, Live, Pages, Tools, Inspect, Diagnostics, Recordings and Recovery. Sandbox stays a separate primitive with its own workspace pages.

## Agent integration — release candidate

The final clean-tree `pnpm release:dry-run` passed for Station 2.4.0, all 16
packages: builds, typechecks, **400 passing tests**, two existing skips,
26/26 browser-runtime checks, archive validation and npm publish dry runs.
[Release validation record](artifacts/browser-use-completion/release-validation.json).
Nothing was uploaded. The code is committed locally; the real-model test below
is the remaining verification, currently blocked by the configured OpenRouter credential.

The published Browser Use package now exports `station-browser-use/agent` and
`station-browser-use/client`. Nine framework-neutral tools provide workflow-scoped
sessions, structured browser commands, bounded DOM/ARIA observations, screenshots,
checkpoints and cleanup through authenticated Headquarters routing. Worker choice,
credentials and retained-resource grants remain host configuration.

The Foundry example uses its public agent/runtime contracts and maps screenshots
to native model image inputs after tool results are committed. Its local protocol
check discovered the actual example agent and mounted all nine tools. The real
Playwright integration verifies authenticated routing, form interaction, DOM/ARIA,
PNG image forwarding, human takeover conflicts, ownership rejection and cleanup.
These are local protocol/browser tests, **not proof of a model completing a task**.

The integration test caught and fixed Headquarters masking `busy` responses.
The lifecycle review also fixed expired-session cleanup and uncertain opens:
unknown opens fence further admission and report unresolved cleanup instead of
silently freeing capacity or claiming successful shutdown.

The user approved one low-usage real-model test. It attempted one model call and
failed before any browser tool ran; a separate read-only key-status check returned
**401 Unauthorized**. No screenshot was captured or sent and no successful model
response or token usage was reported. No further generation attempts were made.
The remaining verification requires a working OpenRouter credential.

The example now limits runs to 14 turns and 600 output tokens per call, and reports
provider HTTP status without recording raw errors or credentials. Its three local
bridge tests pass. These example/test-report changes follow the 400-test release
preflight above; the published package implementation is unchanged.
[Approved test result](artifacts/browser-use-completion/real-model-attempt.json).
Nothing has been published.

- [Foundry example and test instructions](../examples/19-foundry-browser/README.md)
- [Real browser tool integration evidence](artifacts/browser-use-completion/browser-agent-protocol.log)
- [Foundry local protocol evidence](artifacts/browser-use-completion/foundry-protocol.log)

## What changed

| Capability | Behavior |
| --- | --- |
| Live view | Approximately one screenshot per second while the view is open; pause/resume; busy frames are skipped. Observation alone does not prevent idle expiry. |
| Human control | Explicit short lease, renewed by the dashboard, with exclusive input and close authorization. Automation receives a conflict while a human owns the browser. Navigation releases control when possible; expiration handles disconnected clients. |
| Targeting | CSS, role/name, label, text and test IDs; nested iframe selectors and explicit match index. |
| Input | Semantic click/focus/press, form controls, pointer coordinates, element and coordinate drag, and one-shot expiring dialog policies. |
| Inspection | Bounded structured DOM information and ARIA snapshots, with frame-coordinate labels. This is page data, not trusted agent instructions. |
| Diagnostics | Bounded console/request/response events. Console message bodies are opt-in; diagnostic URLs omit credentials, query strings and fragments. |
| Playwright trace | Explicit start/stop and ZIP download containing screenshots and snapshots. Maximum 60 seconds and the session artifact budget; download before closing the session. |
| Screenshot playback | Existing five-second worker recordings remain independently durable, playable and scrubbable after session close or worker restart when storage is configured. |
| Recovery | Explicit checkpoint of selected page, sanitized page URLs and profile options. Restore creates a new browser session; a persistent profile can retain cookies/storage. It does not restore a JavaScript stack or replay previous actions. |
| Audit | Optional durable bounded journal, monotonic sequence numbers and started/finished action entries. Journal failures stop new actions; cleanup remains possible. An unfinished entry means an uncertain outcome, not permission to repeat the action. |
| Tenant admission | Public browser workers require isolated/network-restricted adapters and both durable recording and state roots. A manager and its storage cannot be relabeled across tenants. |

Playwright and Container Playwright expose the advanced browser capabilities. Bun remains available for basic automation, screenshots and live viewing, and advertises unsupported capabilities explicitly.

## Deployment boundary

The local preview is an operator development environment. Public tenants require dedicated private workers, container execution, enforced network policy and storage quotas. The included Linux Docker deployment profile provisions a restricted workload network, a public-IP-pinning HTTPS CONNECT proxy, host deny rules and XFS project quotas for browser profiles, recordings and state. It deliberately does not allow general HTTP, UDP, QUIC or direct internet connections.

The platform still owns TLS, secret provisioning, image/kernel patching, backups and worker supervision. The single-worker ownership locks and local admission limits do not implement cross-host failover or replicated quotas. A replacement worker must be fenced from the previous owner before attaching retained storage. The audit journal is bounded operational history, not an immutable compliance archive.

Browser profiles, screenshots, DOM snapshots and trace ZIPs may contain authenticated application data. They stay within the owning worker/API boundary unless an authorized caller downloads them. Diagnostic URL redaction does not sanitize full Playwright trace contents.

## Verification

The agent integration adds schema/runtime consistency tests, authenticated-client
transport tests and workflow lifecycle regressions. The native-image bridge is
part of `pnpm test`, as is the real local Headquarters/Playwright tool integration.
The paid model test is deliberately opt-in: `pnpm test:browser-use:agent`.

The results below also document the earlier completed execution/dashboard and
Linux isolation checks; those features remain part of this release candidate.

The full dashboard end-to-end run passed in 65.9 seconds: 16 scenario groups, zero browser JavaScript errors. It includes a real custom package install, persistence across worker replacement, terminals/services/files, live browser input and leases, inspection, trace ZIP bytes, checkpoint restore, profiles and screenshot playback. [Detailed scenario results](artifacts/browser-use-completion/summary.json).

Browser Use has 43 passing unit tests and four passing real Bun/Playwright integration scenarios. Five tenant-gateway tests pass, including mandatory durable browser storage. The workspace typecheck and documentation build pass; generated LLM documentation includes the new APIs.

The local preview is upgraded, with the prior demo screenshot recordings retained on disk. [Open the live Playwright session](http://127.0.0.1:5700/browser-use/playwright-worker/sessions/36f20a5a-22b2-4c7d-b7ca-2c8cf8dd620f/live). Choose **Take control** to click the image or type into the focused browser field. Release control before automation resumes. This demo session expires after one hour of inactivity; its profile/checkpoint and recordings remain on disk.

The full release dry run passed for all 16 packages: builds, typechecks, 374 passing TAP tests (two existing skips), 26/26 browser-runtime checks, archive validation and npm publish dry runs. Nothing was uploaded. The real Linux enforcement harness also passed: allowed HTTPS, blocked direct/peer/host/metadata/IPv6/DNS routes, rejected policy drift and earlier firewall accepts, child-process quota-mutation denial, and a 32 MiB disk limit with free host headroom. [Kernel test evidence](artifacts/browser-use-completion/linux-enforcement.log). The fast policy suite passed four proxy and five verifier tests, including the required Yama ptrace protection. The refreshed Chromium image passed the named-volume suite, the XFS profile/guard suite and the real HTTPS proxy/metadata-denial suite. These check rich commands, profiles across manager replacement, image screenshots, transfers, traces, recording recovery and inherited seccomp filters. [Container browser evidence](artifacts/browser-use-completion/container-browsers.log). The real two-tenant Headquarters integration passed against that refreshed image: custom tool installation, filesystem separation, browser screenshots, cross-tenant denial, capacity, credential revocation and retained-storage ownership. [Tenant gateway evidence](artifacts/browser-use-completion/tenant-gateway.log). No cloud service or package was published. The disposable Linux test host is removed after verification; the local development preview stays running.

## Entry points

- [Browser package API](../packages/station-browser-use/README.md)
- [Execution deployment contract](../scripts/execution-container/README.md)
- [Agent execution reference](../.claude/skills/station/execution.md)
- [Browser dashboard](../packages/station-kit/src/app/components/browser-screen.tsx)
- [Real dashboard test](../packages/station-kit/test/e2e/dashboard.mjs)
