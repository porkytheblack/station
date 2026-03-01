import { signal, z } from "station-signal";

export const checkMemory = signal("check-memory")
  .output(z.object({ service: z.string(), healthy: z.boolean(), usedMb: z.number(), totalMb: z.number(), checkedAt: z.string() }))
  .every("7s")
  .run(async () => {
    const totalMb = 8192;
    const usedMb = 3000 + Math.floor(Math.random() * 4000);
    const percent = Math.round((usedMb / totalMb) * 100);
    await new Promise((r) => setTimeout(r, 20));

    if (Math.random() < 0.02) {
      throw new Error(`Memory pressure: ${usedMb}MB / ${totalMb}MB (${percent}%)`);
    }

    console.log(`[check-memory] OK ${usedMb}MB / ${totalMb}MB (${percent}%)`);
    return { service: "host-memory", healthy: true, usedMb, totalMb, checkedAt: new Date().toISOString() };
  });
