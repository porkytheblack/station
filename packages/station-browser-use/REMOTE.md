# Browserbase, Steel and browser reliability

Station Browser Use can run an agent's browser locally or attach to a hosted browser through Browserbase or Steel. The remote adapters reuse Station's Playwright page controls, semantic observations, screenshots, five-second screenshot recordings and human-control leases. API keys and provider connection URLs remain on the worker.

These adapters use the providers' REST APIs plus Playwright CDP. They do not require either provider's SDK. Install the `playwright` peer; a remote-only worker does not need local Chromium binaries. Use Node 20+.

## Select a provider

```ts
import { BrowserSessionManager } from "station-browser-use";
import { BrowserbaseBrowserAdapter } from "station-browser-use/browserbase";

const adapter = new BrowserbaseBrowserAdapter({
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  rootDir: "/data/browserbase-controller",
  tenantId: "customer-a",
  proxies: true,
  browserSettings: { solveCaptchas: true },
  sessionTimeoutMs: 15 * 60_000,
  // Provision a Browserbase context first. Only these aliases may be opened.
  profiles: { customerAccount: "YOUR_BROWSERBASE_CONTEXT_ID" },
});
const browser = new BrowserSessionManager(adapter, 2, {
  tenantId: "customer-a",
  stateRootDir: "/data/browser-state",
  recordingRootDir: "/data/browser-recordings",
  intervalMs: 5000,
});
const session = await browser.open({ profileId: "customerAccount" });
const recording = browser.startRecording(session.id);
try {
  await browser.perform(session.id, "navigate", "https://example.com");
  const observation = await browser.execute(session.id, { op: "accessibility" });
  console.log(observation);
  // Run the agent workflow here. Retain the session/recording handles.
} finally {
  await browser.stopRecording(recording.id);
  await browser.close();
}
```

Omit `profiles` and `profileId` for an ephemeral session. The short example can finish before five seconds; recordings capture while the session remains open. Existing `createBrowserAgentTools`/`BrowserUseClient` callers use the worker exactly as before, with `browserbase` or `steel` advertised as its backend.

For Steel, replace the adapter configuration:

```ts
import { SteelBrowserAdapter } from "station-browser-use/steel";

const adapter = new SteelBrowserAdapter({
  apiKey: process.env.STEEL_API_KEY!,
  projectId: process.env.STEEL_PROJECT_ID!,
  rootDir: "/data/steel-controller",
  tenantId: "customer-a",
  useProxy: true,
  solveCaptcha: true,
  sessionTimeoutMs: 15 * 60_000,
  profiles: { customerAccount: "YOUR_STEEL_PROFILE_ID" },
});
```

Provider settings are operator configuration, never agent tool arguments. Proxy/CAPTCHA features can cost extra and depend on the provider plan. Station leaves them off unless enabled explicitly. Browserbase also accepts its proxy configuration array, `region`, and `browserSettings.verified`/`blockAds`. Steel accepts a `useProxy` configuration object or `proxyUrl` for a custom proxy. Do not configure both custom proxy methods.

For stable Steel egress, an operator can select a purchased dedicated IP with `useProxy: { type: "fixed", id: "fixed:YOUR_ID" }`. Reuse the intended profile and network configuration throughout an account's workflow. Provider support does not guarantee access to a particular site. [Steel network configuration](https://docs.steel.dev/overview/sessions-api/configuration), [Browserbase session settings](https://docs.browserbase.com/reference/sdk/nodejs).

## Capabilities and boundaries

| Facility | Remote adapters |
| --- | --- |
| Navigation, keyboard, pointer, selectors and semantic targets | Supported through Playwright CDP |
| DOM/ARIA observation, page selection and inline file uploads | Supported through the existing command interface |
| Screenshots, live view, timed screenshot recordings | Supported; Station captures and stores frames |
| Console/network metadata and page-access diagnostics | Supported |
| Persistent authenticated state | Granted provider contexts/profiles |
| Profile creation/deletion | Operator-managed at the provider; not exposed as Station mutations |
| Download artifacts and Playwright trace ZIP export | Currently disabled on remote adapters |
| Restore a live browser after Station worker restart | Not implemented; recover/release provider resources explicitly |
| Automatic provider failover / request retry | Not performed |

