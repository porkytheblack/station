import { signal } from "simple-signal";

export const heartbeat = signal("heartbeat")
  .every("5s")
  .run(async () => {
    console.log(`[heartbeat] ping at ${new Date().toISOString()}`);
  });
