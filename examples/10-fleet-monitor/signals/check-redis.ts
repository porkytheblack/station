import { signal, z } from "simple-signal";

export const checkRedis = signal("check-redis")
  .output(z.object({ service: z.string(), healthy: z.boolean(), latencyMs: z.number(), memoryMb: z.number(), checkedAt: z.string() }))
  .every("6s")
  .run(async () => {
    const latencyMs = 1 + Math.floor(Math.random() * 10);
    const memoryMb = 128 + Math.floor(Math.random() * 256);
    await new Promise((r) => setTimeout(r, latencyMs));

    if (Math.random() < 0.15) {
      throw new Error(`Redis PING timeout after ${latencyMs}ms (memory: ${memoryMb}MB)`);
    }

    console.log(`[check-redis] OK ${latencyMs}ms, ${memoryMb}MB`);
    return { service: "redis-cache", healthy: true, latencyMs, memoryMb, checkedAt: new Date().toISOString() };
  });
