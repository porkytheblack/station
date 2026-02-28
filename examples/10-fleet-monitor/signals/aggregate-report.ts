import { signal, z } from "simple-signal";

export const aggregateReport = signal("aggregate-report")
  .output(z.object({ totalChecks: z.number(), healthy: z.number(), failed: z.number(), reportedAt: z.string() }))
  .run(async () => {
    // In a real system this would aggregate upstream results.
    // The broadcast runner makes upstream outputs available via the `map` option.
    const totalChecks = 6;
    const reportedAt = new Date().toISOString();
    console.log(`[aggregate] Full health check complete. ${totalChecks} services checked at ${reportedAt}.`);
    return { totalChecks, healthy: totalChecks, failed: 0, reportedAt };
  });