Downloads and traces are disabled because their file ownership, transfer and retention behavior needs a provider-specific artifact integration. The local Playwright adapter retains those capabilities. A provider's own recordings/traces are separate from Station screenshot playback and are not automatically imported. CDP supports less than a native Playwright protocol connection, so inspect capabilities and validate the operations your target workflow needs. [Playwright CDP documentation](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).

## Persistent profiles and credentials

`profiles` maps local Station aliases to pre-created provider context/profile IDs. A caller can only open an alias granted to this worker. The adapter reuses the provider's default context instead of creating a new incognito context that loses its stored identity. Browserbase context updates use `persist: true`; Steel uses `persistProfile: true` and must finish uploading profile changes before another session can reuse them.

The adapter blocks simultaneous use of the same granted profile within its owned controller root. Use one controller/root for a grant; separate roots cannot coordinate access to the same remote profile. Do not assign a provider profile to unrelated tenants. Profile cookies and authenticated state remain sensitive even though profile IDs are not credentials.

Provision profiles through the provider, then configure a fresh dedicated root with the intended grants. Stored identity includes provider, project, tenant and profile mapping; changing those underneath retained data fails closed. API-key rotation within the same provider project does not require rewriting the ledger. [Steel profiles](https://docs.steel.dev/overview/profiles-api/overview).

## Account workflows: WhatsApp, TikTok and Instagram

Treat an account connection as a durable profile grant, not a permanent browser process. The application should own a connection record keyed by tenant, service and account, with a granted Station profile alias and the owning worker. For example, use separate aliases for `whatsapp-support`, `instagram-brand` and `tiktok-brand`. These are proposed application conventions; Station does not yet provide a social-account connection registry or platform-specific tools.

| Target | Intended use | What has been verified |
| --- | --- | --- |
| WhatsApp Web | Human QR linking, later browser sessions reopening the same account | A live Steel session displayed a QR, detected successful linking, and appeared in Station Kit Live view. Reopening an authenticated persistent profile has **not** been tested. |
| TikTok | Human sign-in, account navigation and media workflows | Generic browser controls exist; TikTok login, uploads, publishing and profile reuse have **not** been tested. |
| Instagram | Human sign-in, account navigation and media workflows | Generic browser controls exist; Instagram login, uploads, publishing and profile reuse have **not** been tested. |

This is browser infrastructure, not a WhatsApp/TikTok/Instagram integration guarantee. Site controls, account permissions, login challenges and supported media flows must be checked on each target. Loading a signed-in page is distinct from successfully sending a message, uploading media or publishing a post. Sending and publishing need their own application authorization and outcome verification. Do not retry an uncertain submission automatically.

### Connect once, reopen as needed

1. An operator provisions a provider profile and grants its alias to the correct worker and agent workflow. For Steel, a bootstrap session with `persistProfile: true` returns a `profileId`; release it and wait for the profile to become `READY` before mapping the alias. Station's current adapter requires that mapping in advance; arbitrary profile provisioning is not an agent tool.
2. Start a session using `browser.open({ profileId: "whatsapp-support" })` on a worker registered with Headquarters. Open the target site. Station Kit's **Profiles** page can select the same alias and open a session; its **Live** page supports human login and challenges.
3. After the owner signs in, verify a minimal account/login marker without collecting chat or feed content unnecessarily. Release human control before resuming agent actions.
4. Call `browser.closeSession(session.id)` when the task finishes. Steel's adapter requests provider release with profile persistence configured. Wait for the provider profile to reach `READY` before the next open. Station does not currently poll that profile state or queue a reopen automatically. A profile still uploading can cause a provider error; inspect its state rather than repeatedly creating sessions.
5. Open a new session with the same alias, navigate to the service, and verify authentication again. Reuse preserves browser state, not necessarily the previous open tabs; checkpoints separately retain selected navigation information.
6. If the service requests login again, mark the application connection as needing human attention. Do not silently create a replacement profile or switch providers: a profile grant is provider-specific.

A browser timeout and an account logout are different events. Closing or expiring the browser can save authenticated state for later use. To disconnect an account, perform the site's logout/revoke flow and save the resulting profile, or have the owner revoke the linked device/access from the account itself. Removing a Station session or profile alias is not proof of server-side logout.

For Steel, profiles snapshot the browser user-data directory, rather than only cookies. Its current documentation describes a 300 MB profile limit and automatic deletion after 30 days without use. A failed profile upload can make it unusable. Incorporate these provider states and retention limits into the application connection status. [Steel profile lifecycle and limits](https://docs.steel.dev/overview/profiles-api/overview).

In a fleet, serialize use of each account/profile through one owner or a distributed lease. Station's local controller lock does not coordinate independent workers. Keep profile grants and provider keys tenant-scoped, and keep account data out of model arguments and general logs. Screenshots and recordings of signed-in pages can contain private messages; capture and retain them according to the application's access policy.

### Uploads and downloads

| Operation | Current behavior | Remaining work for social media workflows |
| --- | --- | --- |
| Upload a small file | Playwright and remote adapters accept `upload` with an input target and `{name, mimeType, base64}` files. Maximum 16 files and **4 MiB total decoded bytes per command**. | Validate each site's picker/preview flow; uploading a file does not publish it. |
| Upload large videos | No streamed or chunked browser-upload interface. The inline limit applies even when the site accepts larger files. | Add an authorized artifact reference and worker/provider staging path, bounded streaming, size checks, cancellation and cleanup. |
| Download from local/container Playwright | Explicit download action creates a session-owned artifact. Retrieve it with `downloadRead` before closing the session. Default artifact budget is 4 MiB; the configurable aggregate maximum is 16 MiB. | Export required results to durable application storage; session artifacts do not survive session closure. |
| Download from Steel/Browserbase | Disabled in Station's remote adapters, even if the provider has a Files API. | Implement provider file discovery, ownership checks, bounded transfer and cleanup; advertise the capability only after validation. |
| Move files between sandbox and browser | Separate APIs; there is no shared filesystem between a sandbox and a hosted browser. Small files can be transferred by trusted application code using bounded bytes. | Add tenant-owned artifact storage and explicit grants for larger media. |

A proposed media path is: sandbox or user upload → tenant-owned artifact storage → authorized browser upload; browser download → provider/worker staging → tenant-owned artifact storage. This path is **not implemented**. Give agents opaque artifact IDs rather than arbitrary filesystem paths, provider credentials or unrestricted fetch URLs. Artifacts should have an owner, size limit, retention policy and explicit transfer state. Keep browser recordings separate from downloaded media.

### Acceptance checks before enabling an account workflow

Verify a fresh login, graceful close/profile save, new-session login reuse, expiry recovery and explicit logout/revocation. Then test an authorized sample upload, its visible preview and cancellation; test publication separately if requested. Test download bytes and filename, size-limit rejection, cleanup, and cross-tenant denial. Use non-sensitive test media. Large-video transfer and remote download tests are blocked on the artifact integrations above. The completed WhatsApp QR test alone does not establish any of these additional guarantees.

## Challenge handling, pacing and throttling

Remote adapters enable a shared traffic policy by default:

- At most two simultaneous agent actions per origin across the adapter's sessions.
- At least 250 ms between agent action starts on the same origin.
- Main-document HTTP 429 responses set an origin backoff using `Retry-After`, bounded by `maxBackoffMs` (default 60 seconds).
- Visible challenge/interstitial signals pause mutations with `challenge_required`. HTTP 403 is reported as a blocked page, not automatically classified as a CAPTCHA.

These are **agent-action controls**, not a network firewall or a bound on every HTTP request made by page JavaScript. They are per adapter/controller, not distributed across a fleet. A call rejected by pacing is not queued or retried automatically.

```ts
reliability: {
  detectChallenges: true,
  minIntervalMs: 500,
  maxConcurrentPerOrigin: 1,
  maxBackoffMs: 120_000,
}
```

Detection is heuristic. It can miss custom challenges or flag an ordinary page; it does not solve a challenge. It examines visible widgets, short interstitial text and titles, and distinguishes 403/429 responses. Read-only observations and screenshots remain available during a pause. A navigation or click may have happened before a challenge/throttle error is returned, so inspect the page before repeating the action.

`execute({ op: "diagnostics" })` includes:

```json
{
  "provider": { "name": "steel", "sessionId": "PROVIDER_SESSION_ID" },
  "reliability": {
    "status": "throttled",
    "reason": "http-429",
    "retryAfterMs": 800
  }
}
```

The complete response also contains the existing bounded events and trace status. Page-access statuses are `ready`, `challenge`, `blocked`, `throttled` and `unknown`. Provider diagnostics contain a provider name/ID and a `connected` flag, never its API key or CDP URL. `ready` only means no configured check currently blocks the page; it is not a site's approval of automation.

Station Kit's **Diagnostics** subpage shows this status and backoff. For a challenge, pause the agent and use the session's **Live** page to acquire control. Actions carrying that validated control lease bypass the agent challenge guard so a person can review the page. Other callers are rejected while the lease is active. Release control afterward; the next agent action rechecks the page. Provider-native interactive viewers are outside Station's lease enforcement; Steel's viewer is requested as read-only.

The SDK and agent tools preserve safe errors: `challenge_required`, `rate_limited`, `provider_auth`, `provider_capacity`, `provider_disconnected` and `provider_unavailable`. Provider errors are sanitized; raw response bodies and credential-bearing connection errors are not forwarded. A challenge requires human review, a capacity error requires admission changes/waiting, and an uncertain provider failure requires reconciliation. Do not cycle proxies or repeatedly resubmit actions on a blocked page.

## Improve local Playwright sessions

The local adapter already accepts an authenticated proxy and a persistent profile root. It now also accepts `locale`, `timezoneId` and the same opt-in reliability policy:

```ts
import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";

const adapter = new PlaywrightBrowserAdapter({
  profileRootDir: "/data/local-browser-profiles",
  proxy: {
    server: process.env.BROWSER_PROXY_SERVER!,
    username: process.env.BROWSER_PROXY_USERNAME,
    password: process.env.BROWSER_PROXY_PASSWORD,
  },
  locale: "en-US",
  timezoneId: "America/New_York",
  reliability: { minIntervalMs: 500, maxConcurrentPerOrigin: 1 },
});
```

Choose settings appropriate to the actual account/session and keep them consistent. This does not add fingerprint spoofing or promise CAPTCHA-free access. Native local Playwright's policy remains opt-in for compatibility. Bun WebView does not gain this Playwright policy. The container browser accepts the same `reliability`, `locale` and `timezoneId` options and forwards validated human-control context through its private worker protocol. Its policy runs per browser container, so it does not coordinate traffic across separate containers. Rebuild the operator image to include the updated worker. Its existing restricted egress proxy remains a separate deployment mechanism.

## Tenant deployment

Keep provider keys on private workers and expose Headquarters tenant routes to customers. Bind the adapter, manager and worker to the same tenant. Use the existing execution-only keys and tenant-to-worker routing; do not expose provider keys, connection URLs or arbitrary provider profile IDs as agent arguments.

Remote adapters advertise `isolated: false` and `networkRestricted: false` by default. A proxy is not proof of restricted egress. Consequently the public tenant admission path will refuse them until an operator explicitly configures verified deployment guarantees:

```ts
deployment: {
  isolated: true,
  networkRestricted: true,
}
```

These fields are **attestations, not enforcement switches**. Set them only after verifying the provider project/session isolation and effective egress policy required by your deployment. Station does not install a cloud-provider firewall or establish those guarantees for you. Separate projects/credentials and restricted network policies remain operator responsibilities. If a provider cannot meet your requirements, use the existing enforced container deployment instead of asserting unsupported guarantees.

## Cleanup and uncertain outcomes

Every remote creation first writes a private journal entry under `rootDir`. Once the provider returns an ID, Station saves it before connecting. The journal contains IDs, profile grants and ownership; it does not store API keys, cookies or CDP URLs. A single-host ownership lock prevents two live controllers from using the same root.

Closing a session requests provider release and closes the Playwright connection. An attachment failure also attempts release. Provider lifetimes default to 15 minutes as a final bound if the worker disappears. Local idle expiry and shutdown remain responsible for early release; timeout is not a replacement for cleanup.

An ambiguous creation response leaves a journal entry and **fences new opens**. Failed releases retain the known ID for reconciliation. These states survive a worker restart. Existing sessions are not silently replaced, and no browser falls back to a different provider or a local process.

Operator recovery:

```ts
console.log(adapter.pendingSessions()); // Safe IDs and timestamps, no connection secrets.
await adapter.reconcile();              // Release known orphaned provider sessions.
```

Reconciliation requires no live sessions/openings. If creation was accepted remotely but its response was lost, the journal may lack a provider ID. Browserbase receives `userMetadata.stationRequestId` matching the local journal ID to assist lookup. Steel requires reconciliation against its provider session inventory/timestamps. After checking the provider, an operator can supply the matching ID:

```ts
await adapter.reconcile({ LOCAL_JOURNAL_ID: "VERIFIED_PROVIDER_SESSION_ID" });
// Only after confirming that no remote session remains:
await adapter.reconcile({ LOCAL_JOURNAL_ID: null });
```

These are privileged application APIs, not tenant RPCs or model tools. Passing `null` is an operator assertion, not discovery. Never clear a journal just to bypass an unknown creation. If shutdown returned an error and released its root lock, reopen an adapter with the same configuration before reconciliation. Do not share a root between hosts or treat local ownership locks as distributed fencing.

## Validation

```sh
pnpm --filter station-browser-use test
pnpm --filter station-browser-use test:remote
```

The first command covers provider payloads, lifecycle fencing, profile grants, error sanitization and traffic controls. The second runs real local Chromium/CDP against a local website with mocked Browserbase/Steel APIs: navigation, inputs, PNG capture, screenshot recordings, challenge pause, human takeover, 429 diagnostics and cleanup. It requires installed Chromium and loopback/process permissions; it creates no paid cloud sessions.

These tests validate Station's integration, not a provider account's enabled features or its success rate on a target website. A live provider smoke test requires credentials and may incur provider/proxy charges. Verify profile persistence, selected proxy policy and account permissions against your actual provider before enabling customer traffic.

Provider references: [Browserbase create](https://docs.browserbase.com/reference/api/create-a-session), [Browserbase release](https://docs.browserbase.com/reference/api/update-a-session), [Steel Playwright integration](https://docs.steel.dev/integrations/playwright), [Steel session lifecycle](https://docs.steel.dev/overview/sessions-api/session-lifecycle).

An explicit smoke command is available after configuring credentials. It opens exactly one session with a one-minute provider lifetime, visits `example.com`, writes `example.png` beneath `.station/provider-smoke/<provider>` and requests release. It does not enable paid proxy/solver options or test target-site CAPTCHA success. Set `STATION_PROVIDER_PROFILE_ID` optionally to exercise an existing profile grant.

```sh
STATION_ALLOW_PAID_BROWSER=1 STATION_BROWSER_PROVIDER=steel \
  pnpm --filter station-browser-use test:provider:live
```

Export `STEEL_API_KEY`/`STEEL_PROJECT_ID` first, or select `browserbase` with `BROWSERBASE_API_KEY`/`BROWSERBASE_PROJECT_ID`. Do not paste secret values into retained command strings. The gate is checked before any provider request. Keep the generated controller journal for reconciliation if a run fails.
