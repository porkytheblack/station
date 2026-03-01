# Station: Client-Server Architecture Plan

## Executive Summary

Station evolves from a local-only background job framework into a client-server system where the Station server (runners, database, dashboard) runs independently from application code. Developers trigger signals remotely over HTTP with zero changes to their signal definitions. The only code change: a one-line `configure()` call pointing to the remote Station endpoint.

---

## Table of Contents

1. [Current Architecture](#1-current-architecture)
2. [Target Architecture](#2-target-architecture)
3. [The Trigger Split: How Remote Works](#3-the-trigger-split-how-remote-works)
4. [New Packages](#4-new-packages)
5. [Changes to Existing Packages](#5-changes-to-existing-packages)
6. [Authentication System](#6-authentication-system)
7. [Station API Changes](#7-station-api-changes)
8. [Database Adapter Packages](#8-database-adapter-packages)
9. [Event Subscriptions](#9-event-subscriptions)
10. [Developer Experience Walkthrough](#10-developer-experience-walkthrough)
11. [Migration Path](#11-migration-path)
12. [Implementation Phases](#12-implementation-phases)
13. [Open Questions](#13-open-questions)

---

## 1. Current Architecture

### How `.trigger()` works today

```
signal("sendEmail")           signal.trigger(input)
  .input(schema)        -->     1. Validate input via Zod
  .run(handler)                 2. Call getAdapter().generateId()
                                3. Call getAdapter().addRun(run)
                                4. Return run ID
```

The global `configure({ adapter })` sets a module-level singleton adapter. The `signal.trigger()` method calls `getAdapter()` from `config.ts`, which returns that singleton. When no adapter is configured, it defaults to `MemoryAdapter`.

### Key insight

`trigger()` does exactly two things: validate input, then write a `Run` record to the adapter. It does NOT execute the handler. Execution happens in the SignalRunner, which polls the adapter for due runs and spawns child processes.

This means trigger is already decoupled from execution. The adapter is the seam.

### Current flow

```
[User App]                      [Same Process or Shared DB]
signal.trigger(input)  --->  adapter.addRun(run)  --->  [SQLite/Memory]
                                                              |
[SignalRunner]                                                |
runner.tick()  --->  adapter.getRunsDue()  <-------------------
                       |
                       v
                 spawn child process
                 execute handler
                 IPC result back to runner
```

### Current packages

| Package | Purpose | Key exports |
|---------|---------|-------------|
| `station-signal` | Core signal builder, runner, adapters | `signal()`, `configure()`, `SignalRunner`, `SignalQueueAdapter` |
| `station-broadcast` | DAG orchestration over signals | `broadcast()`, `configureBroadcast()`, `BroadcastRunner` |
| `station-adapter-sqlite` | SQLite adapter (better-sqlite3) | `SqliteAdapter`, `BroadcastSqliteAdapter` |
| `station-kit` | Dashboard (Hono + Next.js) | `defineConfig()`, CLI `station` command |

### Current adapter interfaces

**SignalQueueAdapter** (14 methods):
- Run CRUD: `addRun`, `removeRun`, `getRun`, `updateRun`, `listRuns`
- Queries: `getRunsDue`, `getRunsRunning`, `hasRunWithStatus`
- Steps: `addStep`, `updateStep`, `getSteps`, `removeSteps`
- Utility: `generateId`, `ping`, `close?`
- Purge: `purgeRuns`

**BroadcastQueueAdapter** (12 methods):
- Broadcast CRUD: `addBroadcastRun`, `getBroadcastRun`, `updateBroadcastRun`, `listBroadcastRuns`
- Queries: `getBroadcastRunsDue`, `getBroadcastRunsRunning`, `hasBroadcastRunWithStatus`
- Nodes: `addNodeRun`, `getNodeRun`, `updateNodeRun`, `getNodeRuns`
- Utility: `generateId`, `ping`, `close?`
- Purge: `purgeBroadcastRuns`

---

## 2. Target Architecture

```
[User App - Any Machine]                           [Station Server - Remote Machine]
                                                   ┌──────────────────────────────────┐
import { configure } from "station-signal";        │  station-kit (Hono + Next.js)    │
configure({                                        │  ┌────────────────────────────┐  │
  endpoint: "https://station.example.com",         │  │  API Routes (auth'd)       │  │
  apiKey: "sk_..."                                 │  │  POST /api/v1/trigger      │  │
});                                                │  │  POST /api/v1/cancel       │  │
                                                   │  │  GET  /api/v1/events (SSE) │  │
import { sendEmail } from "./signals/send-email";  │  └────────────┬───────────────┘  │
await sendEmail.trigger({ to: "...", ... });        │               │                  │
        │                                          │  ┌────────────▼───────────────┐  │
        │  HTTP POST /api/v1/trigger               │  │  SignalRunner               │  │
        └─────────────────────────────────────────> │  │  BroadcastRunner            │  │
                                                   │  └────────────┬───────────────┘  │
                                                   │               │                  │
                                                   │  ┌────────────▼───────────────┐  │
                                                   │  │  Database Adapter           │  │
                                                   │  │  (Postgres/MySQL/SQLite)    │  │
                                                   │  └────────────────────────────┘  │
                                                   └──────────────────────────────────┘
```

### Design principle: The adapter is NOT the HTTP layer

It would be tempting to create an `HttpAdapter` that implements `SignalQueueAdapter` and proxies all 14 methods over HTTP. This is wrong for several reasons:

1. **The full adapter interface is a server concern.** Methods like `getRunsDue()`, `getRunsRunning()`, `updateRun()` are polling internals that only the SignalRunner needs. A client app never calls them.

2. **Latency.** Making `getRunsDue()` a network call would make the runner's poll loop absurdly slow.

3. **Coupling.** It would couple the client to the server's internal adapter contract.

Instead, the client needs a much smaller interface. The `trigger()` method only calls two adapter methods: `generateId()` and `addRun()`. For remote triggers, we replace this with a single HTTP POST.

### The correct abstraction: TriggerAdapter

We introduce a **new, minimal interface** for the trigger path only:

```ts
interface TriggerAdapter {
  trigger(signalName: string, input: unknown): Promise<string>;
}
```

This is what `signal.trigger()` calls when a remote endpoint is configured. It's one method, one HTTP call. The full `SignalQueueAdapter` remains the server-side concern.

---

## 3. The Trigger Split: How Remote Works

### Current `signal.trigger()` (from `/packages/station-signal/src/signal.ts`)

```ts
async trigger(input: TInput): Promise<string> {
  const result = inputSchema.safeParse(input);
  if (!result.success) throw new SignalValidationError(name, result.error.message);
  const id = getAdapter().generateId();
  const run: Run = { id, signalName: name, kind: "trigger", input: JSON.stringify(result.data), ... };
  await getAdapter().addRun(run);
  return id;
}
```

### Proposed `signal.trigger()` after the change

```ts
async trigger(input: TInput): Promise<string> {
  const result = inputSchema.safeParse(input);
  if (!result.success) throw new SignalValidationError(name, result.error.message);

  const triggerAdapter = getTriggerAdapter();
  if (triggerAdapter) {
    // Remote path: single HTTP call
    return triggerAdapter.trigger(name, result.data);
  }

  // Local path: same as before
  const id = getAdapter().generateId();
  const run: Run = { id, signalName: name, kind: "trigger", input: JSON.stringify(result.data), ... };
  await getAdapter().addRun(run);
  return id;
}
```

The check `getTriggerAdapter()` returns non-null only when the user has called `configure({ endpoint, apiKey })`. Otherwise, trigger falls through to the existing local path. Zero behavioral change for existing users.

### Where validation happens

| Scenario | Client-side validation | Server-side validation |
|----------|----------------------|----------------------|
| Local trigger | Zod schema in `trigger()` | Zod schema in bootstrap.ts child process |
| Remote trigger | Zod schema in `trigger()` | Server validates signal exists and re-validates input |

Client-side validation is always performed first. This means malformed input fails fast without a network call. The server validates again to prevent spoofed requests from bypassing schemas.

---

## 4. New Packages

### 4.1 `station-adapter-postgres`

```
packages/station-adapter-postgres/
  src/
    index.ts              # PostgresAdapter implements SignalQueueAdapter & SerializableAdapter
    broadcast.ts          # BroadcastPostgresAdapter implements BroadcastQueueAdapter
    shared.ts             # Connection pool, column mapping, date handling
    migrations/
      001_init.sql        # Schema for runs + steps tables
      002_broadcasts.sql  # Schema for broadcast_runs + broadcast_nodes tables
  package.json            # deps: pg (or postgres.js)
```

**Interface**: Same `SignalQueueAdapter` and `BroadcastQueueAdapter`. The adapter pattern means zero changes to runner code.

**Connection**: Accepts a connection string or pool configuration:
```ts
import { PostgresAdapter } from "station-adapter-postgres";
import { BroadcastPostgresAdapter } from "station-adapter-postgres/broadcast";

const adapter = new PostgresAdapter({
  connectionString: "postgres://user:pass@host:5432/station",
  // OR pool config:
  // host: "...", port: 5432, user: "...", password: "...", database: "station",
  tableName: "runs",  // optional, default "runs"
});
```

**Migration strategy**: The adapter runs idempotent `CREATE TABLE IF NOT EXISTS` on construction (same as SQLite adapter today). For production, we also provide standalone migration SQL files users can apply via their own tooling.

**Dependency**: `pg` (node-postgres) or `postgres` (postgres.js). Recommendation: `postgres` (postgres.js) for its zero-dependency ESM-first design and prepared statement support.

### 4.2 `station-adapter-mysql`

```
packages/station-adapter-mysql/
  src/
    index.ts              # MysqlAdapter implements SignalQueueAdapter & SerializableAdapter
    broadcast.ts          # BroadcastMysqlAdapter implements BroadcastQueueAdapter
    shared.ts
    migrations/
      001_init.sql
      002_broadcasts.sql
  package.json            # deps: mysql2
```

Same pattern as Postgres. Uses `mysql2/promise` for async query support.

### 4.3 `station-adapter-redis`

```
packages/station-adapter-redis/
  src/
    index.ts              # RedisAdapter implements SignalQueueAdapter & SerializableAdapter
    broadcast.ts          # BroadcastRedisAdapter implements BroadcastQueueAdapter
    shared.ts             # Key schemas, serialization helpers
  package.json            # deps: ioredis
```

Redis adapter uses sorted sets for run queues (scored by `createdAt`), hash maps for run/step data, and sets for status indices. Run records are stored as JSON strings in hashes keyed by `station:runs:{id}`.

Key schema:
```
station:runs:{id}                 # Hash: run data
station:runs:pending              # Sorted set: pending run IDs scored by createdAt
station:runs:running              # Set: running run IDs
station:runs:signal:{signalName}  # Set: all run IDs for a signal
station:steps:{runId}:{stepId}    # Hash: step data
station:steps:index:{runId}       # Set: step IDs for a run
```

Redis is primarily useful as a high-throughput queue backend, not for long-term storage. The adapter should document that completed runs should be purged regularly or archived to a durable store.

### 4.4 Package naming convention

All adapter packages follow the pattern `station-adapter-{backend}`:
- `station-adapter-sqlite` (existing, already follows this)
- `station-adapter-postgres` (new)
- `station-adapter-mysql` (new)
- `station-adapter-redis` (new)

Each adapter package exports from two entrypoints:
- `.` (default) -- `SignalQueueAdapter` implementation
- `./broadcast` -- `BroadcastQueueAdapter` implementation

This matches the existing `station-adapter-sqlite` convention.

---

## 5. Changes to Existing Packages

### 5.1 `station-signal`

#### `config.ts` -- Add remote configuration

```ts
// Current
let _adapter: SignalQueueAdapter = new MemoryAdapter();

// Proposed additions
let _triggerAdapter: TriggerAdapter | null = null;

export interface ConfigureOptions {
  // Existing
  adapter?: SignalQueueAdapter;

  // New: remote endpoint
  endpoint?: string;
  apiKey?: string;

  // New: custom trigger adapter (advanced)
  triggerAdapter?: TriggerAdapter;
}

export function configure(options: ConfigureOptions): void {
  if (options.adapter) {
    _adapter = options.adapter;
  }

  if (options.endpoint) {
    // Auto-create an HttpTriggerAdapter
    _triggerAdapter = new HttpTriggerAdapter({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
    });
  } else if (options.triggerAdapter) {
    _triggerAdapter = options.triggerAdapter;
  }

  _configured = true;
}

export function getTriggerAdapter(): TriggerAdapter | null {
  return _triggerAdapter;
}
```

#### New type: `TriggerAdapter`

```ts
// In adapters/trigger.ts (new file)

export interface TriggerAdapter {
  /**
   * Trigger a signal remotely. Returns the run ID assigned by the server.
   */
  trigger(signalName: string, input: unknown): Promise<string>;

  /**
   * Trigger a broadcast remotely. Returns the broadcast run ID.
   */
  triggerBroadcast?(broadcastName: string, input: unknown): Promise<string>;

  /**
   * Check if the remote server is reachable.
   */
  ping?(): Promise<boolean>;
}
```

#### New file: `adapters/http-trigger.ts`

```ts
export interface HttpTriggerOptions {
  endpoint: string;
  apiKey?: string;
  /** Request timeout in ms. Default: 10_000 */
  timeout?: number;
  /** Custom fetch implementation (for testing or environments without global fetch). */
  fetch?: typeof globalThis.fetch;
}

export class HttpTriggerAdapter implements TriggerAdapter {
  private endpoint: string;
  private apiKey?: string;
  private timeout: number;
  private fetchFn: typeof globalThis.fetch;

  constructor(options: HttpTriggerOptions) {
    // Normalize endpoint: strip trailing slash
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? 10_000;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async trigger(signalName: string, input: unknown): Promise<string> {
    const url = `${this.endpoint}/api/v1/trigger`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ signalName, input }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new StationRemoteError(response.status, body.error, body.message);
    }

    const body = await response.json();
    return body.data.id;
  }

  async triggerBroadcast(broadcastName: string, input: unknown): Promise<string> {
    const url = `${this.endpoint}/api/v1/trigger-broadcast`;
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ broadcastName, input }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new StationRemoteError(response.status, body.error, body.message);
    }

    const body = await response.json();
    return body.data.id;
  }

  async ping(): Promise<boolean> {
    try {
      const url = `${this.endpoint}/api/v1/health`;
      const response = await this.fetchFn(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }
}
```

#### New error: `StationRemoteError`

```ts
// In errors.ts

export class StationRemoteError extends Error {
  readonly code = "STATION_REMOTE_ERROR" as const;
  readonly statusCode: number;
  readonly remoteError?: string;

  constructor(statusCode: number, remoteError?: string, remoteMessage?: string) {
    const msg = remoteMessage
      ? `Station server returned ${statusCode}: ${remoteMessage}`
      : `Station server returned ${statusCode}`;
    super(msg);
    this.name = "StationRemoteError";
    this.statusCode = statusCode;
    this.remoteError = remoteError;
  }
}
```

#### Updated `signal.trigger()` in `signal.ts`

The `buildSignal()` function's `trigger` method changes to check for a `TriggerAdapter` first:

```ts
async trigger(input: TInput): Promise<string> {
  const result = inputSchema.safeParse(input);
  if (!result.success) {
    throw new SignalValidationError(name, result.error.message);
  }

  // Remote trigger path
  const triggerAdapter = getTriggerAdapter();
  if (triggerAdapter) {
    return triggerAdapter.trigger(name, result.data);
  }

  // Local trigger path (unchanged)
  const id = getAdapter().generateId();
  const run: Run = {
    id,
    signalName: name,
    kind: "trigger",
    input: JSON.stringify(result.data),
    status: "pending",
    attempts: 0,
    maxAttempts,
    timeout,
    createdAt: new Date(),
  };
  await getAdapter().addRun(run);
  return id;
}
```

#### Updated exports in `index.ts`

```ts
// New exports
export type { TriggerAdapter } from "./adapters/trigger.js";
export { HttpTriggerAdapter, type HttpTriggerOptions } from "./adapters/http-trigger.js";
export { StationRemoteError } from "./errors.js";
```

#### `configure()` signature change

The new `configure()` accepts `{ adapter }` (existing), or `{ endpoint, apiKey }` (new), or both. This is backwards compatible -- existing code passes `{ adapter }` and continues to work.

```ts
// Before (still works)
configure({ adapter: new SqliteAdapter({ dbPath: "station.db" }) });

// New: remote endpoint
configure({ endpoint: "https://station.example.com", apiKey: "sk_..." });

// Both: local adapter for in-process use + remote for triggers
// (unusual, but supported for migration scenarios)
configure({
  adapter: new SqliteAdapter({ dbPath: "station.db" }),
  endpoint: "https://station.example.com",
  apiKey: "sk_...",
});
```

### 5.2 `station-broadcast`

#### `broadcast.trigger()` mirrors the same pattern

The `BroadcastDefinition.trigger()` method (in `broadcast.ts`) currently calls `getBroadcastAdapter().addBroadcastRun()`. We apply the same split:

```ts
async trigger(input: unknown): Promise<string> {
  // Remote trigger path
  const triggerAdapter = getTriggerAdapterFromSignal();
  if (triggerAdapter?.triggerBroadcast) {
    return triggerAdapter.triggerBroadcast(name, input);
  }

  // Local trigger path (unchanged)
  const adapter = getBroadcastAdapter();
  const id = adapter.generateId();
  const run: BroadcastRun = { ... };
  await adapter.addBroadcastRun(run);
  return id;
}
```

The broadcast package imports `getTriggerAdapter` from `station-signal` (its peer dependency). No new configuration function needed -- `configure()` on `station-signal` is the single point of configuration for remote mode.

### 5.3 `station-kit`

Major changes to the Hono server to support authenticated API access.

(Details in Sections 6 and 7.)

---

## 6. Authentication System

### 6.1 Two authentication domains

| Domain | Who | Method | Purpose |
|--------|-----|--------|---------|
| Dashboard auth | Human users | Username/password + session cookie | Access the Next.js dashboard UI |
| API auth | Applications | API key in `Authorization: Bearer` header | Remote triggers, event subscriptions, programmatic access |

### 6.2 API Key Design

#### Key format

```
sk_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
└──┘└──┘└──────────────────────────────────┘
 prefix  env        32-char random hex
```

- Prefix `sk_` identifies it as a Station key.
- Environment segment: `live_` or `test_` (future: test mode that dry-runs signals).
- 32 random hex characters (128 bits of entropy).

#### Key storage

API keys are stored as SHA-256 hashes in the database. The plaintext key is shown exactly once at creation time. This means:
- Lost keys cannot be recovered, only rotated.
- Database breach does not expose valid keys.

#### Key metadata

```sql
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,          -- UUID
  name        TEXT NOT NULL,             -- Human-readable label ("Production App", "CI Pipeline")
  key_hash    TEXT NOT NULL UNIQUE,      -- SHA-256 of the full key
  key_prefix  TEXT NOT NULL,             -- First 8 chars for identification ("sk_live_a")
  scopes      TEXT NOT NULL DEFAULT '[]', -- JSON array: ["trigger", "read", "admin"]
  created_at  TEXT NOT NULL,
  last_used   TEXT,
  expires_at  TEXT,                      -- Optional expiry
  revoked     BOOLEAN NOT NULL DEFAULT 0
);
```

#### Scopes

| Scope | Allows |
|-------|--------|
| `trigger` | `POST /api/v1/trigger`, `POST /api/v1/trigger-broadcast` |
| `read` | `GET /api/v1/signals`, `GET /api/v1/runs/*`, `GET /api/v1/broadcasts/*`, `GET /api/v1/events` (SSE) |
| `cancel` | `POST /api/v1/runs/:id/cancel`, `POST /api/v1/broadcast-runs/:id/cancel` |
| `admin` | All of the above + `POST /api/v1/keys` (create/revoke keys) |

Default scope for newly created keys: `["trigger", "read"]`.

### 6.3 Dashboard Authentication

#### Credentials

Dashboard auth uses a single admin account defined in the Station config:

```ts
// station.config.ts
export default defineConfig({
  auth: {
    username: "admin",
    password: "change-me-in-production",
    // OR reference environment variables:
    // username: process.env.STATION_ADMIN_USER!,
    // password: process.env.STATION_ADMIN_PASSWORD!,
  },
});
```

When `auth` is not configured, the dashboard runs without authentication (for local development). When deployed remotely, auth should be required -- Station warns at startup if no auth is configured and the host is not `localhost` or `127.0.0.1`.

#### Session management

- Login: `POST /api/v1/auth/login` with `{ username, password }`. Returns a signed session token (JWT or HMAC-signed opaque token) as an HTTP-only cookie.
- The session token is validated on every dashboard request via Hono middleware.
- Sessions expire after a configurable duration (default: 24 hours).
- Logout: `POST /api/v1/auth/logout` clears the cookie.

#### Password hashing

Passwords are hashed with `scrypt` (Node.js built-in `crypto.scryptSync`). The config stores the plaintext password, but it's only compared via hash. No passwords are stored in the database -- the config file IS the source of truth for dashboard credentials.

### 6.4 Rate Limiting

Rate limiting protects the API from abuse and the dashboard from brute-force login attempts.

#### Strategy

Use a token bucket algorithm stored in memory (per-process). For multi-instance deployments, use Redis-backed rate limiting (future enhancement).

#### Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `POST /api/v1/auth/login` | 5 requests | per minute per IP |
| `POST /api/v1/trigger` | 100 requests | per minute per API key |
| `POST /api/v1/trigger-broadcast` | 50 requests | per minute per API key |
| `GET /api/v1/events` (SSE) | 5 connections | concurrent per API key |
| All other `GET` routes | 300 requests | per minute per API key |

Failed login attempts within the window trigger increasing delays (1s, 2s, 4s...) before responding, to slow brute-force attacks.

#### Implementation

Rate limiting is implemented as Hono middleware:

```ts
import { rateLimiter } from "./middleware/rate-limit.js";

// Apply to all v1 routes
app.use("/api/v1/*", rateLimiter({ windowMs: 60_000, max: 300 }));

// Override for specific routes
app.use("/api/v1/auth/login", rateLimiter({ windowMs: 60_000, max: 5, keyFn: (c) => c.req.header("x-forwarded-for") ?? "unknown" }));
app.use("/api/v1/trigger", rateLimiter({ windowMs: 60_000, max: 100, keyFn: (c) => c.get("apiKeyId") ?? "anonymous" }));
```

### 6.5 Middleware Stack

The Hono middleware chain for authenticated routes:

```
Request
  -> CORS
  -> Rate Limiter
  -> Auth Resolver (determines: cookie session OR API key OR anonymous)
  -> Scope Guard (checks required scopes for the route)
  -> Route Handler
```

The Auth Resolver middleware sets context variables:

```ts
c.set("authType", "api-key" | "session" | "none");
c.set("apiKeyId", "key_abc123");   // only for api-key auth
c.set("scopes", ["trigger", "read"]); // resolved scopes
```

---

## 7. Station API Changes

### 7.1 API Versioning

All new authenticated endpoints live under `/api/v1/`. The existing unversioned `/api/` routes continue to work for backwards compatibility (dashboard internal use) but are not publicly documented.

### 7.2 New Endpoints

#### `POST /api/v1/trigger`

Triggers a signal by name. This is the endpoint `HttpTriggerAdapter` calls.

```
POST /api/v1/trigger
Authorization: Bearer sk_live_...
Content-Type: application/json

{
  "signalName": "sendEmail",
  "input": { "to": "user@example.com", "subject": "Hello" }
}
```

Response (201):
```json
{
  "data": {
    "id": "run_abc123",
    "signalName": "sendEmail",
    "status": "pending",
    "createdAt": "2026-03-01T..."
  }
}
```

Error responses:
- `400` -- Invalid input (Zod validation failed on server)
- `401` -- Missing or invalid API key
- `403` -- API key does not have `trigger` scope
- `404` -- Signal name not registered on this Station
- `429` -- Rate limited

Required scope: `trigger`

#### `POST /api/v1/trigger-broadcast`

Triggers a broadcast by name.

```
POST /api/v1/trigger-broadcast
Authorization: Bearer sk_live_...
Content-Type: application/json

{
  "broadcastName": "orderPipeline",
  "input": { "orderId": "ORD-42", "amount": 99.99 }
}
```

Response (201):
```json
{
  "data": {
    "id": "brun_def456",
    "broadcastName": "orderPipeline",
    "status": "pending",
    "createdAt": "2026-03-01T..."
  }
}
```

Required scope: `trigger`

#### `GET /api/v1/signals`

List all registered signals with metadata.

Response:
```json
{
  "data": [
    {
      "name": "sendEmail",
      "inputSchema": { "type": "object", "properties": { "to": { "type": "string" }, ... } },
      "interval": null,
      "timeout": 300000,
      "maxAttempts": 1,
      "hasSteps": true,
      "stepNames": ["validate", "send"]
    }
  ]
}
```

Required scope: `read`

#### `GET /api/v1/signals/:name`

Single signal metadata.

Required scope: `read`

#### `GET /api/v1/runs`

List runs with optional filters.

Query parameters:
- `signalName` -- filter by signal name
- `status` -- filter by status (pending, running, completed, failed, cancelled)
- `limit` -- page size (default 50, max 200)
- `cursor` -- cursor-based pagination (run ID)

Required scope: `read`

#### `GET /api/v1/runs/:id`

Single run with full details.

Required scope: `read`

#### `GET /api/v1/runs/:id/steps`

Steps for a run.

Required scope: `read`

#### `GET /api/v1/runs/:id/logs`

Logs for a run.

Required scope: `read`

#### `POST /api/v1/runs/:id/cancel`

Cancel a running or pending run.

Required scope: `cancel`

#### `GET /api/v1/broadcasts`

List all registered broadcasts.

Required scope: `read`

#### `GET /api/v1/broadcasts/:name`

Single broadcast metadata (nodes, DAG structure, failure policy).

Required scope: `read`

#### `GET /api/v1/broadcast-runs/:id`

Single broadcast run.

Required scope: `read`

#### `GET /api/v1/broadcast-runs/:id/nodes`

Node runs for a broadcast run.

Required scope: `read`

#### `POST /api/v1/broadcast-runs/:id/cancel`

Cancel a broadcast run.

Required scope: `cancel`

#### `GET /api/v1/events`

Server-Sent Events stream for real-time updates. (See Section 9.)

Required scope: `read`

#### `POST /api/v1/keys`

Create a new API key. Returns the full key exactly once.

```
POST /api/v1/keys
Authorization: Bearer sk_live_... (must have admin scope)

{
  "name": "Production App",
  "scopes": ["trigger", "read"]
}
```

Response (201):
```json
{
  "data": {
    "id": "key_abc123",
    "name": "Production App",
    "key": "sk_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
    "keyPrefix": "sk_live_a",
    "scopes": ["trigger", "read"],
    "createdAt": "2026-03-01T..."
  }
}
```

The `key` field is only present in the creation response. It is never returned again.

Required scope: `admin`

#### `GET /api/v1/keys`

List API keys (without the full key, only prefix).

Required scope: `admin`

#### `DELETE /api/v1/keys/:id`

Revoke an API key.

Required scope: `admin`

#### `GET /api/v1/health`

Public health check (no auth required). Returns adapter connectivity status.

```json
{
  "data": {
    "ok": true,
    "signal": true,
    "broadcast": true,
    "version": "1.0.0"
  }
}
```

#### `POST /api/v1/auth/login`

Dashboard login.

```
POST /api/v1/auth/login
Content-Type: application/json

{ "username": "admin", "password": "..." }
```

Response: Sets `station_session` HTTP-only cookie.

#### `POST /api/v1/auth/logout`

Dashboard logout. Clears session cookie.

### 7.3 API route organization

```
packages/station-kit/src/server/
  routes/
    v1/
      trigger.ts           # POST /api/v1/trigger, POST /api/v1/trigger-broadcast
      signals.ts           # GET /api/v1/signals, GET /api/v1/signals/:name
      runs.ts              # GET /api/v1/runs, GET /api/v1/runs/:id, etc.
      broadcasts.ts        # GET /api/v1/broadcasts, etc.
      keys.ts              # POST /api/v1/keys, GET /api/v1/keys, DELETE /api/v1/keys/:id
      auth.ts              # POST /api/v1/auth/login, POST /api/v1/auth/logout
      events.ts            # GET /api/v1/events (SSE)
      health.ts            # GET /api/v1/health
    signals.ts             # Existing dashboard-internal routes (unchanged)
    runs.ts                # Existing dashboard-internal routes (unchanged)
    broadcasts.ts          # Existing dashboard-internal routes (unchanged)
    health.ts              # Existing health route (unchanged)
  middleware/
    auth.ts                # Auth resolver middleware
    rate-limit.ts          # Rate limiter middleware
    scope-guard.ts         # Scope checking middleware
  auth/
    keys.ts                # API key CRUD (hash, verify, create)
    session.ts             # Session management (sign, verify, cookie)
```

---

## 8. Database Adapter Packages

### 8.1 Adapter implementation pattern

All database adapters follow the same pattern established by `station-adapter-sqlite`:

1. Implement `SignalQueueAdapter` (and optionally `SerializableAdapter` for cross-process reconstruction).
2. Run idempotent schema creation in the constructor.
3. Export from `.` for signal adapter, `./broadcast` for broadcast adapter.
4. Register in the adapter factory via `registerAdapter(name, factory)`.

### 8.2 PostgreSQL adapter specifics

- Uses `postgres` (postgres.js) for zero-dependency ESM-native SQL.
- Connection pooling handled by the driver.
- Uses `NOTIFY`/`LISTEN` for optional reactive run polling (future enhancement; initial version polls like SQLite).
- `generateId()` uses `crypto.randomUUID()` (same as other adapters).
- `toManifest()` serializes the connection string (or individual host/port/user/database/password params).

```ts
import { PostgresAdapter } from "station-adapter-postgres";

const adapter = new PostgresAdapter({
  connectionString: process.env.DATABASE_URL,
});
```

### 8.3 MySQL adapter specifics

- Uses `mysql2/promise`.
- Connection pooling via `mysql2.createPool()`.
- MySQL-specific SQL syntax (backtick quoting, `DATETIME` instead of `TEXT` for dates, `BOOLEAN` via `TINYINT`).
- `ON DELETE CASCADE` for steps table.

```ts
import { MysqlAdapter } from "station-adapter-mysql";

const adapter = new MysqlAdapter({
  host: "localhost",
  user: "station",
  password: "...",
  database: "station",
});
```

### 8.4 Redis adapter specifics

- Uses `ioredis`.
- Lua scripts for atomic `getRunsDue` + `updateRun` operations to prevent double-dispatch.
- Run data stored as JSON in Redis hashes.
- TTL on completed runs for automatic cleanup.
- Not suitable for long-term run history -- pair with a durable adapter for `station-kit` dashboard queries.

```ts
import { RedisAdapter } from "station-adapter-redis";

const adapter = new RedisAdapter({
  url: "redis://localhost:6379",
  keyPrefix: "station:",  // optional namespace
  completedTtl: 86400,    // auto-expire completed runs after 24h
});
```

### 8.5 Shared utilities

Extract common utilities from `station-adapter-sqlite/src/shared.ts` into a new internal shared module, or document the pattern for third-party adapter authors. The key utilities:
- Column mapping (camelCase to snake_case)
- Date serialization/deserialization
- Table name validation

These are small enough that each adapter can copy the pattern. No need for a shared package.

### 8.6 API key storage

The `api_keys` table is created by the Station server (in station-kit), NOT by the adapters. It lives alongside the run/step tables in the same database. Station-kit manages key CRUD directly using the underlying adapter's database connection.

Approach: The adapter packages expose a method to get the underlying connection for advanced use by station-kit:

```ts
interface AdapterConnection {
  /** Return the underlying database client for advanced queries. */
  getConnection(): unknown;
}
```

Alternatively (and simpler): station-kit creates its own database connection for auth tables using the same connection config. This avoids adding a `getConnection()` method to the adapter interface. Station-kit already depends on `better-sqlite3` directly for its log store -- it would similarly depend on `pg` or `mysql2` when using those adapters.

Recommendation: Keep auth tables managed by station-kit using its own connection. The adapter interface stays clean.

---

## 9. Event Subscriptions

### 9.1 SSE over WebSocket

The existing dashboard uses WebSocket (`/api/events` via the `ws` package). For the public API, Server-Sent Events (SSE) is a better choice:

- SSE works through HTTP proxies and load balancers without special configuration.
- SSE auto-reconnects with `Last-Event-ID`.
- SSE is simpler for clients (no WebSocket library needed, works with `EventSource`).
- SSE is unidirectional (server to client), which matches the use case.

WebSocket remains for the dashboard (bidirectional communication is useful for interactive features). The v1 API adds an SSE endpoint.

### 9.2 `GET /api/v1/events` (SSE)

Query parameters:
- `signals` -- comma-separated signal names to filter (optional, defaults to all)
- `broadcasts` -- comma-separated broadcast names to filter (optional)
- `events` -- comma-separated event types to filter (optional, defaults to all)

Event types:
```
signal:discovered
run:dispatched
run:started
run:completed
run:failed
run:cancelled
run:timeout
run:retry
run:rescheduled
step:started
step:completed
step:failed
broadcast:queued
broadcast:started
broadcast:completed
broadcast:failed
broadcast:cancelled
node:triggered
node:completed
node:failed
node:skipped
log:output
```

Example SSE stream:
```
event: run:started
id: evt_001
data: {"run":{"id":"run_abc","signalName":"sendEmail","status":"running",...},"timestamp":"2026-03-01T..."}

event: run:completed
id: evt_002
data: {"run":{"id":"run_abc","signalName":"sendEmail","status":"completed",...},"output":"{\"messageId\":\"msg_xyz\"}","timestamp":"2026-03-01T..."}
```

### 9.3 Implementation

The SSE endpoint shares the same subscriber infrastructure as the WebSocket hub. A new `SSEHub` sits alongside `WebSocketHub`:

```ts
// server/sse.ts
export class SSEHub {
  private clients = new Set<SSEClient>();

  addClient(client: SSEClient): void { ... }
  removeClient(client: SSEClient): void { ... }
  broadcast(event: StationEvent): void {
    for (const client of this.clients) {
      if (client.matchesFilter(event)) {
        client.send(event);
      }
    }
  }
}
```

The `StationSignalSubscriber` and `StationBroadcastSubscriber` emit to both hubs.

### 9.4 Client-side subscription helper

For convenience, `station-signal` exports a helper to subscribe to events from the configured endpoint:

```ts
import { configure, subscribe } from "station-signal";

configure({ endpoint: "https://station.example.com", apiKey: "sk_..." });

const events = subscribe({
  signals: ["sendEmail"],
  events: ["run:completed", "run:failed"],
});

for await (const event of events) {
  console.log(event.type, event.data);
}
```

The `subscribe()` function returns an `AsyncIterable<StationEvent>`. It uses `EventSource` (in browsers) or a fetch-based SSE parser (in Node.js, since `EventSource` is not available in all Node versions).

Implementation: Use the `eventsource-parser` package (tiny, zero-dep) to parse the SSE stream from a `fetch()` response with `ReadableStream`.

This is a convenience -- users can also use any SSE client directly against `GET /api/v1/events`.

---

## 10. Developer Experience Walkthrough

### 10.1 Before (local-only)

**Signal definition** (`signals/send-email.ts`):
```ts
import { signal, z } from "station-signal";

export const sendEmail = signal("sendEmail")
  .input(z.object({ to: z.string(), subject: z.string() }))
  .run(async (input) => {
    await emailProvider.send(input.to, input.subject);
    return { sent: true };
  });
```

**Runner** (`runner.ts`):
```ts
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const runner = new SignalRunner({
  signalsDir: "./signals",
  adapter: new SqliteAdapter({ dbPath: "station.db" }),
  subscribers: [new ConsoleSubscriber()],
});
await runner.start();
```

**Trigger** (`app.ts`):
```ts
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";
import { sendEmail } from "./signals/send-email.js";

configure({ adapter: new SqliteAdapter({ dbPath: "station.db" }) });
await sendEmail.trigger({ to: "alice@example.com", subject: "Hello" });
```

### 10.2 After (remote Station)

**Signal definition** (`signals/send-email.ts`): **UNCHANGED**
```ts
import { signal, z } from "station-signal";

export const sendEmail = signal("sendEmail")
  .input(z.object({ to: z.string(), subject: z.string() }))
  .run(async (input) => {
    await emailProvider.send(input.to, input.subject);
    return { sent: true };
  });
```

**Station server** (`station.config.ts` on remote machine):
```ts
import { defineConfig } from "station-kit";
import { PostgresAdapter } from "station-adapter-postgres";
import { BroadcastPostgresAdapter } from "station-adapter-postgres/broadcast";

export default defineConfig({
  port: 4400,
  host: "0.0.0.0",
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new PostgresAdapter({ connectionString: process.env.DATABASE_URL }),
  broadcastAdapter: new BroadcastPostgresAdapter({ connectionString: process.env.DATABASE_URL }),
  auth: {
    username: process.env.STATION_ADMIN_USER!,
    password: process.env.STATION_ADMIN_PASSWORD!,
  },
});
```

**Trigger from user's app** (`app.ts` on any machine):
```ts
import { configure } from "station-signal";
import { sendEmail } from "./signals/send-email.js";

configure({
  endpoint: "https://station.example.com",
  apiKey: process.env.STATION_API_KEY,
});

await sendEmail.trigger({ to: "alice@example.com", subject: "Hello" });
```

**What changed in the app code**: One `configure()` call replaced the SQLite adapter with an endpoint + API key. The signal definition and trigger call are identical. The signal definition file is deployed to both the Station server (where it runs) and the client app (where it provides the typed trigger interface and Zod schema for client-side validation).

### 10.3 Even simpler: environment variables

For zero-code configuration, `station-signal` also reads from environment variables when no explicit `configure()` call has been made:

```bash
export STATION_ENDPOINT=https://station.example.com
export STATION_API_KEY=sk_live_...
```

The `getAdapter()` and `getTriggerAdapter()` functions check these env vars on first access:

```ts
function autoConfigureFromEnv(): void {
  if (_configured) return;
  const endpoint = process.env.STATION_ENDPOINT;
  const apiKey = process.env.STATION_API_KEY;
  if (endpoint) {
    configure({ endpoint, apiKey });
  }
}
```

This means the absolute minimum change for remote triggers is:

1. Set two environment variables.
2. There is no step 2.

The user's code -- signal definitions, trigger calls -- stays exactly the same.

### 10.4 Subscribing to events

```ts
import { configure, subscribe } from "station-signal";

configure({
  endpoint: "https://station.example.com",
  apiKey: process.env.STATION_API_KEY,
});

// Listen for all signal completions
const events = subscribe({ events: ["run:completed"] });
for await (const event of events) {
  console.log(`Signal ${event.data.run.signalName} completed`);
}
```

### 10.5 Managing API keys

Via the dashboard UI (when logged in as admin), or programmatically:

```bash
# Create a key via the API
curl -X POST https://station.example.com/api/v1/keys \
  -H "Authorization: Bearer sk_live_admin_key" \
  -H "Content-Type: application/json" \
  -d '{"name": "Production App", "scopes": ["trigger", "read"]}'
```

Or via a future CLI command:
```bash
station keys create --name "Production App" --scopes trigger,read
```

---

## 11. Migration Path

### Phase 1: No breaking changes

All changes are additive. Existing code continues to work without modification:

- `configure({ adapter })` still works (local mode).
- `configure()` not called? MemoryAdapter default, same as before.
- All existing `SignalQueueAdapter` implementations untouched.
- All existing runner code untouched.
- Dashboard works as before (no auth required by default).

### Phase 2: Opt-in remote

Users add `endpoint` and `apiKey` to their `configure()` call. Done. If they were already using `configure({ adapter })`, they switch to `configure({ endpoint, apiKey })`. If they were using env vars for adapter config, they switch the env vars.

### Phase 3: Opt-in auth

Users add `auth` to their `station.config.ts`. Dashboard requires login. API keys are created through the dashboard or API.

### No forced migration

There is never a point where local-only mode stops working. A developer can run Station in-process with SQLite forever. The remote architecture is a progressive enhancement, not a replacement.

---

## 12. Implementation Phases

### Phase 1: Foundation (station-signal changes)

1. Add `TriggerAdapter` interface to `station-signal`.
2. Add `HttpTriggerAdapter` implementation to `station-signal`.
3. Expand `configure()` to accept `{ endpoint, apiKey }`.
4. Add `StationRemoteError` to error classes.
5. Modify `signal.trigger()` to check `getTriggerAdapter()` first.
6. Add env var auto-configuration (`STATION_ENDPOINT`, `STATION_API_KEY`).
7. Update `station-broadcast`'s `trigger()` to mirror the same pattern.
8. Update barrel exports.

Estimated scope: ~200 lines of new code in `station-signal`, ~30 lines in `station-broadcast`.

### Phase 2: Station API v1 (station-kit changes)

1. Add `/api/v1/trigger` endpoint.
2. Add `/api/v1/trigger-broadcast` endpoint.
3. Add `/api/v1/health` (public, no auth).
4. Add read-only endpoints (`/api/v1/signals`, `/api/v1/runs`, `/api/v1/broadcasts`).
5. Add cancel endpoints.
6. Add SSE endpoint (`/api/v1/events`).
7. Add `SSEHub` alongside `WebSocketHub`.

Estimated scope: ~400 lines in station-kit.

### Phase 3: Authentication

1. Add API key management (create, list, revoke, verify).
2. Add auth middleware (API key resolver, scope guard).
3. Add dashboard auth (login, logout, session middleware).
4. Add rate limiting middleware.
5. Add `auth` config to `StationConfig` / `StationUserConfig`.
6. Add API key management UI to the dashboard.
7. Add login page to the dashboard.

Estimated scope: ~600 lines in station-kit.

### Phase 4: Database adapters

1. `station-adapter-postgres` -- Signal + Broadcast adapters.
2. `station-adapter-mysql` -- Signal + Broadcast adapters.
3. `station-adapter-redis` -- Signal + Broadcast adapters.

Each adapter is ~300-400 lines (mirroring the SQLite adapter structure). These are independent and can be built in parallel.

### Phase 5: Client event subscriptions

1. Add `subscribe()` to `station-signal` exports.
2. Implement SSE parser (or use `eventsource-parser`).
3. Return `AsyncIterable<StationEvent>`.

Estimated scope: ~100 lines.

### Phase 6: Polish

1. CLI commands for key management (`station keys create`, `station keys list`, `station keys revoke`).
2. Dashboard API key management page.
3. Dashboard login page.
4. Documentation.
5. Migration guide.

---

## 13. Open Questions

### Q1: Should signal definitions be deployed to both client and server?

**Current assumption: Yes.** The client needs the signal definition to:
- Get type safety on `.trigger()` input.
- Run client-side Zod validation (fail fast, no network call for bad input).
- Access the signal name for the HTTP request.

The server needs the signal definition to:
- Execute the handler.
- Validate input server-side.

This means the signal definition files are shared code. They could live in a shared package (`@myapp/signals`) imported by both the client app and the Station server.

Alternative: A "stub" mode where the client only needs the signal name and input schema, without the handler. This could be generated from the server's metadata endpoint. But this breaks the "zero code change" requirement -- the developer would need different import paths.

**Recommendation**: Keep sharing the signal file. The handler function ships to the client but is never called there -- it's dead code on the client side. Tree-shaking may eliminate it. If the handler has heavy dependencies, the developer can split definition from handler:

```ts
// signals/send-email.ts (shared)
export const sendEmail = signal("sendEmail")
  .input(z.object({ to: z.string(), subject: z.string() }));

// signals/send-email.handler.ts (server only)
export const sendEmailWithHandler = sendEmail
  .run(async (input) => { ... });
```

### Q2: Should `configure()` be per-signal or global?

**Global.** A single `configure()` call sets the mode for all signals in the process. Per-signal configuration adds complexity with minimal benefit. If a user needs some signals local and some remote, they're running a hybrid setup and should use two processes.

### Q3: WebSocket vs SSE for the public API?

**SSE for the public v1 API.** WebSocket for the dashboard (internal). Reasoning:
- SSE is simpler for consumers.
- SSE works through more infrastructure (proxies, CDNs, load balancers).
- The event stream is unidirectional, which is exactly what SSE is designed for.
- WebSocket adds bidirectional capability the public API doesn't need.

### Q4: Should API keys be stored in the same database as runs?

**Yes, for simplicity.** The Station server already has a database connection (via the adapter). Storing keys in the same database avoids requiring a separate auth database. The `api_keys` table is managed by station-kit, not by the adapter.

For users who want external auth (OIDC, OAuth), we can add adapter middleware in a future version. The initial implementation is self-contained.

### Q5: How does the server know which signals are registered for remote trigger validation?

The server runs `SignalRunner` with `signalsDir`, which discovers signals at startup. When a remote trigger arrives, the server checks `signalRunner.hasSignal(name)`. If the signal exists, the trigger is accepted. If not, 404.

This means the server must have the signal files deployed and discovered. This is already the case -- the Station server is where signals run.

### Q6: What about broadcast remote triggers?

Same pattern. `BroadcastRunner.trigger(name, input)` is called by the server-side `POST /api/v1/trigger-broadcast` handler. The `broadcastRunner.hasBroadcast(name)` check validates the broadcast exists.

On the client side, `broadcastDefinition.trigger(input)` checks for a `TriggerAdapter` and calls `triggerAdapter.triggerBroadcast(name, input)`.

---

## Appendix A: File Changes Summary

### New files

| File | Package | Purpose |
|------|---------|---------|
| `src/adapters/trigger.ts` | station-signal | `TriggerAdapter` interface |
| `src/adapters/http-trigger.ts` | station-signal | `HttpTriggerAdapter` implementation |
| `src/subscribe.ts` | station-signal | `subscribe()` SSE helper |
| `src/server/routes/v1/trigger.ts` | station-kit | v1 trigger endpoints |
| `src/server/routes/v1/signals.ts` | station-kit | v1 signal read endpoints |
| `src/server/routes/v1/runs.ts` | station-kit | v1 run read/cancel endpoints |
| `src/server/routes/v1/broadcasts.ts` | station-kit | v1 broadcast endpoints |
| `src/server/routes/v1/keys.ts` | station-kit | API key CRUD endpoints |
| `src/server/routes/v1/auth.ts` | station-kit | Login/logout endpoints |
| `src/server/routes/v1/events.ts` | station-kit | SSE event stream |
| `src/server/routes/v1/health.ts` | station-kit | Public health check |
| `src/server/middleware/auth.ts` | station-kit | Auth resolver middleware |
| `src/server/middleware/rate-limit.ts` | station-kit | Rate limiter |
| `src/server/middleware/scope-guard.ts` | station-kit | Scope checker |
| `src/server/auth/keys.ts` | station-kit | API key hash/verify/CRUD |
| `src/server/auth/session.ts` | station-kit | Session management |
| `src/server/sse.ts` | station-kit | SSE hub |
| `packages/station-adapter-postgres/` | new package | PostgreSQL adapter |
| `packages/station-adapter-mysql/` | new package | MySQL adapter |
| `packages/station-adapter-redis/` | new package | Redis adapter |

### Modified files

| File | Package | Change |
|------|---------|--------|
| `src/config.ts` | station-signal | Add `endpoint`, `apiKey`, `triggerAdapter` to `configure()` |
| `src/signal.ts` | station-signal | `trigger()` checks `getTriggerAdapter()` first |
| `src/errors.ts` | station-signal | Add `StationRemoteError` |
| `src/index.ts` | station-signal | Export new types and classes |
| `src/broadcast.ts` | station-broadcast | `trigger()` checks trigger adapter |
| `src/server/index.ts` | station-kit | Mount v1 routes, middleware stack |
| `src/config/schema.ts` | station-kit | Add `auth` to config |
| `src/index.ts` | station-kit | Export auth-related config types |

### Unchanged files

All runner internals (`signal-runner.ts`, `broadcast-runner.ts`, `bootstrap.ts`), all existing adapter implementations, all subscribers, all dashboard React components (except adding login/key-management pages).

---

## Appendix B: Interface Reference

### TriggerAdapter (new)

```ts
interface TriggerAdapter {
  trigger(signalName: string, input: unknown): Promise<string>;
  triggerBroadcast?(broadcastName: string, input: unknown): Promise<string>;
  ping?(): Promise<boolean>;
}
```

### ConfigureOptions (expanded)

```ts
interface ConfigureOptions {
  adapter?: SignalQueueAdapter;       // existing
  endpoint?: string;                  // new
  apiKey?: string;                    // new
  triggerAdapter?: TriggerAdapter;    // new (advanced)
}
```

### StationConfig (expanded)

```ts
interface StationConfig {
  // ... existing fields ...
  auth?: {
    username: string;
    password: string;
    sessionTtlMs?: number;   // default 86_400_000 (24h)
  };
}
```

### API Key table

```sql
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,
  scopes      TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  last_used   TEXT,
  expires_at  TEXT,
  revoked     BOOLEAN NOT NULL DEFAULT 0
);
```
