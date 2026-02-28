import { signal, z } from "simple-signal";

export const checkDisk = signal("check-disk")
  .output(z.object({ service: z.string(), healthy: z.boolean(), usedPercent: z.number(), availableGb: z.number(), checkedAt: z.string() }))
  .every("12s")
  .run(async () => {
    const usedPercent = 40 + Math.floor(Math.random() * 50);
    const availableGb = Math.round((100 - usedPercent) * 5) / 10;
    await new Promise((r) => setTimeout(r, 30));

    if (usedPercent > 85) {
      throw new Error(`Disk usage critical: ${usedPercent}% (${availableGb}GB free)`);
    }

    console.log(`[check-disk] OK ${usedPercent}% used, ${availableGb}GB free`);
    return { service: "disk-vol-0", healthy: true, usedPercent, availableGb, checkedAt: new Date().toISOString() };
  });
