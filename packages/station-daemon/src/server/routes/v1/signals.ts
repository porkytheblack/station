import { Hono } from "hono";
import type { SignalRunner } from "station-signal";
import type { StationSignalSubscriber } from "../../subscriber.js";
import type { StationNetworkAdapter } from "station-network";

export interface V1SignalDeps {
  signalRunner?: SignalRunner;
  signalSubscriber?: StationSignalSubscriber;
  networkAdapter?: StationNetworkAdapter;
  networkId?: string;
}

export function v1SignalRoutes(deps: V1SignalDeps) {
  const app = new Hono();

  app.get("/signals", async (c) => {
    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getAllSignalMeta();
      if (meta.length > 0) return c.json({ data: meta });
    }

    const local = deps.signalRunner
      ?.listRegistered()
      .map(({ name, filePath }) => ({ name, filePath })) ?? [];
    if (local.length > 0) return c.json({ data: local });

    if (deps.networkAdapter && deps.networkId) {
      await deps.networkAdapter.markOfflineBefore(new Date(), deps.networkId);
      const stations = await deps.networkAdapter.listStations({ networkId: deps.networkId, status: "online" });
      const names = Array.from(new Set(stations.flatMap((station) => station.definitions.signals))).sort();
      return c.json({ data: names.map((name) => ({ name, stations: stations.filter((s) => s.definitions.signals.includes(name)).map((s) => s.id) })) });
    }
    return c.json({ data: [] });
  });

  app.get("/signals/:name", async (c) => {
    const name = c.req.param("name");

    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getSignalMeta(name);
      if (meta) return c.json({ data: meta });
    }

    if (deps.signalRunner) {
      const entry = deps.signalRunner.listRegistered().find((s) => s.name === name);
      if (entry) return c.json({ data: { name, filePath: entry.filePath } });
    }
    if (deps.networkAdapter && deps.networkId) {
      await deps.networkAdapter.markOfflineBefore(new Date(), deps.networkId);
      const stations = await deps.networkAdapter.listStations({ networkId: deps.networkId, status: "online" });
      const available = stations.filter((station) => station.definitions.signals.includes(name));
      if (available.length) return c.json({ data: { name, stations: available.map((s) => s.id) } });
    }

    return c.json({ error: "not_found", message: `Signal "${name}" not found.` }, 404);
  });

  return app;
}
