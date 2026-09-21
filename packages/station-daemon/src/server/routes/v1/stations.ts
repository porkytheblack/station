import { Hono } from "hono";
import type { StationNetworkAdapter, StationNode, StationRole, StationStatus } from "station-network";

export interface V1StationDeps {
  adapter: StationNetworkAdapter;
  networkId: string;
}

const ROLES: StationRole[] = ["headquarters", "station", "standalone"];
const STATUSES: StationStatus[] = ["online", "draining", "offline"];
const WRITABLE_STATUSES: StationStatus[] = ["online", "draining"];

export function v1StationReadRoutes(deps: V1StationDeps) {
  const app = new Hono();

  app.get("/stations", async (c) => {
    await deps.adapter.markOfflineBefore(new Date(), deps.networkId);
    const role = c.req.query("role") as StationRole | undefined;
    const status = c.req.query("status") as StationStatus | undefined;
    if (role && !ROLES.includes(role)) return c.json({ error: "bad_request", message: "Invalid role." }, 400);
    if (status && !STATUSES.includes(status)) return c.json({ error: "bad_request", message: "Invalid status." }, 400);
    const stations = await deps.adapter.listStations({ networkId: deps.networkId, role, status });
    return c.json({ data: stations.map(serializeStation) });
  });

  app.get("/stations/:id", async (c) => {
    await deps.adapter.markOfflineBefore(new Date(), deps.networkId);
    const station = await deps.adapter.getStation(c.req.param("id"));
    if (!station || station.networkId !== deps.networkId) return c.json({ error: "not_found" }, 404);
    return c.json({ data: serializeStation(station) });
  });

  return app;
}

export function v1StationAdminRoutes(deps: V1StationDeps) {
  const app = new Hono();

  app.patch("/stations/:id", async (c) => {
    const station = await deps.adapter.getStation(c.req.param("id"));
    if (!station || station.networkId !== deps.networkId) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => ({})) as { status?: StationStatus };
    if (!body.status || !WRITABLE_STATUSES.includes(body.status)) {
      return c.json({ error: "bad_request", message: `status must be one of ${WRITABLE_STATUSES.join(", ")}` }, 400);
    }
    await deps.adapter.upsertStation({ ...station, status: body.status });
    return c.json({ data: serializeStation({ ...station, status: body.status }) });
  });

  return app;
}

function serializeStation(station: StationNode) {
  return {
    ...station,
    startedAt: station.startedAt.toISOString(),
    lastHeartbeatAt: station.lastHeartbeatAt.toISOString(),
    leaseExpiresAt: station.leaseExpiresAt.toISOString(),
  };
}
