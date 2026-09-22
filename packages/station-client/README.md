# station-client

Station 3's independent HTTP API client. It has no daemon, dashboard or framework dependency.

```ts
import { StationClient } from 'station-client';

const station = new StationClient({
  url: 'https://hq.example.com',
  token: process.env.STATION_API_KEY,
  stationId: 'headquarters', // optional expected server identity
});
await station.connect(); // requires Station 3 and station.api/v1
const owners = await station.executionStations();
const browser = await station.execution('browser-worker', 'browser', { method: 'open' });
const run = await station.triggerSignal('summarize', { url: 'https://example.com' });
```

`request<T>(method, path, body?, signal?)` accesses all JSON endpoints relative to `/api/v1`. `execution<T>` accesses every server-supported sandbox/browser method and preserves explicit owner routing. Set `tenant: true` for execution-only tenant credentials: the client uses the restricted tenant gateway, and Headquarters determines tenant identity from the authenticated key. The client never invents VM capabilities or widens permissions.

`connect()` checks the protocol, major version and optional expected identity. Call it before using a saved endpoint; raw request helpers deliberately remain available for explicit transport integrations. `events(signal, { lastEventId })` yields SSE events until aborted or disconnected; callers choose their own reconnection policy and retain the last received event ID. The daemon retains up to 256 events/1 MiB in memory; `stream.reset` means the cursor expired, was invalid, or belongs to an earlier daemon process, and consumers must refresh current state. This is bounded replay, not a durable event log. `putBlob(digest, bytes)` uploads a raw registry artifact.

Remote connections require HTTPS. Loopback HTTP is allowed. Redirects are rejected so bearer credentials cannot be redirected to other endpoints. JSON responses are bounded (16 MiB default); request deadlines default to 30 seconds. Transport/API errors omit arbitrary upstream messages that could expose secrets. Mutations are never retried automatically: after a timeout, inspect state before retrying. This client does not implement server-side idempotency or imply exactly-once execution.

The client provides transport types and basic catalog/run helpers, not exhaustive runtime validation of every response schema. Capability discovery and daemon validation remain authoritative.

## Binary execution helpers

`sandboxWriteFile(owner, workspace, path, bytes, { createParents })` encodes up to 4 MiB. `sandboxReadFile(owner, workspace, path, { offset, length })` returns `{ data: Uint8Array, totalBytes, nextOffset, path }` and validates the response's byte count/offset. Callers can paginate; concurrent file changes are not snapshotted by the protocol.

`browserUpload(owner, session, locator, files, controlToken?)` accepts `{ name, mimeType, bytes: Uint8Array }` files (16 files/4 MiB total). `browserDownload(owner, session, locator, controlToken?)` triggers a browser download and returns artifact metadata. `browserReadDownload(owner, session, artifactId)` fetches decoded bytes without deleting the artifact. `browserScreenshot(owner, session, controlToken?)` returns PNG bytes. Downloads/screenshots reject corrupt base64 and decoded payloads over 8 MiB. These methods preserve tenant gateway and explicit owner routing; capability and traffic policies remain server-enforced.

## Resumable image uploads

`registryPath(stationId?)` selects the operator registry, an explicitly targeted private worker registry, or the server-selected tenant registry. Tenant registry keys cannot select a worker namespace. `createImageUpload`, `imageUploadStatus`, `appendImageUpload`, `commitImageUpload` and `cancelImageUpload` expose resumable staging with validated status and the server's advertised `maxChunkBytes`. Appends send raw bytes with `Upload-Offset` and `X-Chunk-SHA256`; the caller supplies the chunk digest and owns reconciliation after errors. Cancel releases staging; it does not remove a committed registry blob. The CLI stores private upload receipts; this low-level SDK leaves persistence to its caller.
