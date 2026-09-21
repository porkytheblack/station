# station-dashboard

The standalone Station 3 web client. It contains the packaged Next.js application and a small fixed-target API/event proxy. It does not embed the Station daemon, start runners or own execution workers.

## Run

```sh
pnpm add station-dashboard
STATION_DAEMON_URL=http://127.0.0.1:4400 PORT=4401 HOSTNAME=127.0.0.1 pnpm exec station-dashboard
```

The daemon must already be running. Open `http://127.0.0.1:4401` and log in with its credentials. For an existing remote Headquarters, configure `STATION_DAEMON_URL=https://hq.example.com` instead. The target must be an HTTP(S) origin without URL credentials, a path, query or fragment. HTTPS is required for every nonloopback target, including private network addresses; HTTP is allowed only for `localhost`, `127.0.0.1` and `[::1]`.

| Environment | Default | Meaning |
| --- | --- | --- |
| `STATION_DAEMON_URL` | `http://127.0.0.1:4400` | Fixed trusted daemon/Headquarters origin |
| `PORT` | `4401` | Public dashboard listener port |
| `HOSTNAME` | `127.0.0.1` | Dashboard bind address |

The renderer runs on a separately allocated loopback port; the public listener sends `/api/*` and the event WebSocket to the selected daemon. API requests retain the user's authentication. The target never comes from a browser request, and browser cross-origin API mutations/event connections are rejected. For a shared hosted deployment, configure TLS and access control deliberately; this package does not provision them.

CLI startup is optional:

```sh
station dashboard start --context production --port 4401
station dashboard status
station dashboard stop
```

This requires separately installed `station-runtime-cli` and a saved context. The CLI checks the selected daemon and pins the dashboard target; it does not embed the saved API key into frontend assets. Browser login is independent. Changing the active CLI context does not retarget an already running dashboard.

Stopping the dashboard closes its renderer/proxy and leaves the daemon and workloads running. A daemon outage leaves the separately running UI able to report unavailable API requests. The dashboard remains bound to its configured daemon; private registry selection uses that daemon’s operator-configured forwarding targets, not arbitrary browser-supplied URLs.

## Build and packaging

`pnpm build` builds Next's standalone output, copies static assets and removes publisher-machine native bundles that are not needed. The supported launch entrypoint is `station-dashboard` (also exported as `station-dashboard/cli`); consumers should not depend on internal `.next` paths.

Isolated packed-install validation has exercised the standalone server/static assets, authenticated API proxying and independent shutdown. See [Station 3](../../docs/STATION-3.md) for the package split and release gates.

## Registry and deployments

The Registry section separates image names, immutable versions and export invocation into nested pages. Publishing checks all selected artifact digests and sizes before uploading; install, tags and invocation have separate views. Every screen identifies the dashboard’s fixed daemon context. The Registry Station selector chooses the connected daemon or a private Station configured in Headquarters `registry.targets`. Selection persists in registry links and breadcrumbs. Publication, installation, tags and deployments use that selected registry. Invoking an image in a private registry routes through Headquarters to that worker and pins execution there; the connected daemon registry retains a separate execution-placement selector. Registry operations require operator admin authorization.

Publication uses checksum-verified chunks, accepted-byte progress, Pause and Resume, and tab-scoped receipts keyed by the daemon, private Station and artifact digest. Resume reads the server offset before sending another chunk; reselect files after reloading the tab. Expired uploads restart. Commits clean staged upload quota, and uncertain manifest publication requires checking the registry before retrying. No mutation is automatically retried.

Deployment pages support staged generations, alias inspection, environment bindings, activation, rollback, drain, invocation and history. The bindings editor accepts environment-store key references for credentials and literals only after explicit non-secret confirmation. Generation details show reference names and literal presence; the dashboard does not fetch resolved secret values. Changes carry the displayed revision and reject concurrent modifications; refresh to review before retrying. Existing runs and beacon instances retain their original generation.

From the source checkout, build the dashboard and run `pnpm --filter station-dashboard test:registry:browser` with the repository’s browser dependencies installed. This launches real Chromium against a deterministic local HTTP API fixture and covers nested navigation, invalid/valid publication, installation, private registry routing, worker pins, interrupted chunk resumption, reference/non-secret bindings, revision conflicts, activation, rollback and drain. It does not replace the daemon’s real image-execution integration tests.
