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

`connect()` checks the protocol, major version and optional expected identity. Call it before using a saved endpoint; raw request helpers deliberately remain available for explicit transport integrations. `events(signal)` yields SSE events until aborted or disconnected; callers choose their own reconnection policy. `putBlob(digest, bytes)` uploads a raw registry artifact.

Remote connections require HTTPS. Loopback HTTP is allowed. Redirects are rejected so bearer credentials cannot be redirected to other endpoints. JSON responses are bounded (16 MiB default); request deadlines default to 30 seconds. Transport/API errors omit arbitrary upstream messages that could expose secrets. Mutations are never retried automatically: after a timeout, inspect state before retrying. This client does not implement server-side idempotency or imply exactly-once execution.

The client provides transport types and basic catalog/run helpers, not exhaustive runtime validation of every response schema. Capability discovery and daemon validation remain authoritative.
