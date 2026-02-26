import { signal, z } from "simple-signal";

export const heartbeat = signal("heartbeat")
  .input(z.object({}))
  .every("every 5s")
  .run(async () => {
    console.log(`[heartbeat] ${new Date().toISOString()}`);
  });
