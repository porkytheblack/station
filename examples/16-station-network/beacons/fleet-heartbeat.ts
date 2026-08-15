import { beacon } from "station-beacon";

export const fleetHeartbeat = beacon("fleet-heartbeat")
  .manualStart()
  .placement({ labels: { region: "ke" } })
  .poll("30s", async (ctx) => {
    ctx.log(`Fleet heartbeat from ${process.env.STATION_ID ?? "station"}`);
  });
