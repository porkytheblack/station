import { Hono } from "hono";
import type { SignalRunner } from "station-signal";
import type { StationSignalSubscriber } from "../../subscriber.js";

export interface V1SignalDeps {
  signalRunner?: SignalRunner;
  signalSubscriber?: StationSignalSubscriber;
}

export function v1SignalRoutes(deps: V1SignalDeps) {
  const app = new Hono();

  app.get("/signals", async (c) => {
    if (deps.signalSubscriber) {
      const meta = deps.signalSubscriber.getAllSignalMeta();
      if (meta.length > 0) return c.json({ data: meta });
    }

    if (!deps.signalRunner) return c.json({ data: [] });

    const result = deps.signalRunner
      .listRegistered()
      .map(({ name, filePath }) => ({ name, filePath }));
    return c.json({ data: result });
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

    return c.json({ error: "not_found", message: `Signal "${name}" not found.` }, 404);
  });

  return app;
}
