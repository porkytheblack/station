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

Stopping the dashboard closes its renderer/proxy and leaves the daemon and workloads running. A daemon outage leaves the separately running UI able to report unavailable API requests. The current dashboard is not a general multi-context connection manager and does not implement the planned image registry/deployment pages.

## Build and packaging

`pnpm build` builds Next's standalone output, copies static assets and removes publisher-machine native bundles that are not needed. The supported launch entrypoint is `station-dashboard` (also exported as `station-dashboard/cli`); consumers should not depend on internal `.next` paths.

Isolated packed-install validation has exercised the standalone server/static assets, authenticated API proxying and independent shutdown. See [Station 3](../../docs/STATION-3.md) for the package split and release gates.
