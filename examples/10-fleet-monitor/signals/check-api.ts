import { signal, z } from "simple-signal";

export const checkApi = signal("check-api")
  .output(z.object({ service: z.string(), healthy: z.boolean(), latencyMs: z.number(), checkedAt: z.string() }))
  .every("5s")
  .run(async () => {
    const latencyMs = 20 + Math.floor(Math.random() * 80);
    await new Promise((r) => setTimeout(r, latencyMs));

    if (Math.random() < 0.1) {
      throw new Error(`API responded with 503 (latency: ${latencyMs}ms)`);
    }

    console.log(`[check-api] OK ${latencyMs}ms`);
    return { service: "api-gateway", healthy: true, latencyMs, checkedAt: new Date().toISOString() };
  });
